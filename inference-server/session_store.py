"""
Session state for multi-step agent flows.

Stores, per ``session_id``, the original task and a short, bounded history of the
most recent steps (structural map + chosen action). This gives the model
lightweight conversation context for multi-step tasks.

The store is in-memory by default. It is intentionally small so Redis can replace
it later via the same ``SessionStore`` interface.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Mapping

logger = logging.getLogger("securelink.session")

# Max number of past steps kept per session.
MAX_HISTORY = 8

# Max characters of history context injected into a prompt (safety cap).
MAX_HISTORY_CHARS = 3000


class Session:
    """A single conversation session."""

    __slots__ = ("task", "history", "created_at", "updated_at")

    def __init__(self, task: str) -> None:
        self.task = task
        self.history: list[dict[str, Any]] = []
        self.created_at = time.time()
        self.updated_at = self.created_at


class SessionStore:
    """Thread-safe in-memory session store."""

    def __init__(self, max_history: int = MAX_HISTORY) -> None:
        self._max_history = max_history
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def get_or_create(self, session_id: str, task: str) -> Session:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                session = Session(task)
                self._sessions[session_id] = session
            else:
                # Keep the original task stable across steps unless none was set.
                if task:
                    session.task = task
            session.updated_at = time.time()
            return session

    def append(
        self,
        session_id: str,
        *,
        structural_map: list[Mapping[str, Any]],
        action: Mapping[str, Any] | None,
    ) -> Session:
        """Record one completed step for the session (capped at max_history)."""
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                session = Session("")
                self._sessions[session_id] = session

            entry: dict[str, Any] = {
                "structural_map": structural_map,
                "action": action,
                "ts": time.time(),
            }
            session.history.append(entry)
            if len(session.history) > self._max_history:
                session.history = session.history[-self._max_history :]
            session.updated_at = time.time()
            return session

    def history(self, session_id: str) -> list[dict[str, Any]]:
        with self._lock:
            session = self._sessions.get(session_id)
            return list(session.history) if session else []

    def get(self, session_id: str) -> Session | None:
        with self._lock:
            return self._sessions.get(session_id)

    def clear(self, session_id: str | None = None) -> int:
        """Clear one session, or all sessions when *session_id* is None."""
        with self._lock:
            if session_id is None:
                count = len(self._sessions)
                self._sessions.clear()
                return count
            return 1 if self._sessions.pop(session_id, None) is not None else 0

    def format_history_context(self, session_id: str) -> str:
        """
        Build a compact 'PAST STEPS' context block from the session history,
        listing the actions already taken so the model can plan the next step.
        """
        with self._lock:
            session = self._sessions.get(session_id)
            if not session or not session.history:
                return ""

        lines = []
        for i, entry in enumerate(session.history, start=1):
            action = entry.get("action") or {}
            action_name = action.get("action") or "?"
            target = action.get("target_id") or "null"
            reasoning = (action.get("reasoning") or "").strip()
            cost = len(reasoning)
            line = f"{i}. {action_name} on {target}"
            if reasoning and cost <= 400:
                line += f" - {reasoning}"
            lines.append(line)

        joined = "\n".join(lines)
        if len(joined) > MAX_HISTORY_CHARS:
            joined = joined[:MAX_HISTORY_CHARS] + " ..."
        return joined


# Module-level default store the app uses; swap this for a Redis-backed one.
store = SessionStore()

# JSON serialization helper for building the context block string.
_dumps = json.dumps
__all__ = ["SessionStore", "Session", "store"]