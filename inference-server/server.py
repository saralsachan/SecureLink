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
import logging
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

logger = logging.getLogger("securelink.server")

_backend: VisionBackend | None = None
_firewall_run = None  # deferred import so tests can monkeypatch
_session_store = None  # deferred import so tests can monkeypatch


def _current_backend() -> VisionBackend:
    """Lazily build the backend so the module imports without network/credentials."""
    global _backend
    if _backend is None:
        _backend = get_backend(BACKEND_CHOICE)
    return _backend


def _get_session_store():
    global _session_store
    if _session_store is None:
        from session_store import store as session_store

        _session_store = session_store
    return _session_store


def _run_firewall(payload: dict) -> tuple[bool, str | None]:
    """Run the privacy firewall, importing the module lazily so tests can stub it."""
    global _firewall_run
    if _firewall_run is None:
        from privacy_firewall import privacy_firewall

        _firewall_run = privacy_firewall
    return _firewall_run(payload)


def _run_firewall_timed(payload: dict) -> tuple[bool, str | None, float]:
    """Time the privacy firewall; returns (ok, reason, duration_ms)."""
    import time as _time

    start = _time.perf_counter()
    ok, reason = _run_firewall(payload)
    return ok, reason, (_time.perf_counter() - start) * 1000.0


# ── Prompted analysis (system+user prompt + strict-JSON validation) ─────────

MAX_ANALYZE_RETRIES = 2
_prompt_builder = None  # deferred import so tests can monkeypatch
_grounder = None  # deferred import so tests can monkeypatch


def _prompts():
    global _prompt_builder
    if _prompt_builder is None:
        from prompt_builder import (
            build_correction_prompt,
            build_prompt,
            validate_action_output,
        )

        _prompt_builder = (build_prompt, build_correction_prompt, validate_action_output)
    return _prompt_builder


def _ground():
    global _grounder
    if _grounder is None:
        from grounding import ground_action

        _grounder = ground_action
    return _grounder


async def _analyze_with_retry(
    backend: VisionBackend,
    screenshot_b64: str,
    structural_map_json: str,
    task: str,
    structural_map: list[dict] | None = None,
    history_context: str = "",
    timings: dict | None = None,
) -> tuple[str, dict | None, int]:
    """
    Run a prompted analysis with strict-JSON validation + grounding, and retry
    with correction.

    Returns (accepted_text, grounded_action_or_None, validation_failures, backend, model).
    When *timings* is supplied, VLM call and grounding durations are accumulated
    into ``timings["vlm_ms"]`` / ``timings["grounding_ms"]``.
    """
    build_prompt, build_correction, validate = _prompts()
    ground = _ground()
    system, user = build_prompt(
        screenshot_b64, structural_map_json, task, history_context=history_context
    )

    messages: list[dict] = [{"role": "system", "content": system}]
    validation_failures = 0
    accepted_text = ""
    backend_name = ""
    model_name = ""

    for attempt in range(MAX_ANALYZE_RETRIES + 1):
        turn_messages = messages + [{"role": "user", "content": user}]
        import time as _time

        vlm_start = _time.perf_counter()
        result = await backend.describe_image(
            screenshot_b64, messages=turn_messages
        )
        if timings is not None:
            timings["vlm_ms"] = timings.get("vlm_ms", 0.0) + (
                _time.perf_counter() - vlm_start
            ) * 1000.0

        accepted_text = result.text
        backend_name = result.backend
        model_name = result.model

        ok, parsed, error = validate(accepted_text)
        if ok:
            ground_start = _time.perf_counter()
            grounded = ground(parsed, structural_map or [])
            if timings is not None:
                timings["grounding_ms"] = timings.get("grounding_ms", 0.0) + (
                    _time.perf_counter() - ground_start
                ) * 1000.0
            if grounded.ok:
                return (
                    accepted_text,
                    grounded.to_schema_dict(),
                    validation_failures,
                    backend_name,
                    model_name,
                )
            # Schematically valid but not grounded: retry with corrected constraint.
            error = grounded.error or "unactionable target"
            ok = False

        validation_failures += 1
        if attempt >= MAX_ANALYZE_RETRIES:
            break
        # Append a correction turn so the model can fix its output.
        messages.append({"role": "user", "content": user})
        correction = build_correction(accepted_text, error)
        messages.append({"role": "assistant", "content": accepted_text})
        user = correction

    # Ran out of retries with no valid/grounded result.
    return accepted_text, None, validation_failures, backend_name, model_name

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
    inputType: str | None = None
    autocomplete: str | None = None
    bbox: dict | None = None
    hidden: bool | None = None
    display: str | None = None
    visibility: str | None = None
    contenteditable: str | None = None


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
    action: str | None = None
    target_id: str | None = None
    value: str | None = None
    reasoning: str | None = None
    requires_confirmation: bool | None = None
    validation_failures: int = 0
    timings: dict | None = None


class AgentStepRequest(BaseModel):
    session_id: str = Field(..., description="Per-tab session id from the extension")
    screenshot_base64: str = Field(
        ..., description="Base-64 screenshot (no data: prefix)"
    )
    structural_map: list[StructuralElement] = Field(
        default_factory=list,
        description="DOM structural map extracted by the extension",
    )
    task: str = Field(default="Activate agent", description="Multi-step task")
    history_n: int = Field(default=3, ge=0, le=20, description="Steps of history to send")


class AgentStepResponse(BaseModel):
    ok: bool
    action: dict | None = None
    step: int
    session_id: str
    history: list[dict] = Field(default_factory=list)
    message: str | None = None
    timings: dict | None = None


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
    """Analyze a screenshot + anonymized structural map, guarded by the firewall."""
    screenshot_b64 = _normalise_b64(req.screenshot_base64)
    payload = {
        "structural_map": [el.model_dump(exclude_none=True) for el in req.structural_map],
        "screenshot_base64": screenshot_b64,
    }

    ok, reason, firewall_ms = _run_firewall_timed(payload)
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

    import json as _json

    structural_map = [el.model_dump(exclude_none=True) for el in req.structural_map]
    structural_map_json = _json.dumps(structural_map)

    timings: dict = {"firewall_ms": firewall_ms, "vlm_ms": 0.0, "grounding_ms": 0.0}

    accepted_text, parsed, failures, backend_name, model_name = await _analyze_with_retry(
        _current_backend(),
        screenshot_b64,
        structural_map_json,
        req.prompt,
        structural_map=structural_map,
        timings=timings,
    )

    timings["total_ms"] = firewall_ms + timings["vlm_ms"] + timings["grounding_ms"]

    return AnalyzeResponse(
        blocked=False,
        text=accepted_text,
        backend=backend_name or None,
        model=model_name or None,
        action=(parsed or {}).get("action"),
        target_id=(parsed or {}).get("target_id"),
        value=(parsed or {}).get("value"),
        reasoning=(parsed or {}).get("reasoning"),
        requires_confirmation=(parsed or {}).get("requires_confirmation"),
        validation_failures=failures,
        timings=timings,
    )


@app.post("/agent/step", response_model=AgentStepResponse)
async def agent_step(req: AgentStepRequest) -> AgentStepResponse:
    """One step of a multi-step task, with per-session conversation history."""
    import json as _json

    screenshot_b64 = _normalise_b64(req.screenshot_base64)
    structural_map = [el.model_dump(exclude_none=True) for el in req.structural_map]

    # Privacy firewall: reject leaked PII before the request reaches a model.
    ok, reason, firewall_ms = _run_firewall_timed(
        {"structural_map": structural_map, "screenshot_base64": screenshot_b64}
    )
    if not ok:
        return AgentStepResponse(
            ok=False,
            step=0,
            session_id=req.session_id,
            message=f"blocked by privacy firewall ({reason})",
        )

    session_store = _get_session_store()
    session = session_store.get_or_create(req.session_id, req.task)

    # Combine full task text (earlier task + current follow-up instruction).
    history_context = session_store.format_history_context(req.session_id)

    structural_map_json = _json.dumps(structural_map)

    timings: dict = {"firewall_ms": firewall_ms, "vlm_ms": 0.0, "grounding_ms": 0.0}

    accepted_text, parsed, failures, backend_name, model_name = await _analyze_with_retry(
        _current_backend(),
        screenshot_b64,
        structural_map_json,
        req.task,
        structural_map=structural_map,
        history_context=history_context,
        timings=timings,
    )

    timings["total_ms"] = firewall_ms + timings["vlm_ms"] + timings["grounding_ms"]
    logger.info(
        "agent/step timing: %s",
        {k: round(v, 2) for k, v in timings.items()},
    )

    # Record the outcome so the next step sees this step's action + map.
    session_store.append(
        req.session_id,
        structural_map=structural_map,
        action=parsed,
    )

    step = len(session_store.history(req.session_id))

    if parsed is None:
        return AgentStepResponse(
            ok=False,
            step=step,
            session_id=req.session_id,
            history=session_store.history(req.session_id),
            message="model output could not be grounded after retries",
            timings=timings,
        )

    return AgentStepResponse(
        ok=True,
        action=parsed,
        step=step,
        session_id=req.session_id,
        history=session_store.history(req.session_id),
        timings=timings,
    )
