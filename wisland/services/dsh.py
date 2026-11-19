# -*- coding: utf-8 -*-
"""DSH 状态：轮询 DeepSeek Harness 宿主插件写的 status.json，映射成灵动岛小形象的眼睛颜色。

DSH 宿主插件（dsh-wisland）把当前最紧急的会话状态写进
%USERPROFILE%\\.dsh\\desktop-capsule\\status.json，本服务每 1.5 秒读一次，
状态变化时发 state_changed 信号，由 app.py 传给小形象做眼睛颜色（常驻）。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from PySide6 import QtCore

STATUS_PATH = Path(os.path.expandvars(r"%USERPROFILE%\.dsh\desktop-capsule\status.json"))
POLL_MS = 1500
STALE_MS = 30000

PRIORITY = {"approval": 5, "question": 5, "error": 4, "running": 3, "done": 2, "idle": 1}


class DshService(QtCore.QObject):
    state_changed = QtCore.Signal(str)  # running/approval/question/error/done/idle

    def __init__(self, parent=None):
        super().__init__(parent)
        self._last_state = None
        self._running = False
        self._timer = QtCore.QTimer(self)
        self._timer.setInterval(POLL_MS)
        self._timer.timeout.connect(self._tick)

    def start(self):
        self._running = True
        self._timer.start()
        self._tick()

    def stop(self):
        self._running = False
        self._timer.stop()

    def _tick(self):
        if not self._running:
            return
        try:
            doc = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
        except Exception:
            return
        updated = float(doc.get("updatedAt", 0) or 0)
        if time.time() * 1000 - updated > STALE_MS:
            return
        best = None
        best_score = -1
        for s in doc.get("sessions", []) or []:
            st = str(s.get("state", "idle"))
            score = PRIORITY.get(st, 0)
            if score > best_score:
                best_score = score
                best = s
        if best is None:
            return
        state = str(best.get("state", "idle"))
        if self._last_state != state:
            self._last_state = state
            self.state_changed.emit(state)
