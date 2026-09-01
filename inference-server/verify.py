#!/usr/bin/env python3
"""
verify.py — round-trip smoke test for both backends.

Usage:
    # Cloud backend (needs OPENAI_API_KEY in .env)
    python verify.py --backend cloud

    # Local Ollama backend (needs Ollama running + model pulled)
    python verify.py --backend local

    # Both in sequence
    python verify.py --backend both

If --backend is omitted the script reads MODEL_BACKEND from the environment.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import sys
from pathlib import Path
from io import BytesIO

# Load .env from the same directory as this script
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

# tiny 8×8 red PNG (literal bytes, no network needed)
_TINY_PNG = (
    b"\x89PNG\r\n\x1a\n"       # signature
    b"\x00\x00\x00\rIHDR"      # IHDR chunk start
    b"\x00\x00\x00\x08"        # width 8
    b"\x00\x00\x00\x08"        # height 8
    b"\x08\x02"                 # 8-bit RGB
    b"\x00\x00\x00"            # compression, filter, interlace
    b"\x00"                     # CRC placeholder area
    b"\xf2\x0f\xbc\xfb"        # (over-approx – not critical for OCR)
    b"\x00\x00\x00\x1aIDATx"
    b"\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N"
    b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    b"\x00\x00\x00\x00\x00\x00"
    b"\x70\x1a\x9d\x11"        # CRC
    b"\x00\x00\x00\x00IEND"
    b"\xaeB`\x82"
)


def make_tiny_b64() -> str:
    """Return a small base-64-encoded PNG (a few hundred bytes)."""
    return base64.b64encode(_TINY_PNG).decode()


async def _run_describe(backend_label: str, image_b64: str) -> None:
    """Call the /describe endpoint for a given backend."""
    from backends import get_backend

    backend = get_backend(backend_label)
    print(f"\n{'─' * 60}")
    print(f"  Backend : {backend_label}")
    print(f"  Model   : {backend.health()['model']}")
    print(f"{'─' * 60}")

    result = await backend.describe_image(image_b64, "Describe this image.")
    print(f"  Response: {result.text[:300]}")
    print(f"  Latency : {result.latency_ms:.0f} ms")
    print(f"  OK      : {'yes' if result.text else 'NO — empty response'}")


async def main(backend: str) -> None:
    image_b64 = make_tiny_b64()
    targets = ["local", "cloud"] if backend == "both" else [backend]

    for label in targets:
        try:
            await _run_describe(label, image_b64)
        except Exception as exc:
            print(f"\n  FAILED ({label}): {exc}", file=sys.stderr)

    print(f"\n{'=' * 60}")
    print("  Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Verify inference backends")
    parser.add_argument(
        "--backend",
        choices=["local", "cloud", "both"],
        default=os.getenv("MODEL_BACKEND", "cloud"),
        help="Which backend to test (default: MODEL_BACKEND env var)",
    )
    args = parser.parse_args()
    asyncio.run(main(args.backend))
