"""Profiling server for the SecureLink pipeline.

Runs the real FastAPI app (real privacy firewall, grounding, session state,
validation-and-retry loop) with a deterministic scripted vision backend so the
numbers reflect genuine server-side work without waiting on an external model.

The scripted backend replies grounded against the actual structural map it is
shown: step 1 types into the first map element, step 2 into the second, and
step 3 clicks the third (mirroring the three-field test form). A fresh process
is a fresh session, so stress runs are fully deterministic.

Usage:
    python -m tools.profile_server [--port 8011]
"""

import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import fastapi
import server as srv
import uvicorn
from backends.base import DescribeResult, VisionBackend

# One VLM "call" happens per agent step; this global mirrors a model that is
# watching the page evolve over the profile session.
_COUNTER: dict[str, int] = {"steps": 0}


def _extract_map_json(content: str) -> list[dict] | None:
    """Pull the structural-map JSON array out of the user prompt text."""
    start = content.find("[")
    if start == -1:
        return None
    depth = 0
    in_str = False
    escaped = False
    for i in range(start, len(content)):
        c = content[i]
        if in_str:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(content[start : i + 1])
                except (json.JSONDecodeError, TypeError):
                    return None
    return None


def _first(map_elements: list[dict], predicate) -> dict | None:
    for element in map_elements:  # DOM order
        if predicate(element):
            return element
    return None


def _pick_targets(messages) -> tuple[dict | None, dict | None, dict | None]:
    """(name_field, email_field, submit_button) from the map the model is shown."""
    for m in messages or []:
        if m.get("role") != "user":
            continue
        content = m.get("content", "")
        elements = _extract_map_json(content)
        if elements is None:
            continue

        input_type = lambda e: e.get("input_type") or e.get("inputType")
        is_textbox = lambda e: e.get("role") in ("textbox", "combobox", "searchbox") or input_type(e) in (
            "text", "search", "textarea", "select-one", "select-multiple"
        )
        is_email = lambda e: input_type(e) == "email"
        is_clickable = lambda e: e.get("role") in ("button", "link", "checkbox", "radio") or e.get("tag") in (
            "button", "a"
        ) or input_type(e) in ("submit", "checkbox", "radio", "button")

        name = _first(elements, is_textbox)
        email = _first(elements, is_email)
        submit = _first(elements, is_clickable)
        return name, email, submit
    return None, None, None


class ScriptedProfileBackend(VisionBackend):
    """Deterministic backend that acts on the map it is actually shown."""

    async def describe_image(self, image_b64, prompt="", messages=None):
        _COUNTER["steps"] += 1
        step = _COUNTER["steps"]
        name, email, submit = _pick_targets(messages)

        if step == 1:
            target = name.get("id") if name else "el_0"
            action = {
                "action": "type",
                "target_id": target,
                "value": "Alice",
                "reasoning": "fill the name field",
            }
        elif step == 2:
            target = email.get("id") if email else (name.get("id") if name else "el_1")
            action = {
                "action": "type",
                "target_id": target,
                "value": "alice@example.com",
                "reasoning": "fill the email field",
            }
        else:
            target = submit.get("id") if submit else (name.get("id") if name else "el_2")
            action = {
                "action": "click",
                "target_id": target,
                "value": None,
                "reasoning": "submit the signup form",
            }

        return DescribeResult(
            text=json.dumps(action),
            backend="scripted",
            model="scripted-profile",
            latency_ms=0.0,
        )

    def health(self):
        return {"backend": "scripted", "model": "scripted-profile"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("PROFILE_PORT", "8011")))
    args = parser.parse_args()

    srv._backend = ScriptedProfileBackend()
    srv._current_backend = lambda: srv._backend  # type: ignore[method-assign]

    # Wrap the real app with a profiling-only reset route (registered before the
    # mount so it wins path matching against the mounted app).
    profile_app = fastapi.FastAPI()

    @profile_app.post("/__profile/reset")
    async def _reset_profile_state() -> dict:
        _COUNTER["steps"] = 0
        from session_store import SessionStore

        srv._session_store = SessionStore()
        return {"ok": True, "steps": _COUNTER["steps"]}

    profile_app.mount("/", srv.app)

    print(f"[profile] scripted backend on port {args.port}", flush=True)
    uvicorn.run(profile_app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()