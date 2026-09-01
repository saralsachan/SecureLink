"""Tests for the /analyze endpoint guarded by the privacy firewall."""

from __future__ import annotations

import base64
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from privacy_firewall import privacy_firewall


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


def test_analyze_clean_payload_returns_200(client: TestClient) -> None:
    resp = client.post("/analyze", json=_payload(_clean_map()))
    assert resp.status_code == 200
    body = resp.json()
    assert body["blocked"] is False
    assert body["backend"] == "mock"
    assert "Mock sees" in body["text"]


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


def test_analyze_clean_after_real_firewall_via_mock_backend(client: TestClient) -> None:
    """End-to-end through the real firewall on a benign payload."""
    payload = _payload([{"id": "a", "tag": "input", "value": "", "placeholder": "Search"}])
    ok, reason = privacy_firewall(
        {"structural_map": [el for el in payload["structural_map"]], "screenshot_base64": payload["screenshot_base64"]}
    )
    assert ok is True
    assert reason is None
    resp = client.post("/analyze", json=payload)
    assert resp.status_code == 200