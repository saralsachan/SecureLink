/**
 * Robustness scenarios for the SecureLink agent pipeline — the four page types
 * from the requirements plus graceful-degradation checks. Runs the real pipeline
 * modules (structural map, delta sync, sensitivity detection, redaction, OCR
 * classification, BlazeFace box parsing, stage timeouts) in jsdom and prints a
 * PASS/FAIL report. Exits non-zero when any scenario fails.
 *
 * Usage:
 *   node --disable-warning=ExperimentalWarning scripts/pipeline-scenarios.mts
 */
import { setupDom, installRectStub } from "../tests/helpers/setup-dom.ts";
import {
  extractStructuralMap,
  findElementById,
  hasFrameNodes,
  mergeDeltaNodes,
  toElementNode
} from "../src/dom-map.ts";
import {
  assignStructuralIds,
  createDeltaTracker,
  expandDeltaContext
} from "../src/delta.ts";
import { createRedactionTracker } from "../src/redaction.ts";
import { detectSensitiveDomElements, type ElementNode } from "../src/dom-sensitivity.ts";
import { classifyOcrLines, type OcrLine } from "../src/pii-detection.ts";
import { parseBlazeFaceBoxes } from "../src/blazeface-parse.ts";
import { withTimeout } from "../src/async-utils.ts";

let failures = 0;
let passes = 0;

async function scenario(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passes += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(
      `  FAIL  ${name}\n       ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ── Scenario 1: nested iframes ───────────────────────────────────────────────

async function iframeScenario(): Promise<void> {
  const top = setupDom(`<!doctype html><html><body><h1>Top</h1></body></html>`);
  const inner = setupDom(`<!doctype html><html><body>
    <form aria-label="Frame form">
      <input type="email" aria-label="Frame email">
      <button type="submit">Go</button>
    </form>
  </body></html>`);
  installRectStub(inner.win);

  const sameOrigin = top.doc.createElement("iframe");
  Object.defineProperty(sameOrigin, "contentDocument", {
    value: inner.doc,
    configurable: true
  });
  top.doc.body.appendChild(sameOrigin);

  const crossOrigin = top.doc.createElement("iframe");
  Object.defineProperty(crossOrigin, "contentDocument", {
    get() {
      throw new Error("SecurityError: cross-origin");
    },
    configurable: true
  });
  top.doc.body.appendChild(crossOrigin);

  const map = extractStructuralMap(top.doc);

  const frameNodes = map.filter((node) => node.tag === "iframe");
  if (frameNodes.length !== 2) {
    throw new Error(`expected 2 iframe nodes, got ${frameNodes.length}`);
  }
  if (!frameNodes.some((node) => node.crossOrigin === true)) {
    throw new Error("cross-origin iframe not flagged");
  }

  const email = map.find((node) => node.inputType === "email");
  if (!email) {
    throw new Error("inner email field missing from map");
  }
  if (email.frameDepth !== 1) {
    throw new Error(`expected frameDepth 1, got ${email.frameDepth}`);
  }
  if (email.bbox.x !== 80 || email.bbox.y !== 80) {
    throw new Error(`expected offset bbox (80,80), got (${email.bbox.x},${email.bbox.y})`);
  }
  if (!hasFrameNodes(map)) {
    throw new Error("hasFrameNodes(map) should be true");
  }

  // Overlapping same-origin frames must not double-visit the inner document.
  const reset = setupDom(`<!doctype html><html><body></body></html>`);
  const shared = setupDom(`<!doctype html><html><body><input type="text"></body></html>`);
  installRectStub(shared.win);
  const f1 = reset.doc.createElement("iframe");
  Object.defineProperty(f1, "contentDocument", { value: shared.doc, configurable: true });
  const f2 = reset.doc.createElement("iframe");
  Object.defineProperty(f2, "contentDocument", { value: shared.doc, configurable: true });
  reset.doc.body.append(f1, f2);
  const deduped = extractStructuralMap(reset.doc);
  const innerTexts = deduped.filter((node) => node.tag === "input");
  if (innerTexts.length !== 1) {
    throw new Error(`shared inner doc visited twice: found ${innerTexts.length} inner inputs`);
  }
}

// ── Scenario 2: React-style dynamic mount ────────────────────────────────────

async function dynamicMountScenario(): Promise<void> {
  const { doc } = setupDom(`<!doctype html><html><body>
    <input type="text" aria-label="Search">
  </body></html>`);

  const firstMap = extractStructuralMap(doc);
  const tracker = createDeltaTracker();
  tracker.attach(doc);
  tracker.collectChangedElements();

  // React commits a whole subtree in one DOM mutation.
  const form = doc.createElement("form");
  form.setAttribute("aria-label", "Profile form");
  const name = doc.createElement("input");
  name.type = "text";
  name.setAttribute("aria-label", "Full name");
  const email = doc.createElement("input");
  email.type = "email";
  email.setAttribute("aria-label", "Email");
  email.value = "ada@example.com";
  form.append(name, email);
  doc.body.appendChild(form);
  await flush();

  const changed = tracker.collectChangedElements();
  assignStructuralIds(doc, changed);
  const ids = expandDeltaContext(changed);

  const updated = ids.map((id) => toElementNode(doc, findElementById(doc, id)!));
  const emailNode = updated.find((node) => node.inputType === "email");
  if (!emailNode || emailNode.value !== "ada@example.com") {
    throw new Error("newly mounted email field not re-extracted");
  }

  const cachedMap = mergeDeltaNodes(firstMap, updated, []);
  if (!cachedMap.some((node) => node.inputType === "email")) {
    throw new Error("mounted field missing from cached map");
  }

  // A newly mounted sensitive field must actually be redacted next step.
  const card = doc.createElement("input");
  card.type = "text";
  card.autocomplete = "cc-number";
  card.value = "4111 1111 1111 1111";
  doc.body.appendChild(card);
  await flush();

  const cardChanged = tracker.collectChangedElements();
  assignStructuralIds(doc, cardChanged);
  const cardIds = expandDeltaContext(cardChanged);
  const cardUpdated = cardIds.map((id) => toElementNode(doc, findElementById(doc, id)!));
  const cachedMap2 = mergeDeltaNodes(cachedMap, cardUpdated, []);
  const redactor = createRedactionTracker();
  redactor.redactNodes(cachedMap2, cardUpdated.map((node) => node.id));
  const cardNode = cachedMap2.find((node) => node.autocomplete === "cc-number");
  if (!cardNode || !String(cardNode.value ?? "").includes("REDACTED")) {
    throw new Error(`new card field not redacted (value=${cardNode?.value})`);
  }
}

// ── Scenario 3: zero-PII page ────────────────────────────────────────────────

async function zeroPiiScenario(): Promise<void> {
  const { doc } = setupDom(`<!doctype html><html><body>
    <h1>Welcome to our demo</h1>
    <form aria-label="Search form">
      <input type="text" aria-label="Search term" value="gardening tips">
      <input type="text" aria-label="Site pin" value="1234">
      <button type="submit">Search</button>
    </form>
    <a href="/about">About us</a>
    <input type="text" aria-label="ZIP code" value="90210">
  </body></html>`);

  const map = extractStructuralMap(doc);
  if (map.length < 3) {
    throw new Error(`expected a healthy map, got ${map.length} elements`);
  }

  const domHits = detectSensitiveDomElements(map);
  if (domHits.length !== 0) {
    throw new Error(`false-positive DOM hits: ${JSON.stringify(domHits.map((h) => h.sensitivityClass))}`);
  }

  const benignLines: OcrLine[] = [
    {
      text: "Welcome to our website",
      bbox: { x: 10, y: 10, w: 190, h: 24 },
      words: []
    },
    {
      text: "Buy tickets now for the show",
      bbox: { x: 10, y: 40, w: 230, h: 24 },
      words: []
    }
  ];
  if (classifyOcrLines(benignLines).length !== 0) {
    throw new Error("false-positive OCR hits on benign text");
  }

  const redactor = createRedactionTracker();
  redactor.redactNodes(map, map.map((node) => node.id));
  if (redactor.redactionKeySize() !== 0) {
    throw new Error("benign page produced redaction tokens (would block nothing, but noisy)");
  }

  // The map is still sent to the server unchanged — nothing blocks this page.
  if (map.length !== map.filter((node) => node.value === null || !node.value.includes("REDACTED")).length) {
    throw new Error("benign page was mutated by redaction");
  }
}

// ── Scenario 4: multiple overlapping faces ───────────────────────────────────

async function facesScenario(): Promise<void> {
  const row = (x0: number, y0: number, x1: number, y1: number): Float32Array => {
    const r = new Float32Array(16);
    r[0] = x0;
    r[1] = y0;
    r[2] = x1;
    r[3] = y1;
    return r;
  };

  // Two real faces plus two jittered duplicates of face A → 2 unique faces.
  const boxes = new Float32Array([
    ...row(0.2, 0.2, 0.5, 0.5),
    ...row(0.21, 0.2, 0.51, 0.5), // dup of A
    ...row(0.6, 0.6, 0.9, 0.9),
    ...row(0.61, 0.61, 0.91, 0.91) // dup of B
  ]);

  const faces = parseBlazeFaceBoxes(boxes, [1, 4], 640, 480);
  if (faces.length !== 2) {
    throw new Error(`expected 2 unique faces after IoU dedupe, got ${faces.length}`);
  }
  if (faces[0].bbox.x !== Math.round(0.2 * 640) || faces[0].bbox.y !== Math.round(0.2 * 480)) {
    throw new Error(`face A pixel bbox wrong: ${JSON.stringify(faces[0].bbox)}`);
  }

  const bounded = parseBlazeFaceBoxes(
    new Float32Array([
      ...row(0.1, 0.1, 0.2, 0.2),
      ...row(0.3, 0.1, 0.4, 0.2),
      ...row(0.5, 0.1, 0.6, 0.2),
      ...row(0.7, 0.1, 0.8, 0.2)
    ]),
    [1, 4],
    640,
    480,
    2
  );
  if (bounded.length !== 2) {
    throw new Error(`expected maxDetections of 2, got ${bounded.length}`);
  }

  // Zero detections on face-free page translates to zero redaction boxes.
  const noFaces = parseBlazeFaceBoxes(null, undefined, 640, 480);
  if (noFaces.length !== 0) {
    throw new Error("null output should parse to zero faces");
  }
}

// ── Scenario 5: graceful degradation ─────────────────────────────────────────

async function degradationScenario(): Promise<void> {
  const results: string[] = [];
  const errors: string[] = [];

  const stage = async <T>(name: string, run: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  // 1. A bubbling (never-settling) vision stage degrades into an error and the
  //    pipeline continues instead of hanging.
  const vision = await stage("vision", () =>
    withTimeout(new Promise<never>(() => {}), 25, "Vision inference timed out")
  );
  if (vision !== undefined) {
    throw new Error("vision stage should have degraded");
  }

  // 2. A dead server (closed port) fails the network round trip; the failure is
  //    surfaced as a user-visible message rather than a silent hang.
  const deadPort = await stage("networkRoundTrip", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const resp = await fetch("http://127.0.0.1:9/agent/step", { signal: controller.signal });
      return resp.status;
    } finally {
      clearTimeout(timer);
    }
  });
  if (deadPort !== undefined) {
    throw new Error("dead server should have degraded");
  }

  // 3. A mid-pipeline failure still lets later stages run (structure map passed
  //    through despite the vision failure) and produces a surfaced error list.
  const map = await stage("structuralMap", () =>
    extractStructuralMap(
      setupDom(`<!doctype html><html><body><input type="text"></body></html>`).doc
    )
  );
  if (!map || map.length === 0) {
    throw new Error("later stage must still run after an earlier failure");
  }

  // 4. Server-side failure modes surface cleanly: OCR/vision errors read back.
  const surfaceMessage = errors.find((error) => error.startsWith("vision"));
  if (!surfaceMessage) {
    throw new Error("expected a surfaced vision error, got nothing");
  }
  results.push(surfaceMessage);

  if (results.length !== 1) {
    throw new Error("unexpected degradation surface");
  }
  console.log(`      (degraded gracefully: ${surfaceMessage})`);
}

async function main(): Promise<void> {
  console.log("\n── Robustness scenarios ─────────────────────────────────────\n");

  console.log("  [1/5] nested iframes");
  await scenario("same-origin traversal with offset bboxes + cross-origin flag", iframeScenario);

  console.log("  [2/5] React-style dynamic mount");
  await scenario("mounted subtree fully re-processed and redacted", dynamicMountScenario);

  console.log("  [3/5] zero-PII page");
  await scenario("no false positives, nothing blocked", zeroPiiScenario);

  console.log("  [4/5] multiple overlapping faces");
  await scenario("IoU dedupe to unique faces, pixel bboxes, bounded detections", facesScenario);

  console.log("  [5/5] graceful degradation");
  await scenario("vision/server failures surface, never hang", degradationScenario);

  console.log(`\n── Result: ${passes} passed, ${failures} failed ──\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("harness crashed:", error);
  process.exitCode = 1;
});