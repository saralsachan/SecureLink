"""Local inference via Ollama (MiniCPM-V / LLaVA)."""

from __future__ import annotations

import base64
import os
import time

import httpx

from .base import DescribeResult, VisionBackend

DEFAULT_MODEL = "minicpm-v"


class OllamaBackend(VisionBackend):
    def __init__(self) -> None:
        self._base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self._model = os.getenv("OLLAMA_MODEL", DEFAULT_MODEL)

    async def describe_image(
        self, image_b64: str, prompt: str = "Describe this image."
    ) -> DescribeResult:
        url = f"{self._base_url}/api/chat"
        payload = {
            "model": self._model,
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                    "images": [image_b64],
                }
            ],
            "stream": False,
        }

        t0 = time.perf_counter()
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
        latency = (time.perf_counter() - t0) * 1000

        data = resp.json()
        text = data.get("message", {}).get("content", "")

        return DescribeResult(
            text=text, backend="local", model=self._model, latency_ms=round(latency, 1)
        )

    def health(self) -> dict:
        return {"backend": "local", "model": self._model, "base_url": self._base_url}
