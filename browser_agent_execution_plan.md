# 4-Week Execution Plan
### On-Device Visual Perception for Lightweight Browser Agents

Team assumption: 4–5 people, split roughly as: 1 extension/frontend dev, 1 ML/CV engineer (client models), 1 backend/server + VLM integration, 1 full-stack/integration + demo, 1 floating (docs/testing/PM). Adjust if your team is smaller — checkpoints stay the same, just compress roles.

---

## Week 1 — Foundations & Skeleton (Days 1–7)

**Goal:** Every component exists in the dumbest possible working form, end-to-end, with no ML yet.

| Day | Task |
|---|---|
| 1 | Finalize scope: pick 1–2 concrete demo tasks (e.g., "fill a signup form," "summarize a page and click a button"). Lock tech stack from architecture doc. Set up repo, CI, project board. |
| 2 | Scaffold browser extension (Manifest V3): content script + background script + popup UI. Get it injecting into a page and reading the DOM tree. |
| 3 | Build the **structural map extractor**: DOM → JSON `{id, tag, role, bbox, inputType}` for visible elements. Test on 2–3 real websites. |
| 4 | Scaffold server (FastAPI/Node): basic API Gateway endpoint that accepts JSON and echoes a hardcoded action back. |
| 5 | Wire client ↔ server over HTTPS/WebSocket with the dummy payload. Confirm round trip: capture → send → receive fake action → execute a `click`/`scroll` via synthetic events. |
| 6 | Add screen capture (canvas snapshot of viewport) alongside the structural map. |
| 7 | **Checkpoint 1 review** (see below). Freeze scope for Week 2 if things are on track; cut features if not. |

### ✅ Checkpoint 1 (End of Day 7): "Dumb Pipeline Works"
- [ ] Extension installed and running on Chrome (Firefox stretch goal for later).
- [ ] Client captures DOM structural map + screenshot on demand.
- [ ] Client sends payload to server and receives a JSON action.
- [ ] Client executes at least one action type (click or scroll) from server response.
- [ ] No ML models involved yet — this is pure plumbing.
- **Exit criterion:** you can demo "click a hardcoded button" end-to-end, unredacted, unintelligent.

---

## Week 2 — Local Perception & Redaction (Days 8–14)

**Goal:** Real on-device ML: perception model running locally, sensitive elements detected and redacted before anything is sent.

| Day | Task |
|---|---|
| 8 | Pick and export local models: lightweight ViT (MobileViT/TinyViT) to ONNX; BlazeFace/YuNet for faces; OCR (Tesseract.js) for text. Benchmark raw ONNX Runtime Web load times. |
| 9 | Integrate ONNX Runtime Web with WebGPU (WASM fallback) into a Web Worker. Get the ViT model running inference on a captured frame, even if output isn't used yet. |
| 10 | Implement DOM-semantic sensitive detector: regex/attribute rules for password fields, emails, card numbers, `autocomplete` attributes. |
| 11 | Implement visual sensitive detector: run face detection + OCR on canvas frame, extract bounding boxes, classify PII via regex/NER on OCR text. |
| 12 | Build the **redaction engine**: blur/black-box on canvas for visual hits; token substitution for DOM text hits. Build the local redaction map (ID ↔ real value), kept client-side only. |
| 13 | Add the **self-verification pass**: re-scan redacted frame, confirm no residual PII before allowing send. Add fail-closed behavior. |
| 14 | **Checkpoint 2 review.** |

### ✅ Checkpoint 2 (End of Day 14): "Private by Construction"
- [ ] Local ViT model runs in-browser via WebGPU (with WASM fallback tested).
- [ ] Faces, passwords, emails, and at least one more PII type are detected automatically.
- [ ] Redacted screenshot visibly blurs/masks sensitive regions — demoable side-by-side (raw vs. redacted).
- [ ] Redacted structural map replaces sensitive text with tokens.
- [ ] Nothing unredacted ever leaves the browser (verify with network tab inspection).
- **Exit criterion:** you can show a judge a page with a face + password field, and prove via devtools that only redacted data hits the wire.

---

## Week 3 — Server Reasoning & Grounding (Days 15–21)

**Goal:** Replace the dummy server logic with a real VLM/LLM that reasons over sanitized input and returns grounded, executable actions.

| Day | Task |
|---|---|
| 15 | Stand up chosen open-weight model (Qwen2-VL / MiniCPM-V / LLaVA-NeXT for vision, or Llama-3/Mistral for text-only steps) via API or local inference server (Ollama/vLLM). |
| 16 | Build the server-side **privacy firewall**: a secondary classifier/heuristic that re-checks incoming payloads for residual PII before they reach the reasoning model. |
| 17 | Build prompt templates: feed redacted screenshot + anonymized structural map + task instruction to the model; get it to output semantic intent. |
| 18 | Build the **grounding module**: map model's semantic output back to real element IDs from the structural map; validate the target exists/is interactive. |
| 19 | Standardize the **Action Schema** (JSON) end-to-end; update client's Action Executor to handle richer actions (`type`, `navigate`, multi-step sequences). |
| 20 | Session/context manager: multi-turn task state so the agent can do multi-step flows (fill 3 fields, then submit), not just single actions. |
| 21 | **Checkpoint 3 review.** |

### ✅ Checkpoint 3 (End of Day 21): "Reasoning Loop Closed"
- [ ] Server uses a real VLM/LLM, not hardcoded logic.
- [ ] Model correctly identifies at least 2 different UI element types from redacted context alone.
- [ ] Grounding correctly resolves semantic targets to real DOM elements (including token → real value substitution client-side).
- [ ] Multi-step task works (e.g., 3+ sequential actions in one session).
- [ ] Confirmation UI appears before any "sensitive" action (submit/payment-like).
- **Exit criterion:** full task like "fill and submit this form" completes end-to-end, driven entirely by the server's live reasoning over redacted input.

---

## Week 4 — Hardening, Latency, Cross-Browser, Demo (Days 22–30)

**Goal:** Make it robust, fast, presentable, and cross-browser; prepare the pitch.

| Day | Task |
|---|---|
| 22 | Performance pass: quantize models further if needed, add delta-based state sync (send only changed regions), measure and log latency per stage. |
| 23 | Firefox port: adjust WebExtensions manifest differences, test capture/redaction/execution parity. |
| 24 | Edge case testing: pages with iframes, dynamic SPAs, no visible PII, multiple faces, slow network — fix breakages. |
| 25 | Add "Local-only mode" toggle (no server calls) and audit log UI showing redaction history. |
| 26 | UI/UX polish: popup, confirmation dialogs, redaction visualization overlay for the demo ("what the server actually sees"). |
| 27 | Write documentation: architecture recap, setup/run instructions, known limitations. |
| 28 | Full dry-run demo #1: run the exact demo script end-to-end, time it, note failures. |
| 29 | Fix issues from dry-run; dry-run demo #2. Prepare slides/pitch narrative and fallback recorded video in case live demo fails. |
| 30 | **Checkpoint 4 (Final): Demo-ready submission.** Buffer day for last-minute fixes. |

### ✅ Checkpoint 4 (End of Day 30): "Demo & Submission Ready"
- [ ] Works on both Chrome and Firefox.
- [ ] Full task (multi-step) completes reliably in <2 demo attempts.
- [ ] Redaction is visually demonstrable (raw vs. sanitized side-by-side).
- [ ] Latency numbers captured and ready to cite (e.g., "local inference: Xms, redaction: Yms, server round-trip: Zms").
- [ ] Documentation, pitch deck, and backup demo video are ready.
- [ ] Local-only fallback mode works if network/server fails live.

---

## Risk Buffer & Parallelization Notes
- **Start model export/ONNX conversion in Week 1**, not Week 2 — this step frequently has hidden compatibility issues (op support in ONNX Runtime Web) and eats time if left late.
- **Backend and ML-client tracks can run in parallel** from Day 8 onward; they only truly integrate at Checkpoint 3, so don't let one block the other.
- If WebGPU support/performance becomes a blocker, have WASM as the committed fallback rather than debugging WebGPU indefinitely — decide this by Day 10, not Day 20.
- If the chosen VLM is too slow/heavy to self-host, keep a cloud-hosted fallback (as the problem statement explicitly allows) ready by Day 17 so Checkpoint 3 isn't at risk.
- Treat Firefox porting (Day 23) as best-effort — a flawless Chrome demo beats a broken cross-browser one if time runs short.
