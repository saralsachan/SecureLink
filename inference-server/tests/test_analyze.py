"""Tests for the /analyze endpoint guarded by the privacy firewall."""

from __future__ import annotations

import base64
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from privacy_firewall import privacy_firewall


@pytest.fixture()
def analyze_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """TestClient whose backend returns valid STRICT-JSON action output."""
    import json as _json

    from backends.base import DescribeResult
    import server as srv

    class ActionBackend:
        async def describe_image(self, image_b64, prompt="", messages=None):
            action = {
                "action": "click",
                "target_id": "submit-btn",
                "value": None,
                "reasoning": "Identified submit button from structural map.",
            }
            return DescribeResult(
                text=_json.dumps(action), backend="mock", model="mock-1.0", latency_ms=1.2
            )

        def health(self):
            return {"backend": "mock", "model": "mock-1.0"}

    monkeypatch.setattr(srv, "_backend", ActionBackend())
    monkeypatch.setattr(srv, "_current_backend", lambda: srv._backend)
    return TestClient(srv.app)


def _solid_png_b64(size: tuple[int, int] = (8, 8), color: tuple[int, int, int] = (200, 200, 200)) -> str:
    img = Image.new("RGB", size, color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _payload(structural_map: list[dict], screenshot: str | None = None) -> dict:
    return {
        "screenshot_base64": screenshot or _solid_png_b64(),
        "structural_map": structural_map,
        "prompt": "Describe this screenshot.",
    }


def _clean_map() -> list[dict]:
    return [
        {"id": "a", "tag": "input", "value": "Username", "placeholder": None},
        {"id": "b", "tag": "input", "value": "", "placeholder": "Search", "aria_label": "Search the site"},
    ]


def test_analyze_clean_payload_returns_200(analyze_client: TestClient) -> None:
    resp = analyze_client.post("/analyze", json=_payload(_clean_map()))
    assert resp.status_code == 200
    body = resp.json()
    assert body["blocked"] is False
    assert body["backend"] == "mock"
    assert body["action"] == "click"
    assert body["target_id"] == "submit-btn"
    assert body["validation_failures"] == 0


def test_analyze_leaky_email_returns_400(client: TestClient) -> None:
    leaky = _clean_map() + [{"id": "c", "tag": "input", "value": "user@host.example"}]
    resp = client.post("/analyze", json=_payload(leaky))
    assert resp.status_code == 400
    body = resp.json()["detail"]
    assert body["blocked"] is True
    assert body["reason"] == "pii:email"
    assert "user@host.example" not in str(body)  # value never echoed back


def test_analyze_leaky_card_returns_400(client: TestClient) -> None:
    leaky = [{"id": "c", "tag": "input", "value": "4111111111111111"}]
    resp = client.post("/analyze", json=_payload(leaky))
    assert resp.status_code == 400
    assert resp.json()["detail"]["reason"] == "pii:card_number"


def test_analyze_face_leak_returns_400(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    import server as srv

    # Force the firewall to report a face violation regardless of screenshot content.
    monkeypatch.setattr(
        srv,
        "_run_firewall",
        lambda payload: (False, "face_detected"),
    )
    resp = client.post("/analyze", json=_payload(_clean_map()))
    assert resp.status_code == 400
    assert resp.json()["detail"]["reason"] == "face_detected"


def test_analyze_clean_after_real_firewall_via_mock_backend(analyze_client: TestClient) -> None:
    """End-to-end through the real firewall on a benign payload."""
    payload = _payload([{"id": "a", "tag": "input", "value": "", "placeholder": "Search"}])
    ok, reason = privacy_firewall(
        {"structural_map": [el for el in payload["structural_map"]], "screenshot_base64": payload["screenshot_base64"]}
    )
    assert ok is True
    assert reason is None
    resp = analyze_client.post("/analyze", json=payload)
    assert resp.status_code == 200


def test_analyze_retries_on_invalid_output(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Invalid first reply is corrected on retry; validation_failures is tracked."""
    import json as _json

    from backends.base import DescribeResult

    responses = iter(
        [
            DescribeResult(text="not json at all", backend="mock", model="mock-1.0", latency_ms=1.0),
            DescribeResult(
                text=_json.dumps(
                    {"action": "click", "target_id": "submit-btn", "value": None, "reasoning": "fixed"}
                ),
                backend="mock",
                model="mock-1.0",
                latency_ms=1.0,
            ),
        ]
    )

    class RetryBackend:
        async def describe_image(self, image_b64, prompt="", messages=None):
            return next(responses)

        def health(self):
            return {"backend": "mock", "model": "mock-1.0"}

    import server as srv

    monkeypatch.setattr(srv, "_backend", RetryBackend())
    monkeypatch.setattr(srv, "_current_backend", lambda: srv._backend)

    resp = client.post("/analyze", json=_payload(_clean_map()))
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "click"
    assert body["target_id"] == "submit-btn"
    assert body["validation_failures"] == 1


def test_analyze_reports_failure_after_exhausting_retries(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Persistently invalid replies exhaust retries and surface as null action."""
    from backends.base import DescribeResult

    bad = DescribeResult(text="still not json", backend="mock", model="mock-1.0", latency_ms=1.0)

    class AlwaysBadBackend:
        async def describe_image(self, image_b64, prompt="", messages=None):
            return bad

        def health(self):
            return {"backend": "mock", "model": "mock-1.0"}

    import server as srv

    monkeypatch.setattr(srv, "_backend", AlwaysBadBackend())
    monkeypatch.setattr(srv, "_current_backend", lambda: srv._backend)

    resp = client.post("/analyze", json=_payload(_clean_map()))
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] is None
    assert body["target_id"] is None
    assert body["validation_failures"] == 3  # MAX_RETRIES=2 → 3 attempts, all fail