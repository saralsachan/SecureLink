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
        self,
        image_b64: str,
        prompt: str = "Describe this image.",
        messages: list[dict] | None = None,
    ) -> DescribeResult:
        data_url = f"data:image/png;base64,{image_b64}"

        if messages:
            # Messages may include a leading system role; attach the image to the
            # last user message.
            out_messages: list[dict] = []
            for msg in messages:
                if msg.get("role") == "user":
                    out_messages.append(
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": msg.get("content", "")},
                                {"type": "image_url", "image_url": {"url": data_url}},
                            ],
                        }
                    )
                else:
                    out_messages.append(
                        {"role": "system", "content": msg.get("content", "")}
                    )
        else:
            out_messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ]

        t0 = time.perf_counter()
        response = await self._client.chat.completions.create(
            model=self._model,
            messages=out_messages,
            max_tokens=512,
        )
        latency = (time.perf_counter() - t0) * 1000

        text = response.choices[0].message.content or ""

        return DescribeResult(
            text=text, backend="cloud", model=self._model, latency_ms=round(latency, 1)
        )

    def health(self) -> dict:
        return {"backend": "cloud", "model": self._model}
