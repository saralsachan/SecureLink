"""
Privacy firewall for SecureLink.

Independently re-checks an incoming payload (structural_map + screenshot) for
potential PII leaks BEFORE it is forwarded to a remote reasoning model.

    privacy_firewall(payload) -> (ok: bool, reason: str | None)

    * payload["structural_map"]  list of {id, tag, value, placeholder, aria_label, ...}
    * payload["screenshot_base64"]   base-64 PNG (or other image) screenshot

The firewall performs two independent checks:
  1. Server-side face detection on the screenshot (OpenCV Haar cascade).
  2. A regex scan over any text fields present in the structural map
     (email / phone / SSN / Luhn-valid credit card).

The *reason* strings returned on a violation are sanitised *categories* only
(e.g. ``"pii:email"``, ``"face_detected"``). Sensitive values are **never**
included in the reason or in any log lines.
"""

from __future__ import annotations

import base64
import logging
import re
from pathlib import Path
from typing import Callable, Sequence

# ── Logging (never logs raw PII values) ──────────────────────────────────────

logger = logging.getLogger("securelink.privacy")

# ── Face detection (OpenCV Haar cascade) ─────────────────────────────────────

_DEFAULT_CASCADE = (
    Path(__file__).resolve().parent / "data" / "haarcascade_frontalface_default.xml"
)


def _bundle_cascade_path() -> Path:
    """Return a usable Haar cascade path (vendored copy, else package copy)."""
    if _DEFAULT_CASCADE.exists():
        return _DEFAULT_CASCADE
    # Fall back to the cascade shipped with opencv-python (4.x).
    try:
        import cv2

        p = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        if p.exists():
            return p
    except Exception:
        pass
    return _DEFAULT_CASCADE


def _default_face_detector(bgr: object, raw: bytes) -> Sequence:
    """
    Detect faces in a decoded BGR image using OpenCV's Haar cascade.

    Returns the sequence of face rectangles (possibly empty). Loaded lazily.
    """
    import cv2

    cascade_path = _bundle_cascade_path()
    cascade = cv2.CascadeClassifier(str(cascade_path))
    if cascade.empty():
        logger.warning("privacy: face cascade could not be loaded; face check skipped")
        return []

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(20, 20))
    return faces  # Nx4 array


# ── PII regex scan ───────────────────────────────────────────────────────────

# These mirror the extension's pii-detection.ts patterns.
_EMAIL_PATTERN = r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"
_PHONE_PATTERN = (
    r"(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\d-])"
)
_SSN_PATTERN = r"\b\d{3}-\d{2}-\d{4}\b"
_CARD_DIGITS_PATTERN = r"\b(?:\d[ \u2011-]?){13,19}\b"

_TEXT_FIELD_KEYS = ("value", "placeholder", "aria_label", "ariaLabel")


def _luhn_valid(digits: str) -> bool:
    if not digits.isdigit():
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        value = int(ch)
        if i % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def _text_fields(element: dict) -> list[str]:
    """The text-bearing fields of a structural-map element (any present)."""
    out: list[str] = []
    for key in _TEXT_FIELD_KEYS:
        value = element.get(key)
        if isinstance(value, str) and value:
            out.append(value)
    return out


def _scan_text(text: str) -> str | None:
    """
    Return the first PII category matched in *text*, or None if clean.

    Categories returned (never the raw value): email, ssn, card_number, phone.
    Card numbers are Luhn-validated (strong signal) and are evaluated before
    the looser phone rule so a long digit run is not misreported as a phone.
    """
    if re.search(_EMAIL_PATTERN, text):
        return "email"

    if re.search(_SSN_PATTERN, text):
        return "ssn"

    for m in re.finditer(_CARD_DIGITS_PATTERN, text):
        digits = re.sub(r"\D", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn_valid(digits):
            return "card_number"

    phone_match = re.search(_PHONE_PATTERN, text)
    if phone_match:
        digits = re.sub(r"\D", "", phone_match.group(0))
        if 10 <= len(digits) <= 15:
            return "phone"

    return None


def _structural_pii_category(structural_map: Sequence[dict]) -> str | None:
    """Return the first PII category found across the structural map, or None."""
    for element in structural_map:
        for text in _text_fields(element):
            category = _scan_text(text)
            if category is not None:
                return category
    return None


# ── Face detection plumbing ──────────────────────────────────────────────────

def _face_violation(
    screenshot_b64: str, face_detector: Callable[[object, bytes], Sequence] | None
) -> str | None:
    """Return "face_detected", "unreadable_screenshot", or None (no face / none)."""
    if not screenshot_b64:
        return None  # no screenshot → nothing to check on the image side

    try:
        raw = base64.b64decode(screenshot_b64)
    except Exception:
        logger.warning("privacy: could not decode screenshot base-64")
        return "unreadable_screenshot"

    import cv2
    import numpy as np

    buf = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if bgr is None:
        logger.warning("privacy: screenshot could not be decoded as an image")
        return "unreadable_screenshot"

    detector = face_detector or _default_face_detector
    try:
        faces = detector(bgr, raw) or []
    except Exception:
        logger.warning("privacy: face detector errored; skipping face check")
        return None

    if len(faces) > 0:
        return "face_detected"

    return None


# ── Public firewall API ──────────────────────────────────────────────────────

def privacy_firewall(
    payload: dict,
    face_detector: Callable[[object, bytes], Sequence] | None = None,
) -> tuple[bool, str | None]:
    """
    Re-check ``payload`` for leaked PII before it reaches the reasoning model.

    Returns ``(True, None)`` when clean, or ``(False, sanitised_reason)`` when a
    violation is found. ``face_detector`` is injectable for tests and defaults
    to the OpenCV Haar-cascade implementation.

    The reason is a *category*, never the leaked value.
    """
    structural_map = payload.get("structural_map") or []
    screenshot_b64 = payload.get("screenshot_base64") or ""

    # 1. Face-detection check (server-side CV).
    face_category = _face_violation(screenshot_b64, face_detector)
    if face_category is not None:
        logger.warning("privacy: violated (%s)", face_category)
        return False, face_category

    # 2. Structural-map PII regex scan.
    pii_category = _structural_pii_category(structural_map)
    if pii_category is not None:
        logger.warning("privacy: violated (pii:%s)", pii_category)
        return False, f"pii:{pii_category}"

    logger.info("privacy: payload deemed clean")
    return True, None