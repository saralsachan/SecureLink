"""Privacy firewall tests: clean vs. intentionally leaky payloads."""

from __future__ import annotations

import base64
from io import BytesIO

import pytest
from PIL import Image

from privacy_firewall import privacy_firewall


def _solid_png_b64(size: tuple[int, int] = (8, 8), color: tuple[int, int, int] = (200, 200, 200)) -> str:
    img = Image.new("RGB", size, color)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _node(**fields) -> dict:
    base = {
        "id": "n1",
        "tag": "input",
        "role": "textbox",
        "value": None,
        "placeholder": None,
        "aria_label": None,
    }
    base.update(fields)
    return base


# ── Clean payload ────────────────────────────────────────────────────────────

def test_clean_payload_passes() -> None:
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [
            _node(id="u", value=""),
            _node(id="p", placeholder="Username"),
            _node(id="x", aria_label="Search"),
        ],
    }
    ok, reason = privacy_firewall(payload)
    assert ok is True
    assert reason is None


def test_clean_payload_uses_no_face_detector() -> None:
    """A blank screenshot with no faces + benign text is clean."""
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(value="Welcome back"), _node(placeholder="City")],
    }
    ok, reason = privacy_firewall(payload)
    assert ok is True
    assert reason is None


def test_no_screenshot_still_validates_text() -> None:
    payload = {"screenshot_base64": "", "structural_map": [_node(value="hello world")]}
    ok, reason = privacy_firewall(payload)
    assert ok is True
    assert reason is None


# ── Leaky structural map (PII regex) ─────────────────────────────────────────

def test_leaky_email_in_value() -> None:
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(value="Contact me at john.doe@acme.com soon")],
    }
    ok, reason = privacy_firewall(payload)
    assert ok is False
    assert reason == "pii:email"


def test_leaky_ssn_in_placeholder() -> None:
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(placeholder="123-45-6789")],
    }
    ok, reason = privacy_firewall(payload)
    assert ok is False
    assert reason == "pii:ssn"


def test_leaky_luhn_card_in_aria_label() -> None:
    # 4111 1111 1111 1111 is a Luhn-valid Visa test number.
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(aria_label="My card 4111111111111111")],
    }
    ok, reason = privacy_firewall(payload)
    assert ok is False
    assert reason == "pii:card_number"


def test_leaky_phone_in_value() -> None:
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(value="(555) 123-4567")],
    }
    ok, reason = privacy_firewall(payload)
    assert ok is False
    assert reason == "pii:phone"


def test_reason_never_contains_sensitive_value() -> None:
    secret_email = "victim.so@secret.example"
    payload = {"screenshot_base64": "", "structural_map": [_node(value=secret_email)]}
    ok, reason = privacy_firewall(payload)
    assert ok is False
    assert secret_email not in (reason or "")


# ── Leaky screenshot (face detection) ────────────────────────────────────────

def test_face_detection_violation() -> None:
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(value="clean text")],
    }
    fake_detector = lambda bgr, raw: [(10, 10, 50, 50)]  # one "face" rect
    ok, reason = privacy_firewall(payload, face_detector=fake_detector)
    assert ok is False
    assert reason == "face_detected"


def test_no_face_detection_with_fake_detector() -> None:
    payload = {
        "screenshot_base64": _solid_png_b64(),
        "structural_map": [_node(value="clean text")],
    }
    fake_detector = lambda bgr, raw: []  # clean → no faces
    ok, reason = privacy_firewall(payload, face_detector=fake_detector)
    assert ok is True
    assert reason is None


# ── Edge cases ───────────────────────────────────────────────────────────────

def test_unreadable_screenshot_is_fail_closed() -> None:
    payload = {"screenshot_base64": "not-valid-base64!!!", "structural_map": []}
    ok, reason = privacy_firewall(payload)
    assert ok is False
    assert reason == "unreadable_screenshot"


def test_nonnumeric_card_is_not_card_violation() -> None:
    # 4111111111111112 is 16 digits but fails Luhn → not a valid card number,
    # and as a contiguous digit run it is not reported as a phone either.
    payload = {"screenshot_base64": _solid_png_b64(), "structural_map": [_node(value="4111111111111112")]}
    ok, reason = privacy_firewall(payload)
    assert ok is True
    assert reason is None


def test_structural_map_absent_is_clean_for_text() -> None:
    payload = {"screenshot_base64": _solid_png_b64()}
    ok, reason = privacy_firewall(payload)
    assert ok is True
    assert reason is None