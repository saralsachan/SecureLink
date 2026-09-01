# SecureLink Inference Server

Vision-language "describe the image" HTTP endpoint used by the SecureLink
FastAPI server. It can route to a **local** model (Ollama / MiniCPM-V) or a
**cloud** OpenAI-compatible API, switched by a single environment variable.

## Architecture

```
inference-server/
├── backends/
│   ├── __init__.py        # get_backend() factory (local|cloud)
│   ├── base.py            # VisionBackend ABC + DescribeResult model
│   ├── ollama_backend.py  # local Ollama / MiniCPM-V
│   └── openai_backend.py  # any OpenAI-compatible API
├── server.py              # FastAPI app (/health, /describe)
├── verify.py              # standalone round-trip smoke test
├── tests/                 # pytest suite (backend mocked)
├── requirements.txt
└── .env.example
```

## Setup

```bash
cd inference-server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt     # Windows
# or: source .venv/bin/activate && pip install -r requirements.txt

cp .env.example .env       # then edit your keys
```

## Running

```bash
.venv\Scripts\python -m uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Point `MODEL_BACKEND` to your preferred backend in `.env` (or the shell env):

| Value    | Backend                       | Required env                         |
|----------|-------------------------------|--------------------------------------|
| `local`  | Ollama / MiniCPM-V            | `OLLAMA_BASE_URL`, `OLLAMA_MODEL`    |
| `cloud`  | OpenAI-compatible             | `OPENAI_API_KEY`, `OPENAI_MODEL`     |

### Local (Ollama / MiniCPM-V)

```bash
ollama pull minicpm-v           # ~13 GB
MODEL_BACKEND=local              # in .env
```

### Cloud (OpenAI-compatible)

Works with OpenAI, Azure OpenAI, OpenRouter, or any `/v1` endpoint:

```dotenv
MODEL_BACKEND=cloud
OPENAI_API_KEY=sk-...
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

## API

### `POST /describe`

```json
{
  "image_url": "https://example.com/photo.png",
  "prompt": "Describe this image."
}
```

**or** base-64 (a `data:image/...;base64,` prefix is auto-stripped):

```json
{
  "image_base64": "iVBORw0KGgo...",
  "prompt": "What is in this picture?"
}
```

Response:

```json
{
  "text": "A red 8x8 pixel square.",
  "backend": "cloud",
  "model": "gpt-4o",
  "latency_ms": 512.3
}
```

### `GET /health`

```json
{ "status": "ok", "backend": "cloud", "active_model": "gpt-4o" }
```

## Verification

The `verify.py` script drives a real round-trip against whichever backend is
chosen, using a tiny self-contained PNG (no network download needed).

```bash
.venv\Scripts\python verify.py --backend cloud
.venv\Scripts\python verify.py --backend local   # requires Ollama running
.venv\Scripts\python verify.py --backend both     # both in sequence
```

## Tests

```bash
.venv\Scripts\python -m pytest                     # requires pytest + httpx installed
```

The test suite injects a mock backend (see `tests/conftest.py`), so it runs
fully offline — no real model or API key required.