"""conftest — shared fixtures for the test suite."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Return a TestClient with a canned mock backend injected."""
    from backends.base import DescribeResult, VisionBackend
    import server as srv

    class MockBackend(VisionBackend):
        async def describe_image(self, image_b64: str, prompt: str = "Describe this image.") -> DescribeResult:
            return DescribeResult(
                text=f"Mock sees a {len(image_b64)}-char image.",
                backend="mock",
                model="mock-1.0",
                latency_ms=1.2,
            )

        def health(self) -> dict:
            return {"backend": "mock", "model": "mock-1.0"}

    monkeypatch.setattr(srv, "_backend", MockBackend())
    monkeypatch.setattr(srv, "_current_backend", lambda: srv._backend)
    return TestClient(srv.app)
