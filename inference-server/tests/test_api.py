"""Unit tests for the /health and /describe endpoints (mocked backend)."""

from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient


def test_health_returns_ok(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["backend"] == "mock"


def test_describe_with_base64(client: TestClient) -> None:
    tiny = base64.b64encode(b"\x89PNG fake image data").decode()
    resp = client.post("/describe", json={"image_base64": tiny})
    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "mock"
    assert "Mock sees" in body["text"]


def test_describe_with_custom_prompt(client: TestClient) -> None:
    tiny = base64.b64encode(b"\x89PNG fake image data").decode()
    resp = client.post("/describe", json={"image_base64": tiny, "prompt": "What color?"})
    assert resp.status_code == 200
    assert "Mock sees" in resp.json()["text"]


def test_describe_rejects_empty_input(client: TestClient) -> None:
    resp = client.post("/describe", json={"prompt": "hello"})
    assert resp.status_code == 422


def test_describe_strips_data_url_prefix(client: TestClient) -> None:
    raw = base64.b64encode(b"\x89PNG data").decode()
    prefixed = f"data:image/png;base64,{raw}"
    resp = client.post("/describe", json={"image_base64": prefixed})
    assert resp.status_code == 200
    assert "Mock sees" in resp.json()["text"]
