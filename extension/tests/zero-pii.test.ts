import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/setup-dom.ts";
import { extractStructuralMap } from "../src/dom-map.ts";
import { detectSensitiveDomElements } from "../src/dom-sensitivity.ts";
import { createRedactionTracker } from "../src/redaction.ts";
import { classifyOcrLines, type OcrLine } from "../src/pii-detection.ts";

const BENIGN_PAGE = `<!doctype html><html><body>
  <h1>Welcome to our demo</h1>
  <form aria-label="Search form">
    <input type="text" aria-label="Search term" value="gardening tips">
    <input type="text" aria-label="Site pin" value="1234">
    <button type="submit">Search</button>
  </form>
  <a href="/about">About us</a>
  <input type="text" aria-label="ZIP code" value="90210">
</body></html>`;

describe("zero-PII scenario", () => {
  test("benign page produces zero DOM hits and zero redaction", () => {
    const { doc } = setupDom(BENIGN_PAGE);
    const map = extractStructuralMap(doc);

    assert.ok(map.length > 0, "the page still has a structural map");
    const hits = detectSensitiveDomElements(map);
    assert.equal(hits.length, 0, "no false-positive sensitivity hits");

    const redactor = createRedactionTracker();
    redactor.redactNodes(map, map.map((node) => node.id));
    assert.equal(redactor.redactionKeySize(), 0, "nothing was redacted, so nothing blocked");

    for (const node of map) {
      assert.equal((node.value ?? "").includes("REDACTED"), false);
      assert.equal((node.placeholder ?? "").includes("REDACTED"), false);
    }
  });

  test("benign OCR lines produce zero visual hits", () => {
    const lines: OcrLine[] = [
      {
        text: "Welcome to our website",
        bbox: { x: 10, y: 10, w: 190, h: 24 },
        words: [
          { text: "Welcome", bbox: { x: 10, y: 10, w: 70, h: 24 } },
          { text: "to", bbox: { x: 85, y: 10, w: 20, h: 24 } },
        ],
      },
      {
        text: "Buy tickets now for the show",
        bbox: { x: 10, y: 40, w: 230, h: 24 },
        words: [
          { text: "Buy", bbox: { x: 10, y: 40, w: 30, h: 24 } },
          { text: "tickets", bbox: { x: 45, y: 40, w: 60, h: 24 } },
        ],
      },
    ];

    assert.equal(classifyOcrLines(lines).length, 0);
  });

  test("OCR with a phone number is still caught (negative control)", () => {
    const lines: OcrLine[] = [
      {
        text: "Call us at (555) 123-4567",
        bbox: { x: 10, y: 10, w: 190, h: 24 },
        words: [
          { text: "Call", bbox: { x: 10, y: 10, w: 34, h: 24 } },
          { text: "us", bbox: { x: 48, y: 10, w: 20, h: 24 } },
          { text: "at", bbox: { x: 72, y: 10, w: 16, h: 24 } },
          { text: "(555)", bbox: { x: 92, y: 10, w: 46, h: 24 } },
          { text: "123-4567", bbox: { x: 142, y: 10, w: 64, h: 24 } },
        ],
      },
    ];

    const hits = classifyOcrLines(lines);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sensitivityClass, "phone");
  });
});