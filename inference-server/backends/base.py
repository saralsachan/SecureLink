"""Abstract base for vision-inference backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from pydantic import BaseModel


class DescribeResult(BaseModel):
    text: str
    backend: str
    model: str
    latency_ms: float


class VisionBackend(ABC):
    """Every backend implements ``describe_image``."""

    @abstractmethod
    async def describe_image(
        self, image_b64: str, prompt: str = "Describe this image."
    ) -> DescribeResult:
        """Send a base-64-encoded image + prompt to the model."""
        ...

    @abstractmethod
    def health(self) -> dict:
        """Return backend metadata (name, model, status)."""
        ...
