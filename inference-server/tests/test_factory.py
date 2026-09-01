"""Test the backend factory routing and base64 normalisation."""

from __future__ import annotations

import pytest

from backends import get_backend
from backends.ollama_backend import OllamaBackend
from backends.openai_backend import OpenAIBackend
from server import _normalise_b64


def test_factory_returns_ollama_for_local(monkeypatch: pytest.MonkeyPatch) -> None:
    backend = get_backend("local")
    assert isinstance(backend, OllamaBackend)


def test_factory_returns_openai_for_cloud(monkeypatch: pytest.MonkeyPatch) -> None:
    # give a dummy key so the client constructs without raising
    monkeypatch.setenv("OPENAI_API_KEY", "dummy")
    backend = get_backend("cloud")
    assert isinstance(backend, OpenAIBackend)


def test_factory_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        get_backend("nope")


def test_normalise_b64_strips_prefix() -> None:
    assert _normalise_b64("data:image/png;base64,abc") == "abc"
    assert _normalise_b64("abc") == "abc"