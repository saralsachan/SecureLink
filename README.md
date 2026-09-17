# SecureLink

A privacy-first browser agent for MV3 Chromium browsers (Edge/Chrome). Sensitive content — passwords, emails, card numbers, faces — never leaves the device unredacted. The popup gives you a live status indicator, a raw-vs-redacted screenshot review, an audit log of every redaction/action, and a **Local-only mode** that runs without a server using deterministic heuristics ("click the first submit button").

## Project layout

- `extension/` — MV3 extension (TypeScript + Vite). Load `extension/dist` unpacked.
- `inference-server/` — FastAPI agent server (`/agent/step`): privacy firewall, VLM reasoning, grounding.
- `browser_agent_architecture.md` — full system architecture reference.
- `browser_agent_execution_plan.md` — execution plan / milestone tracking.

## Architecture summary

See [browser_agent_architecture.md](browser_agent_architecture.md) for the detailed design.

```
User task
  └─ Extension (edge)               In-browser only, no network:
       ├─ Structural map (DOM)        full extraction on first step, delta sync after
       ├─ Sensitive-element detector  dual channel: DOM rules + local ViT (faces, OCR PII)
       ├─ Redaction engine            values → [REDACTED_*] tokens, mapped to the real DOM
       └─ Action executor             resolves tokens back, prompts to confirm sensitive actions
  └─ Server (automatic mode only)
       ├─ Privacy firewall            server-side re-check (structural PII, faces, card Luhn)
       ├─ VLM/LLM reasoning           OpenAI-compatible or local Ollama/MiniCPM-V backend
       └─ Grounding                   maps the chosen action onto an element in the map
  └─ Local-only mode                  skips the server entirely (deterministic heuristics)
```

Multi-step tasks keep a per-session history on the server; the extension performs one step per Run press.

## Setup

### 1. Extension

```bash
cd extension
npm install
npm run build            # emits extension/dist
```

Vision models are already bundled in `extension/models/` (MobileViT, BlazeFace, YuNet).

**Load unpacked:** open `edge://extensions` (or `chrome://extensions`) → enable **Developer mode** → **Load unpacked** → select `extension/dist`. Pin the SecureLink icon.

### 2. Server (automatic mode only — not needed for Local-only)

```bash
cd inference-server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt      # Windows
# macOS/Linux: source .venv/bin/activate && pip install -r requirements.txt

cp .env.example .env                                # then edit your keys
.venv\Scripts\python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Check it with `GET http://127.0.0.1:8000/health`. The extension calls `http://localhost:8000/agent/step` (hard-coded in `extension/src/content.ts`).

## Environment variables

Defined in `inference-server/.env` (or your shell):

| Variable | Default | Purpose |
|---|---|---|
| `MODEL_BACKEND` | `cloud` | `cloud` → OpenAI-compatible API; `local` → Ollama |
| `OPENAI_API_KEY` | — | Cloud backend only |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | Any `/v1` endpoint (Azure/OpenRouter) |
| `OPENAI_MODEL` | `gpt-4o` | Vision-capable model |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local backend only |
| `OLLAMA_MODEL` | `minicpm-v` | Local backend only |
| `HOST` / `PORT` | `0.0.0.0` / `8000` | Server bind address |

No env vars are required for the extension or for Local-only mode.

## Run the QA test page

The page shows which elements the agent can see and offers an editable task to drive:

```bash
python -m http.server 3000 --directory extension     # keep server:8000 free!
```

1. Open `http://127.0.0.1:3000/test.html` — a signup form (name, email), a **Create Account** submit button, a standalone button, and hidden/offscreen controls.
2. Click the SecureLink icon → the popup opens.
3. Click **Run**:
   - **Automatic** (server up): the task is reasoned over VLM and grounded onto the page; expect a **confirmation dialog** for the click, then "Action executed".
   - **Local-only** (no server): toggle **Local-only mode** and Run — the agent clicks the first submit button ("Create Account") deterministically.
4. Watch the **Screenshot review** (raw vs redacted side by side), the **Audit log** (every redaction and action, timestamped), and the live status indicator.

## Tests

```bash
# Extension: 115+ unit/integration tests + typecheck + build
cd extension && npm run lint && npm test

# Server: 71 tests (backend mocked, runs offline)
cd inference-server && .venv\Scripts\python -m pytest

# End-to-end pipeline scenarios (jsdom, mock server)
cd extension && node --disable-warning=ExperimentalWarning scripts/pipeline-scenarios.mts
```

## Known limitations

- **One step per activation** — press Run for each step; the server holds cross-step history, but there is no autonomous loop yet.
- **Automatic mode needs a reachable VLM backend** — without an API key or Ollama running, server steps fail gracefully (the popup shows the error) and the screenshot still transmits to `localhost:8000` in dev. Local-only mode avoids this entirely.
- **Cross-origin iframes are not descended into** — they are flagged and their contents are only visible through the screenshot path.
- **Audit log & perf replay use `chrome.storage.session`** — cleared when the browser session ends, by design (no sensitive persistence).
- **Navigation/click confirmations require a human click in the page's dialog** — automation is deliberately gated on sensitive actions.
- **Face detection is heuristic** — Haar cascade (server) + BlazeFace/ViT (client); overlapping faces are deduped by IoU, but detection quality varies with angle/lighting.
- **Demo content only** — the QA page is a static fixture; it exercises the pipeline, not a live third-party site.