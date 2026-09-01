"""Tests for prompt_builder: templates, strict-JSON validation, retry prompt."""

from __future__ import annotations

import json

from prompt_builder import (
    ACTION_SCHEMA,
    build_correction_prompt,
    build_prompt,
    validate_action_output,
)


# ── build_prompt ─────────────────────────────────────────────────────────────

def test_build_prompt_returns_system_and_user() -> None:
    system, user = build_prompt(
        screenshot_base64="QUJD",
        structural_map_json='[{"id":"btn","tag":"button","aria_label":"Submit"}]',
        task="Click the submit button.",
    )
    assert "system" not in system  # content, not a dict
    assert "Submit" in system or "next" in system
    assert "btn" in user  # structural map ids appear in the user message
    assert '"action": "click|type|scroll|navigate"' in system
    assert "STRICT JSON" in system


def test_build_prompt_accepts_dict_structural_map() -> None:
    system, user = build_prompt(
        screenshot_base64="QUJD",
        structural_map_json=[{"id": "a", "tag": "input"}],
        task="Fill the field.",
    )
    assert "a" in user


def test_build_prompt_includes_invalid_map_gracefully() -> None:
    system, user = build_prompt(
        screenshot_base64="",
        structural_map_json=object(),  # not serialisable
        task="Do a thing.",
    )
    assert "[]" in user


# ── validate_action_output: valid cases ──────────────────────────────────────

def test_validate_ok() -> None:
    ok, parsed, error = validate_action_output(
        json.dumps(
            {
                "action": "type",
                "target_id": "email-field",
                "value": "a@b.co",
                "reasoning": "next step needs the address",
            }
        )
    )
    assert ok is True
    assert parsed["action"] == "type"
    assert error is None


def test_validate_ok_with_null_target() -> None:
    ok, parsed, _ = validate_action_output(
        '{"action":"navigate","target_id":null,"value":"/next","reasoning":"go"}'
    )
    assert ok is True
    assert parsed["target_id"] is None


def test_validate_ok_inside_code_fence() -> None:
    ok, parsed, _ = validate_action_output(
        '```json\n{"action":"scroll","target_id":null,"value":"down","reasoning":"see more"}\n```'
    )
    assert ok is True
    assert parsed["action"] == "scroll"


# ── validate_action_output: invalid cases ────────────────────────────────────

def test_validate_rejects_bad_action_enum() -> None:
    ok, _, error = validate_action_output(
        '{"action":"hover","target_id":"x","value":null,"reasoning":"nope"}'
    )
    assert ok is False
    assert "hover" in error
    assert "one of" in error


def test_validate_rejects_missing_key() -> None:
    ok, _, error = validate_action_output('{"action":"click","target_id":"x"}')
    assert ok is False
    assert "missing required key 'value'" in error


def test_validate_rejects_unexpected_key() -> None:
    ok, _, error = validate_action_output(
        '{"action":"click","target_id":"x","value":null,"reasoning":"r","extra":1}'
    )
    assert ok is False
    assert "unexpected key" in error


def test_validate_rejects_non_json() -> None:
    ok, _, error = validate_action_output("definitely not json")
    assert ok is False
    assert error is not None


def test_validate_rejects_bad_value_type() -> None:
    ok, _, error = validate_action_output(
        '{"action":"type","target_id":"x","value":42,"reasoning":"r"}'
    )
    assert ok is False
    assert "expected one of" in error


def test_schema_is_wellformed() -> None:
    assert ACTION_SCHEMA["type"] == "object"
    assert set(ACTION_SCHEMA["required"]) == {"action", "target_id", "value", "reasoning"}


# ── retry-with-correction prompt ─────────────────────────────────────────────

def test_correction_prompt_includes_error_and_previous() -> None:
    correction = build_correction_prompt(
        previous_output='"bad json"',
        error="not valid JSON",
    )
    assert "not valid JSON" in correction
    assert '"bad json"' in correction
    assert "REJECTION REASON" in correction