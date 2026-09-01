from .base import VisionBackend, DescribeResult
from .ollama_backend import OllamaBackend
from .openai_backend import OpenAIBackend


def get_backend(backend: str = "cloud") -> VisionBackend:
    """Factory: returns OllamaBackend or OpenAIBackend based on the ``backend`` arg."""
    backends = {
        "local": OllamaBackend,
        "cloud": OpenAIBackend,
    }
    cls = backends.get(backend)
    if cls is None:
        raise ValueError(
            f"Unknown backend {backend!r}. Choose from: {', '.join(backends)}"
        )
    return cls()


__all__ = [
    "VisionBackend",
    "DescribeResult",
    "OllamaBackend",
    "OpenAIBackend",
    "get_backend",
]
