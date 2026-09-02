"""Unit tests for the in-memory session store."""

from __future__ import annotations

from session_store import SessionStore, MAX_HISTORY


def _entry(action: str, target: str) -> dict:
    return {"action": action, "target_id": target, "reasoning": f"do {action} on {target}"}


def test_get_or_create_creates_and_reuses() -> None:
    store = SessionStore()
    s1 = store.get_or_create("s-1", "fill the form")
    assert s1.task == "fill the form"

    s2 = store.get_or_create("s-1", "fill the form")
    assert s2 is s1


def test_append_and_history_returns_entries() -> None:
    store = SessionStore()
    store.get_or_create("s-1", "task")
    store.append("s-1", structural_map=[{"id": "a"}], action=_entry("type", "a"))
    store.append("s-1", structural_map=[{"id": "b"}], action=_entry("type", "b"))

    history = store.history("s-1")
    assert len(history) == 2
    assert history[0]["action"]["action"] == "type"
    assert history[1]["structural_map"] == [{"id": "b"}]


def test_history_capped_at_max() -> None:
    store = SessionStore(max_history=3)
    store.get_or_create("s-1", "task")
    for i in range(10):
        store.append("s-1", structural_map=[], action=_entry("click", f"btn{i}"))

    history = store.history("s-1")
    assert len(history) == 3
    assert history[0]["action"]["target_id"] == "btn7"  # oldest surviving
    assert history[-1]["action"]["target_id"] == "btn9"


def test_unknown_session_has_no_history() -> None:
    store = SessionStore()
    assert store.history("missing") == []
    assert store.format_history_context("missing") == ""


def test_format_history_context_lists_steps() -> None:
    store = SessionStore()
    store.get_or_create("s-1", "task")
    store.append("s-1", structural_map=[], action=_entry("type", "name-field"))
    store.append("s-1", structural_map=[], action=_entry("type", "email-field"))

    ctx = store.format_history_context("s-1")
    assert "1. type on name-field" in ctx
    assert "2. type on email-field" in ctx


def test_clear_removes_one_or_all() -> None:
    store = SessionStore()
    store.get_or_create("s-1", "a")
    store.get_or_create("s-2", "b")
    store.clear("s-1")
    assert store.get("s-1") is None
    assert store.get("s-2") is not None

    store.clear()
    assert store.get("s-2") is None


def test_max_history_constant_is_positive() -> None:
    assert isinstance(MAX_HISTORY, int)
    assert MAX_HISTORY > 0