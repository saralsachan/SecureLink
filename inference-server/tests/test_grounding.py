"""Unit tests for ground_action: grounding model actions against the map."""

from __future__ import annotations

import pytest

from grounding import ground_action, ValidatedAction


def _map_element(**fields) -> dict:
    element = {
        "id": "btn",
        "tag": "button",
        "role": "button",
        "value": "Submit",
        "bbox": {"x": 0, "y": 0, "w": 100, "h": 32},
    }
    element.update(fields)
    return element


def _map(*elements: dict) -> list[dict]:
    return list(elements)


# ── Valid action ─────────────────────────────────────────────────────────────

def test_valid_click_returns_ok() -> None:
    structural_map = _map(_map_element(role="button"))
    result = ground_action(
        {"action": "click", "target_id": "btn", "value": None, "reasoning": "next"},
        structural_map,
    )
    assert result.ok is True
    assert result.action == "click"
    assert result.target_id == "btn"


def test_valid_type_on_text_field_returns_ok() -> None:
    structural_map = _map(_map_element(id="email", tag="input", input_type="email", role="textbox"))
    result = ground_action(
        {"action": "type", "target_id": "email", "value": "a@b.co", "reasoning": "fill"},
        structural_map,
    )
    assert result.ok is True


def test_valid_type_on_textarea_returns_ok() -> None:
    structural_map = _map(_map_element(id="bio", tag="textarea", role="textbox"))
    result = ground_action(
        {"action": "type", "target_id": "bio", "value": "hello", "reasoning": "fill"},
        structural_map,
    )
    assert result.ok is True


def test_global_scroll_with_null_target_returns_ok() -> None:
    result = ground_action(
        {"action": "scroll", "target_id": None, "value": "down", "reasoning": "see more"},
        _map(),
    )
    assert result.ok is True


# ── Hallucinated target_id ───────────────────────────────────────────────────

def test_hallucinated_target_id_returns_error() -> None:
    structural_map = _map(_map_element())
    result = ground_action(
        {"action": "click", "target_id": "ghost-btn", "value": None, "reasoning": "next"},
        structural_map,
    )
    assert result.ok is False
    assert result.error is not None
    assert "ghost-btn" in result.error
    assert "does not exist" in result.error


def test_hallucinated_target_on_type_also_rejected() -> None:
    result = ground_action(
        {"action": "type", "target_id": "nope", "value": "x", "reasoning": ""},
        _map(_map_element()),
    )
    assert result.ok is False
    assert "does not exist" in result.error


def test_empty_structural_map_rejects_any_target() -> None:
    result = ground_action(
        {"action": "click", "target_id": "anything", "value": None, "reasoning": ""},
        [],
    )
    assert result.ok is False


def test_missing_target_for_click_rejected() -> None:
    result = ground_action(
        {"action": "click", "target_id": None, "value": None, "reasoning": ""},
        _map(_map_element()),
    )
    assert result.ok is False
    assert "requires a target" in result.error


# ── Action / element type mismatch ───────────────────────────────────────────

def test_type_on_button_is_rejected() -> None:
    structural_map = _map(_map_element(role="button"))
    result = ground_action(
        {"action": "type", "target_id": "btn", "value": "hello", "reasoning": "try type on button"},
        structural_map,
    )
    assert result.ok is False
    assert "not compatible" in result.error
    assert "type" in result.error


def test_click_on_non_interactive_heading_is_rejected() -> None:
    structural_map = _map(
        _map_element(id="title", tag="h1", role="heading", w=400, h=40)
    )
    result = ground_action(
        {"action": "click", "target_id": "title", "value": None, "reasoning": ""},
        structural_map,
    )
    assert result.ok is False
    assert "not interactive" in result.error


def test_click_on_button_is_ok() -> None:
    result = ground_action(
        {"action": "click", "target_id": "btn", "value": None, "reasoning": ""},
        _map(_map_element(role="button")),
    )
    assert result.ok is True


def test_type_on_radio_input_rejected() -> None:
    structural_map = _map(
        _map_element(id="opt", tag="input", input_type="radio", role="radio")
    )
    result = ground_action(
        {"action": "type", "target_id": "opt", "value": "x", "reasoning": ""},
        structural_map,
    )
    assert result.ok is False


# ── Visibility / interactivity guard rails ───────────────────────────────────

def test_hidden_element_is_rejected() -> None:
    structural_map = _map(_map_element(display="none"))
    result = ground_action(
        {"action": "click", "target_id": "btn", "value": None, "reasoning": ""},
        structural_map,
    )
    assert result.ok is False
    assert "not visible" in result.error


def test_zero_bbox_element_is_rejected() -> None:
    structural_map = _map(_map_element(bbox={"x": 0, "y": 0, "w": 0, "h": 0}))
    result = ground_action(
        {"action": "click", "target_id": "btn", "value": None, "reasoning": ""},
        structural_map,
    )
    assert result.ok is False
    assert "not visible" in result.error


def test_no_error_on_valid_action() -> None:
    result = ground_action(
        {"action": "navigate", "target_id": None, "value": "/home", "reasoning": "go"},
        _map(),
    )
    assert result.ok is True
    assert result.error is None


def test_returns_validated_action_instance() -> None:
    result = ground_action(
        {"action": "click", "target_id": "btn", "value": None, "reasoning": ""},
        _map(_map_element()),
    )
    assert isinstance(result, ValidatedAction)
    assert result.to_schema_dict()["action"] == "click"