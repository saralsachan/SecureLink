"""
SecureLink Inference Server
───────────────────────────
Vision-language endpoint backed by either a local Ollama model or a
cloud-hosted OpenAI-compatible API.

    MODEL_BACKEND=local  → Ollama / MiniCPM-V
    MODEL_BACKEND=cloud  → OpenAI-compatible endpoint

Run:
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import base64
import os
import re
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, HttpUrl

# ── Load .env ────────────────────────────────────────────────────────────────

load_dotenv(Path(__file__).parent / ".env")

BACKEND_CHOICE = os.getenv("MODEL_BACKEND", "cloud")

# ── Import backend (deferred so tests can monkeypatch) ───────────────────────

from backends import get_backend
from backends.base import VisionBackend

_backend: VisionBackend | None = None
_firewall_run = None  # deferred import so tests can monkeypatch


def _current_backend() -> VisionBackend:
    """Lazily build the backend so the module imports without network/credentials."""
    global _backend
    if _backend is None:
        _backend = get_backend(BACKEND_CHOICE)
    return _backend


def _run_firewall(payload: dict) -> tuple[bool, str | None]:
    """Run the privacy firewall, importing the module lazily so tests can stub it."""
    global _firewall_run
    if _firewall_run is None:
        from privacy_firewall import privacy_firewall

        _firewall_run = privacy_firewall
    return _firewall_run(payload)

# ── FastAPI app ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="SecureLink Inference Server",
    version="0.1.0",
    description="Vision-language describe endpoint with local/cloud fallback.",
)


# ── Schemas ──────────────────────────────────────────────────────────────────

class DescribeRequest(BaseModel):
    image_url: HttpUrl | None = Field(
        None, description="Public URL of the image"
    )
    image_base64: str | None = Field(
        None, description="Raw base-64 string (no data: prefix)"
    )
    prompt: str = "Describe this image."


class DescribeResponse(BaseModel):
    text: str
    backend: str
    model: str
    latency_ms: float


class HealthResponse(BaseModel):
    status: str
    backend: str
    active_model: str


class StructuralElement(BaseModel):
    id: str
    tag: str = "input"
    role: str | None = None
    value: str | None = None
    placeholder: str | None = None
    aria_label: str | None = None
    ariaLabel: str | None = None
    input_type: str | None = None
    autocomplete: str | None = None


class AnalyzeRequest(BaseModel):
    screenshot_base64: str = Field(
        ..., description="Base-64 screenshot (no data: prefix)"
    )
    structural_map: list[StructuralElement] = Field(
        default_factory=list,
        description="DOM structural map extracted by the extension",
    )
    prompt: str = "Describe this screenshot."


class AnalyzeResponse(BaseModel):
    blocked: bool
    reason: str | None = None
    text: str | None = None
    backend: str | None = None
    model: str | None = None


# ── Helpers ──────────────────────────────────────────────────────────────────

_DATA_URL_RE = re.compile(r"^data:image/\w+;base64,")


async def _fetch_and_encode(url: str) -> str:
    """Download an image from *url* and return raw base-64."""
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
    return base64.b64encode(resp.content).decode()


def _normalise_b64(raw: str) -> str:
    """Strip any ``data:image/…;base64,`` prefix the caller may have included."""
    return _DATA_URL_RE.sub("", raw)


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    info = _current_backend().health()
    return HealthResponse(
        status="ok",
        backend=info["backend"],
        active_model=info["model"],
    )


@app.post("/describe", response_model=DescribeResponse)
async def describe(req: DescribeRequest) -> DescribeResponse:
    if not req.image_url and not req.image_base64:
        raise HTTPException(
            status_code=422,
            detail="Provide either image_url or image_base64.",
        )

    if req.image_url:
        image_b64 = await _fetch_and_encode(str(req.image_url))
    else:
        image_b64 = _normalise_b64(req.image_base64)

    result = await _current_backend().describe_image(image_b64, req.prompt)
    return DescribeResponse(
        text=result.text,
        backend=result.backend,
        model=result.model,
        latency_ms=result.latency_ms,
    )


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    """Analyze a screenshot + structural map, guarded by the privacy firewall."""
    payload = {
        "structural_map": [el.model_dump() for el in req.structural_map],
        "screenshot_base64": _normalise_b64(req.screenshot_base64),
    }

    ok, reason = _run_firewall(payload)
    if not ok:
        # reason is a sanitised category, never the leaked value.
        raise HTTPException(
            status_code=400,
            detail={
                "blocked": True,
                "reason": reason or "privacy_violation",
                "message": "Request blocked by the privacy firewall.",
            },
        )

    result = await _current_backend().describe_image(
        _normalise_b64(req.screenshot_base64), req.prompt
    )
    return AnalyzeResponse(
        blocked=False,
        text=result.text,
        backend=result.backend,
        model=result.model,
    )
