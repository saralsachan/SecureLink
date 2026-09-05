"""Integration test: a 3-step multi-step flow through /agent/step with session state."""

from __future__ import annotations

import base64
import json
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server as srv


def _solid_png_b64() -> str:
    img = Image.new("RGB", (8, 8), (200, 200, 200))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _name_field() -> list[dict]:
    return [{"id": "input-name", "tag": "input", "input_type": "email" if False else "text", "role": "textbox"}]


def _email_field() -> list[dict]:
    return [{"id": "input-email", "tag": "input", "input_type": "email", "role": "textbox"}]


def _submit_button() -> list[dict]:
    return [{"id": "submit", "tag": "button", "role": "button"}]


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture()
def step_client(monkeypatch: pytest.MonkeyPatch):
    """TestClient with a fresh SessionStore + scripted action backend."""
    from backends.base import DescribeResult, VisionBackend
    from session_store import SessionStore

    # Fresh store so each test starts clean.
    fresh_store = SessionStore()
    monkeypatch.setattr(srv, "_session_store", fresh_store)

    calls: list[dict] = []

    # Map a present element id -> the action the model should return for it.
    def action_for_id(eid: str) -> dict:
        if eid == "input-name":
            return {"action": "type", "target_id": "input-name", "value": "[REDACTED_NAME_1]", "reasoning": "fill name"}
        if eid == "input-email":
            return {"action": "type", "target_id": "input-email", "value": "[REDACTED_EMAIL_1]", "reasoning": "fill email"}
        if eid == "submit":
            return {"action": "click", "target_id": "submit", "value": None, "reasoning": "submit form"}
        return {"action": "click", "target_id": eid, "value": None, "reasoning": "act"}

    def extract_present_id(messages) -> str:
        # Pull the first element id out of the structural-map JSON in the user message.
        import re

        for m in messages or []:
            if m.get("role") != "user":
                continue
            content = m.get("content", "")
            m_obj = re.search(r'"id":\s*"([^"]+)"', content)
            if m_obj:
                return m_obj.group(1)
        return "submit"

    class ScriptedBackend(VisionBackend):
        async def describe_image(self, image_b64, prompt="", messages=None):
            target = extract_present_id(messages)
            calls.append({"prompt": prompt, "messages": messages})
            text = json.dumps(action_for_id(target))
            return DescribeResult(text=text, backend="mock", model="mock-1.0", latency_ms=0.0)

        def health(self):
            return {"backend": "mock", "model": "mock-1.0"}

    monkeypatch.setattr(srv, "_backend", ScriptedBackend())
    monkeypatch.setattr(srv, "_current_backend", lambda: srv._backend)

    client = TestClient(srv.app)
    return client, calls


@pytest.fixture()
def screens():
    """The three screens for the 3-step flow (frame by frame)."""
    return [_name_field(), _email_field(), _submit_button()]


def test_three_step_flow_fill_name_email_submit(step_client) -> None:
    client, calls = step_client
    screens = [_name_field(), _email_field(), _submit_button()]
    session_id = "sess-fill-form"

    expected = [
        ("type", "input-name"),
        ("type", "input-email"),
        ("click", "submit"),
    ]

    for i, (screen, (exp_action, exp_target)) in enumerate(zip(screens, expected), start=1):
        resp = client.post(
            "/agent/step",
            json={
                "session_id": session_id,
                "screenshot_base64": _solid_png_b64(),
                "structural_map": screen,
                "task": "Fill the form and submit",
                "history_n": 3,
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["action"]["action"] == exp_action
        assert body["action"]["target_id"] == exp_target
        assert body["step"] == i
        assert body["session_id"] == session_id
        assert len(body["history"]) == i

    # Exactly three backend calls happened (one per step, no ungrounded retries).
    assert len(calls) == 3


def test_session_history_is_propagated_to_prompt(step_client) -> None:
    client, calls = step_client
    screens = [_name_field(), _email_field()]

    client.post(
        "/agent/step",
        json={
            "session_id": "sess-ctx",
            "screenshot_base64": _solid_png_b64(),
            "structural_map": screens[0],
            "task": "fill the form",
        },
    )

    resp = client.post(
        "/agent/step",
        json={
            "session_id": "sess-ctx",
            "screenshot_base64": _solid_png_b64(),
            "structural_map": screens[1],
            "task": "fill the form",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["step"] == 2

    # The second step's user prompt carried PAST STEPS context.
    second_messages = calls[1]["messages"]
    user_texts = [m.get("content", "") for m in second_messages if m.get("role") == "user"]
    joined = "\n".join(user_texts)
    assert "PAST STEPS" in joined
    assert "input-name" in joined


def test_scripted_full_flow_with_distinct_session_ids_are_isolated(step_client) -> None:
    client, calls = step_client
    screens = [_name_field(), _email_field(), _submit_button()]

    resp_a1 = client.post(
        "/agent/step",
        json={
            "session_id": "session-a",
            "screenshot_base64": _solid_png_b64(),
            "structural_map": screens[0],
            "task": "form a",
        },
    )
    assert resp_a1.json()["step"] == 1

    # New session starts fresh at step 1.
    resp_b1 = client.post(
        "/agent/step",
        json={
            "session_id": "session-b",
            "screenshot_base64": _solid_png_b64(),
            "structural_map": screens[0],
            "task": "form b",
        },
    )
    assert resp_b1.json()["step"] == 1

    # Continue session-a to step 2 (its history persists, isolated from b).
    resp_a2 = client.post(
        "/agent/step",
        json={
            "session_id": "session-a",
            "screenshot_base64": _solid_png_b64(),
            "structural_map": screens[1],
            "task": "form a",
        },
    )
    assert resp_a2.json()["step"] == 2
    assert resp_a2.json()["action"]["target_id"] == "input-email"


def test_extension_camel_case_fields_reach_the_model_prompt(step_client) -> None:
    """The extension sends camelCase nodes; they must survive the server model."""
    client, calls = step_client

    resp = client.post(
        "/agent/step",
        json={
            "session_id": "sess-camel",
            "screenshot_base64": _solid_png_b64(),
            "task": "fill the email",
            "structural_map": [
                {
                    "id": "mail",
                    "tag": "input",
                    "role": "textbox",
                    "inputType": "email",
                    "ariaLabel": "Email address",
                    "autocomplete": "email",
                    "bbox": {"x": 10, "y": 20, "w": 200, "h": 30},
                }
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["ok"] is True
    assert data["action"]["target_id"] == "mail"
    # Grounded on the first model call (no hallucination retries).
    assert len(calls) == 1

    user_texts = "\n".join(
        m.get("content", "") for call in calls for m in call["messages"] if m.get("role") == "user"
    )
    assert '"inputType": "email"' in user_texts
    assert '"bbox":' in user_texts
    assert '"ariaLabel": "Email address"' in user_texts


def test_agent_step_returns_server_timings(step_client) -> None:
    """agent/step reports the firewall/VLM/grounding split and a total."""
    client, _ = step_client

    resp = client.post(
        "/agent/step",
        json={
            "session_id": "sess-timings",
            "screenshot_base64": _solid_png_b64(),
            "task": "fill the name",
            "structural_map": [
                {"id": "name", "tag": "input", "role": "textbox", "inputType": "text"},
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    timings = resp.json()["timings"]
    assert set(("firewall_ms", "vlm_ms", "grounding_ms", "total_ms")) <= set(timings)
    assert timings["total_ms"] >= 0
    assert timings["total_ms"] >= timings["firewall_ms"]
    assert timings["total_ms"] >= timings["vlm_ms"]
    assert timings["total_ms"] >= timings["grounding_ms"]