"""Cloud inference via any OpenAI-compatible API (OpenAI, Azure, OpenRouter …)."""

from __future__ import annotations

import base64
import os
import time

from openai import AsyncOpenAI

from .base import DescribeResult, VisionBackend


class OpenAIBackend(VisionBackend):
    def __init__(self) -> None:
        api_key = os.getenv("OPENAI_API_KEY", "")
        api_base = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
        self._model = os.getenv("OPENAI_MODEL", "gpt-4o")
        self._client = AsyncOpenAI(api_key=api_key, base_url=api_base)

    async def describe_image(
        self, image_b64: str, prompt: str = "Describe this image."
    ) -> DescribeResult:
        data_url = f"data:image/png;base64,{image_b64}"

        t0 = time.perf_counter()
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url},
                        },
                    ],
                }
            ],
            max_tokens=512,
        )
        latency = (time.perf_counter() - t0) * 1000

        text = response.choices[0].message.content or ""

        return DescribeResult(
            text=text, backend="cloud", model=self._model, latency_ms=round(latency, 1)
        )

    def health(self) -> dict:
        return {"backend": "cloud", "model": self._model}
