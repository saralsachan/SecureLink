"""
Action grounding: verify a model's chosen action is real and executable.

      ground_action(model_output, structural_map) -> ValidatedAction

Checks -- against the anonymized structural map -- that the target element:
  1. actually exists (rejects hallucinated / invented ids),
  2. is interactive and visible when the action requires a target,
  3. is compatible with the chosen action (e.g. no "type" on a <button>).

On any failure a ``ValidatedAction`` with ``ok=False`` is returned whose
``error`` message is a *corrected constraint* the model should use when it retries.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Mapping

logger = logging.getLogger("securelink.grounding")

# ── Element interactivity / compatibility rules ──────────────────────────────

# Click works on any element the user can activate.
_CLICKABLE_TAGS = {
    "a",
    "button",
    "select",
    "textarea",
    "summary",
    "details",
    "label",
    "input",
}
_CLICKABLE_ROLES = {
    "button",
    "link",
    "tab",
    "tablist",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "menuitemcheckbox",
    "option",
    "combobox",
    "dialog",
    "close",
    "submit",
}

# Non-button/checkbox/radio inputs (i.e. free-text entry) accept typing.
_TEXT_ENTRY_INPUT_TYPES = {
    "text",
    "email",
    "tel",
    "password",
    "number",
    "search",
    "url",
    "date",
    "datetime-local",
    "month",
    "time",
    "week",
}
_TYPEABLE_TAGS = {"input", "textarea"}
_TYPEABLE_ROLES = {"textbox", "searchbox"}


def _tag_of(element: Mapping[str, Any]) -> str:
    return str(element.get("tag") or "").lower()


def _role_of(element: Mapping[str, Any]) -> str | None:
    role = element.get("role")
    if role:
        return str(role).lower()
    return None


def _input_type_of(element: Mapping[str, Any]) -> str | None:
    raw = element.get("input_type") or element.get("inputType")
    if raw:
        return str(raw).lower()
    tag = _tag_of(element)
    if tag == "input":
        return "text"
    return None


def _is_visible(element: Mapping[str, Any]) -> bool:
    """Heuristic visibility using optional bbox/display/hidden hints."""
    if element.get("hidden") is True:
        return False
    display = str(element.get("display") or "").lower()
    visibility = str(element.get("visibility") or "").lower()
    if display in ("none", "contents") or visibility in ("hidden", "collapse"):
        return False
    bbox = element.get("bbox")
    if isinstance(bbox, Mapping):
        w = bbox.get("w")
        h = bbox.get("h")
        if (w is not None and w <= 0) or (h is not None and h <= 0):
            return False
    return True


def _is_contenteditable(element: Mapping[str, Any]) -> bool:
    contenteditable = element.get("contenteditable")
    return contenteditable is True or str(contenteditable).lower() == "true"


def _is_interactive(element: Mapping[str, Any]) -> bool:
    tag = _tag_of(element)
    role = _role_of(element)
    input_type = _input_type_of(element)

    if tag in _CLICKABLE_TAGS:
        return True
    if role in _CLICKABLE_ROLES:
        return True
    # Plain text/email/etc. inputs are still clickable to focus.
    if tag == "input" and input_type not in ("button", "submit", "file", "image", "hidden"):
        return True
    if _is_contenteditable(element):
        return True
    return False


def _action_takes_target(action: str) -> bool:
    """click/type need an element; scroll/navigate may act globally."""
    return action in ("click", "type")


def _action_compatible(action: str, element: Mapping[str, Any]) -> bool:
    tag = _tag_of(element)
    role = _role_of(element)
    input_type = _input_type_of(element)
    editable = _is_contenteditable(element)

    if action == "click":
        return _is_interactive(element)

    if action == "type":
        if editable:
            return True
        if tag in _TYPEABLE_TAGS:
            if tag == "input":
                # Block typing into buttons / checkboxes / radios / file pickers.
                return input_type in _TEXT_ENTRY_INPUT_TYPES
            return True  # textarea
        if role in _TYPEABLE_ROLES:
            return True
        return False

    if action == "scroll":
        # Window-level scroll has no target; element scroll just needs to exist.
        return True

    if action == "navigate":
        # Navigation targets a URL, not a DOM element.
        return True

    return False


def _element_action_error(
    action: str, element: Mapping[str, Any]
) -> str | None:
    if not _is_visible(element):
        return (
            f"target element '{element.get('id')}' is not visible on screen; "
            "pick a visible element or set target_id to null."
        )
    if action in ("click", "type") and not _is_interactive(element):
        return (
            f"target element '{element.get('id')}' (<{_tag_of(element)}>) "
            "is not interactive; pick a clickable/typeable element or set "
            "target_id to null."
        )
    if not _action_compatible(action, element):
        return (
            f"action '{action}' is not compatible with element "
            f"'{element.get('id')}' (<{_tag_of(element)}>). "
            f"Use an action the element supports (e.g. a "
            f"{_type_hint(action)})."
        )
    return None


def _type_hint(action: str) -> str:
    if action == "click":
        return "clickable element like <a> or <button>"
    if action == "type":
        return "text-entry element like <input> or <textarea>"
    return "target_id or null"


# ── Public API ───────────────────────────────────────────────────────────────

@dataclass
class ValidatedAction:
    """A grounded action decision."""

    ok: bool
    action: str | None = None
    target_id: str | None = None
    value: str | None = None
    reasoning: str | None = None
    error: str | None = None

    def to_schema_dict(self) -> dict[str, Any]:
        """Serialize back to the strict-JSON action schema shape."""
        return {
            "action": self.action,
            "target_id": self.target_id,
            "value": self.value,
            "reasoning": self.reasoning,
        }


def ground_action(
    model_output: Mapping[str, Any],
    structural_map: list[Mapping[str, Any]],
) -> ValidatedAction:
    """
    Validate a model action against the structural map.

    * model_output     — the parsed action dict {action, target_id, value, reasoning}.
    * structural_map   — the anonymized element list (ids + tag/role/bbox hints).

    Returns a ``ValidatedAction``. When ``ok`` is False, ``error`` carries a
    corrected constraint for the model to retry with.
    """
    action = model_output.get("action")
    target_id = model_output.get("target_id")
    value = model_output.get("value")
    reasoning = model_output.get("reasoning")

    by_id: dict[str, Mapping[str, Any]] = {}
    for element in structural_map or []:
        eid = element.get("id")
        if eid is not None:
            by_id[str(eid)] = element

    if _action_takes_target(action) and target_id is None:
        return ValidatedAction(
            ok=False,
            action=action,
            target_id=None,
            value=value,
            reasoning=reasoning,
            error=(
                f"action '{action}' requires a target element, but target_id is "
                "null. Choose the element id from the structural map."
            ),
        )

    if target_id is None:
        # scroll/navigate with no element — nothing more to ground.
        logger.info("grounding: global action '%s' accepted (no target)", action)
        return ValidatedAction(
            ok=True,
            action=action,
            target_id=None,
            value=value,
            reasoning=reasoning,
        )

    element = by_id.get(str(target_id))
    if element is None:
        logger.warning("grounding: hallucinated target '%s'", target_id)
        return ValidatedAction(
            ok=False,
            action=action,
            target_id=target_id,
            value=value,
            reasoning=reasoning,
            error=(
                f"target_id '{target_id}' does not exist in the structural map "
                "(hallucinated). Use one of the given element ids only."
            ),
        )

    element_error = _element_action_error(action, element)
    if element_error is not None:
        logger.warning("grounding: rejected %s on %s", action, target_id)
        return ValidatedAction(
            ok=False,
            action=action,
            target_id=target_id,
            value=value,
            reasoning=reasoning,
            error=element_error,
        )

    logger.info("grounding: '%s' on '%s' accepted", action, target_id)
    return ValidatedAction(
        ok=True,
        action=action,
        target_id=target_id,
        value=value,
        reasoning=reasoning,
    )