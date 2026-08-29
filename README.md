# SecureLink

SecureLink is an early skeleton for a privacy-first browser agent: a Manifest V3 browser extension paired with a FastAPI server. The current repository is intentionally foundation-only and does not implement capture, redaction, model inference, transport, or action execution yet.

## Project Layout

- `extension/` - Manifest V3 browser extension built with TypeScript and Vite.
- `server/` - FastAPI application runnable with Uvicorn.
- `docs/` - Supporting project documentation.
- `browser_agent_architecture.md` - System architecture reference.
- `browser_agent_execution_plan.md` - Four-week execution plan.

## Extension

```bash
cd extension
npm install
npm run lint
npm run build
```

The production extension bundle is emitted to `extension/dist`.

## Server

```bash
cd server
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
python -m ruff check .
python -m compileall .
uvicorn main:app
```

The API starts at `http://127.0.0.1:8000`.

