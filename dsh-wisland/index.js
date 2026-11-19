/**
 * dsh-wisland — host half.
 *
 * Watches live agents and mirrors the most urgent session state into a JSON
 * status file that the wisland desktop island reads every 1.5s:
 *   %USERPROFILE%\.dsh\desktop-capsule\status.json
 *
 * No child process, no rendering — this plugin only produces the status file.
 */
import { mkdirSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HEARTBEAT_MS = 2000
const MAX_SESSIONS = 6

function statusDirectory() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'desktop-capsule')
}

export function apply(ctx) {
  const dir = statusDirectory()
  const statusPath = join(dir, 'status.json')
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const log = (msg) => {
    try { appendFileSync(join(dir, 'dsh-wisland.log'), `[${new Date().toISOString()}] ${msg}\n`) } catch {}
  }
  log('apply started')

  const sessions = new Map()
  const disposers = []
  const agentDisposers = new Map()
  let heartbeat = null

  const isHumanSession = (session) => {
    if (session === undefined || session === null) return false
    const header = session.header
    return header === undefined || header === null || header.origin !== 'subagent'
  }

  const entryOf = (sessionId) => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = {
        sessionId,
        state: 'idle',
        since: Date.now(),
        turn: 0,
        detail: '',
        error: '',
        durationMs: 0,
        busySince: 0,
        doneAt: 0,
      }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  const entryForAgent = (agent) => {
    if (agent === undefined || agent === null) return null
    const session = agent.session
    if (!isHumanSession(session)) return null
    return entryOf(session.id)
  }

  const reconcile = () => {
    let registry = null
    try { registry = ctx.get('agents') } catch { return }
    if (registry === null || registry === undefined || typeof registry.list !== 'function') return
    let agents
    try { agents = registry.list() } catch { return }
    for (const agent of agents) {
      if (!isHumanSession(agent.session)) continue
      const existing = sessions.get(agent.session.id)
      const now = Date.now()
      if (agent.status === 'running') {
        const entry = existing ?? entryOf(agent.session.id)
        if (entry.state === 'idle' || entry.state === 'done' || entry.state === 'error') {
          entry.state = 'running'
          entry.since = now
          entry.busySince = entry.busySince > 0 ? entry.busySince : now
          entry.error = ''
          entry.doneAt = 0
        }
      } else if (existing !== undefined && existing.state === 'running') {
        existing.state = 'done'
        existing.doneAt = now
        existing.durationMs = existing.busySince > 0 ? now - existing.busySince : 0
        existing.since = now
        existing.busySince = 0
      }
    }
  }

  const flush = () => {
    reconcile()
    const ordered = [...sessions.values()]
      .sort((left, right) => right.since - left.since)
      .slice(0, MAX_SESSIONS)
    const payload = {
      v: 1,
      updatedAt: Date.now(),
      pid: process.pid,
      sessions: ordered.map(entry => ({
        sessionId: entry.sessionId,
        state: entry.state,
        since: entry.since,
        turn: entry.turn,
        detail: entry.detail,
        error: entry.error,
        durationMs: entry.durationMs,
        doneAt: entry.doneAt,
      })),
    }
    try {
      const temporary = `${statusPath}.tmp`
      writeFileSync(temporary, JSON.stringify(payload), 'utf8')
      renameSync(temporary, statusPath)
    } catch {}
  }

  const listen = (event, handler, options) => {
    const registration = options ?? { global: true }
    try {
      const dispose = ctx.on(event, handler, registration)
      if (typeof dispose === 'function') disposers.push(dispose)
      log(`listen OK: ${event}`)
    } catch (err) {
      try {
        const dispose = ctx.on(event, handler)
        if (typeof dispose === 'function') disposers.push(dispose)
        log(`listen OK (fallback): ${event}`)
      } catch (err2) {
        log(`listen FAILED: ${event} err=${String(err)} err2=${String(err2)}`)
      }
    }
  }

  listen('agent/created', ({ agent }) => {
    const entry = entryForAgent(agent)
    if (entry !== null) {
      entry.state = 'idle'
      entry.since = Date.now()
      flush()
    }
    // 在 agent 作用域上注册 scoped waterfall 监听（全局监听收不到 scopeTarget 事件）
    const agentCtx = agent.ctx
    if (agentCtx !== undefined && agentCtx !== null) {
      const d = []
      try {
        d.push(agentCtx.on('approval/request', async (request, next) => {
          log('[agentCtx] approval/request fired')
          const e = beginWait(request?.agent, 'approval', String(request?.toolName ?? '操作'))
          try { return await next() } finally { endWait(e) }
        }))
      } catch (err) { log(`agentCtx approval listen failed: ${String(err)}`) }
      try {
        d.push(agentCtx.on('user-questions/request', async (request, next) => {
          log('[agentCtx] user-questions/request fired')
          const q = Array.isArray(request?.questions) ? request.questions.length : 1
          const e = beginWait(request?.agent, 'question', q > 1 ? `${q} 个问题` : '一个问题')
          try { return await next() } finally { endWait(e) }
        }))
      } catch (err) { log(`agentCtx user-questions listen failed: ${String(err)}`) }
      agentDisposers.set(agent, d)
    }
  })

  listen('agent/status', ({ agent, status }) => {
    const entry = entryForAgent(agent)
    if (entry === null) return
    const now = Date.now()
    if (status === 'running') {
      entry.state = 'running'
      entry.since = now
      entry.busySince = now
      entry.detail = ''
      entry.error = ''
      entry.doneAt = 0
    } else if (entry.state === 'running' || entry.state === 'approval' || entry.state === 'question') {
      entry.state = 'done'
      entry.doneAt = now
      entry.durationMs = entry.busySince > 0 ? now - entry.busySince : 0
      entry.since = now
      entry.busySince = 0
    }
    flush()
  })

  listen('agent/error', ({ agent, error }) => {
    const entry = entryForAgent(agent)
    if (entry === null) return
    const text = error instanceof Error ? error.message : String(error ?? 'unknown error')
    entry.state = 'error'
    entry.since = Date.now()
    entry.error = text.slice(0, 160)
    entry.busySince = 0
    flush()
  })

  listen('agent/disposed', ({ agent }) => {
    const entry = entryForAgent(agent)
    if (entry !== null) {
      sessions.delete(entry.sessionId)
      flush()
    }
    const d = agentDisposers.get(agent)
    if (d) { for (const x of d) { try { x() } catch {} } agentDisposers.delete(agent) }
  })

  listen('session/event', (session, event) => {
    if (!isHumanSession(session) || event === undefined || event === null) return
    const entry = entryOf(session.id)
    const now = Date.now()
    if (event.type === 'turn/start') {
      entry.turn = Number(event.data?.turn ?? entry.turn ?? 0)
      if (entry.busySince === 0) entry.busySince = now
      if (entry.state !== 'approval' && entry.state !== 'question') {
        entry.state = 'running'
        entry.since = now
        entry.error = ''
        entry.doneAt = 0
      }
      flush()
    } else if (event.type === 'turn/end') {
      if (entry.state !== 'error') {
        entry.state = 'done'
        entry.doneAt = now
        entry.durationMs = entry.busySince > 0 ? now - entry.busySince : 0
        entry.since = now
        entry.busySince = 0
      }
      flush()
    }
  })

  const beginWait = (agent, state, detail) => {
    const entry = entryForAgent(agent)
    if (entry === null) return null
    entry.state = state
    entry.since = Date.now()
    entry.detail = detail
    flush()
    return entry
  }

  const endWait = (entry) => {
    if (entry === null || entry === undefined) return
    if (entry.state === 'approval' || entry.state === 'question') {
      entry.state = 'running'
      entry.since = Date.now()
      entry.detail = ''
    }
    flush()
  }

  listen('approval/request', async (request, next) => {
    log(`approval/request fired: tool=${request?.toolName} agent=${request?.agent ? 'yes' : 'no'}`)
    const entry = beginWait(request?.agent, 'approval', String(request?.toolName ?? '操作'))
    try { return await next() } finally { endWait(entry) }
  })

  listen('user-questions/request', async (request, next) => {
    const questions = Array.isArray(request?.questions) ? request.questions.length : 1
    log(`user-questions/request fired: q=${questions} agent=${request?.agent ? 'yes' : 'no'}`)
    const entry = beginWait(request?.agent, 'question', questions > 1 ? `${questions} 个问题` : '一个问题')
    try { return await next() } finally { endWait(entry) }
  })

  ctx.effect(() => {
    return () => {
      if (heartbeat !== null) clearInterval(heartbeat)
      for (const dispose of disposers) { try { dispose() } catch {} }
    }
  })

  flush()
  heartbeat = setInterval(flush, HEARTBEAT_MS)
}
