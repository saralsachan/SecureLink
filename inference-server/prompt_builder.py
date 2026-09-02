"""
Prompt templating + strict-JSON output validation for SecureLink.

      build_prompt(screenshot, structural_map_json, task)
          → (system_message, user_message)

The system prompt instructs the model to identify the next-step UI element using
ONLY the supplied element ids, and to reply with STRICT JSON matching ACTION_SCHEMA.

      validate_action_output(text)
          → (ok, parsed, error)

Extracts the JSON object from a model response and validates it against
ACTION_SCHEMA. If parsing/validation fails, build_correction_prompt() assembles a
retry-with-correction user prompt listing the exact problem.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("securelink.prompts")

# ── Action vocabulary ────────────────────────────────────────────────────────

VALID_ACTIONS = ("click", "type", "scroll", "navigate")

ACTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["action", "target_id", "value", "reasoning"],
    "properties": {
        "action": {"type": "string", "enum": list(VALID_ACTIONS)},
        "target_id": {"type": ["string", "null"]},
        "value": {"type": ["string", "null"]},
        "reasoning": {"type": "string"},
        "requires_confirmation": {"type": "boolean"},
    },
    "additionalProperties": False,
}

# ── The core instruction templates ───────────────────────────────────────────

_SYSTEM_TEMPLATE = """\
You are an automation agent for a web assistant. A privacy filter has network-redacted an \
on-screen screenshot and anonymized its DOM as a structural map.

TASK
====
{task}

RULES
=====
1. Determine the SINGLE most relevant UI element(s) for the NEXT single step of the task.
2. Refer to elements ONLY by their "id" values present in the structural map below.
   Never invent, guess, or reuse ids that are not listed.
3. If the next step cannot be performed (e.g. no element matches, or the step is not \
actionable on this screen), set "target_id" to null.
4. Reply with STRICT JSON ONLY — no prose, no fence, no trailing text. The object MUST \
match this schema exactly:

{{
  "action": "click|type|scroll|navigate",
  "target_id": "string|null",
  "value": "string|null",
  "reasoning": "string",
  "requires_confirmation": "boolean (optional)"
}}

where:
  - "action": one of click, type, scroll, navigate
  - "target_id": the element id to act on, or null
  - "value":
      - for "type": the text to type into the target field
        (may be a [REDACTED_*] token referencing a previously redacted value)
      - for "navigate": the destination URL
      - for "scroll": scroll direction ("up" | "down")
      - for "click": null
  - "reasoning": a short justification citing the element id(s) you used
  - "requires_confirmation": optional; set true only for high-impact or \
irreversible actions that should prompt the user first (e.g. destructive \
submits, navigation away with unsaved changes)
"""

_USER_TEMPLATE = """\
Redacted screenshot and anonymized structural map for the current screen:

ANONYMIZED STRUCTURAL MAP (JSON)
================================
{structural_map_json}

Respond with the STRICT JSON object only."""

_PAST_STEPS_TEMPLATE = """\
PAST STEPS ALREADY COMPLETED (for multi-step context)
=====================================================
{history_context}
"""


def build_prompt(
    screenshot_base64: str,
    structural_map_json: str,
    task: str,
    history_context: str = "",
) -> tuple[str, str]:
    """
    Build (system, user) prompt messages for the next-step UI action.

    * screenshot_base64    — the redacted screenshot (attached to the user turn
                             by the vision backend).
    * structural_map_json  — the anonymized structural map, serialised to JSON.
    * task                 — the user's task string.
    * history_context      — optional 'past steps' block describing actions already
                             taken in this session (for multi-step context).

    Returns a (system, user) pair. The system message carries the strict-JSON
    instruction and task; the user message supplies the structural map (+ optional
    past steps) and references the screenshot the backend attaches.
    """
    try:
        safe_map = structural_map_json if isinstance(structural_map_json, str) else json.dumps(structural_map_json)
    except TypeError:
        safe_map = "[]"
        logger.warning("prompts: structural map not JSON-serialisable")

    system = _SYSTEM_TEMPLATE.format(task=task)
    user = _USER_TEMPLATE.format(structural_map_json=safe_map)
    if history_context:
        user = _PAST_STEPS_TEMPLATE.format(history_context=history_context) + user

    # screenshot_base64 is carried for documentation / logging only; the backend
    # attaches it to the request body separately.
    logger.info(
        "prompts: built prompt (screenshot_chars=%d, map_chars=%d, task_chars=%d, history_chars=%d)",
        len(screenshot_base64 or ""),
        len(safe_map),
        len(task),
        len(history_context),
    )
    return system, user


# ── JSON extraction ──────────────────────────────────────────────────────────

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.+?)\s*```", re.DOTALL)
_OBJECT_OR_INDENTED_RE = re.compile(r"\{.*\}", re.DOTALL)


def _extract_json(text: str) -> str:
    """Pull the JSON object body out of a (possibly fenced/verbose) model reply."""
    text = (text or "").strip()

    block = _JSON_BLOCK_RE.search(text)
    if block:
        text = block.group(1).strip()

    m = _OBJECT_OR_INDENTED_RE.search(text)
    if m:
        # Best-effort: trim trailing comma before closing brace, then decode.
        candidate = m.group(0)
        candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
        return candidate
    return text


class _ValidationError(ValueError):
    pass


def _validate_against_schema(obj: Any, schema: dict[str, Any], path: str = "") -> None:
    """A compact JSON-schema validator limited to ACTION_SCHEMA's forms."""
    if schema.get("type") in ("object",):
        if not isinstance(obj, dict):
            raise _ValidationError(f"{path}: expected object, got {type(obj).__name__}")
        required = schema.get("required", [])
        properties = schema.get("properties", {})
        for key in required:
            if key not in obj:
                raise _ValidationError(f"{path}: missing required key '{key}'")
        if schema.get("additionalProperties") is False:
            extra = set(obj) - set(properties)
            if extra:
                raise _ValidationError(f"{path}: unexpected key(s) {sorted(extra)}")
        for key, value in obj.items():
            prop_schema = properties.get(key)
            if prop_schema:
                _validate_against_schema(value, prop_schema, f"{path}.{key}")

    elif "enum" in schema:
        if obj not in schema["enum"]:
            raise _ValidationError(
                f"{path}: '{obj}' is not one of {schema['enum']}"
            )

    elif schema.get("type") == "string":
        if not isinstance(obj, str):
            raise _ValidationError(f"{path}: expected string, got {type(obj).__name__}")

    elif schema.get("type") == "null":
        if obj is not None:
            raise _ValidationError(f"{path}: expected null, got {type(obj).__name__}")

    elif "type" in schema and isinstance(schema.get("type"), list):
        type_ok = any(obj is None if t == "null" else isinstance(obj, _PYTYPE[t]) for t in schema["type"])
        if not type_ok:
            raise _ValidationError(f"{path}: expected one of {schema['type']}, got {type(obj).__name__}")


_PYTYPE = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict, "array": list}


def validate_action_output(text: str) -> tuple[bool, dict | None, str | None]:
    """
    Validate a raw model reply against ACTION_SCHEMA.

    Returns (ok, parsed, error). On success ok=True and parsed holds the dict;
    otherwise parsed is None and error is a human-readable description used to
    build the retry-with-correction prompt.
    """
    try:
        body = _extract_json(text)
        obj = json.loads(body)
    except json.JSONDecodeError as e:
        return False, None, f"output is not valid JSON: {e.msg} (near char {e.pos}); return only a JSON object."
    except Exception as e:  # noqa: BLE001
        return False, None, f"output could not be read as JSON: {e}"

    try:
        _validate_against_schema(obj, ACTION_SCHEMA)
    except _ValidationError as e:
        return False, None, f"schema violation: {e}"

    logger.info("prompts: model output validated against ACTION_SCHEMA")
    return True, obj, None


# ── Retry-with-correction ────────────────────────────────────────────────────

_CORRECTION_TEMPLATE = """\
Your previous reply was rejected.

REJECTION REASON
================
{error}

What you replied earlier:
{previous_output}

Action required
===============
Fix the reply so it is a single STRICT JSON object matching EXACTLY this schema:
{{
  "action": "click|type|scroll|navigate",
  "target_id": "string|null",
  "value": "string|null",
  "reasoning": "string",
  "requires_confirmation": "boolean (optional)"
}}

Return ONLY the corrected JSON object. No prose, no fences."""


def build_correction_prompt(previous_output: str, error: str) -> str:
    """Build the user message that asks for a corrected JSON reply."""
    return _CORRECTION_TEMPLATE.format(
        error=error,
        previous_output=(previous_output or "").strip()[:2000],
    )