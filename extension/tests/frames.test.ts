import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupDom, installRectStub, type DomSetup } from "./helpers/setup-dom.ts";
import { extractStructuralMap, hasFrameNodes } from "../src/dom-map.ts";

const INNER_FORM = `<!doctype html><html><body>
  <form aria-label="Frame form">
    <input type="text" aria-label="Frame name">
    <input type="email" aria-label="Frame email">
    <button type="submit">Go</button>
  </form>
</body></html>`;

const TOP_PAGE = `<!doctype html><html><body>
  <h1>Top</h1>
</body></html>`;

function frameIn(top: DomSetup, inner: DomSetup): HTMLIFrameElement {
  // jsdom cannot parse srcdoc content, so the inner document is injected the
  // same way a real browser exposes an already-loaded same-origin iframe.
  installRectStub(inner.win);
  const iframe = top.doc.createElement("iframe");
  Object.defineProperty(iframe, "contentDocument", {
    value: inner.doc,
    configurable: true
  });
  top.doc.body.appendChild(iframe);
  return iframe;
}

function crossOriginFrame(top: DomSetup): HTMLIFrameElement {
  const iframe = top.doc.createElement("iframe");
  Object.defineProperty(iframe, "contentDocument", {
    get() {
      throw new Error(
        "SecurityError: Blocked a frame with origin http://evil.example from accessing a cross-origin frame."
      );
    },
    configurable: true
  });
  top.doc.body.appendChild(iframe);
  return iframe;
}

describe("nested iframe scenario", () => {
  test("same-origin frames are traversed; inner elements keep viewport-offset bboxes", () => {
    const top = setupDom(TOP_PAGE);
    const inner = setupDom(INNER_FORM);
    frameIn(top, inner);

    const map = extractStructuralMap(top.doc);

    const frameNode = map.find((node) => node.tag === "iframe");
    assert.ok(frameNode, "the iframe itself is recorded");
    assert.equal(frameNode.role, "iframe");
    assert.equal(frameNode.crossOrigin, false);

    const email = map.find((node) => node.inputType === "email");
    assert.ok(email, "inner email input is included in the map");
    assert.equal(email.frameDepth, 1);
    // Inner rect (40,40) offset by the iframe rect (40,40) → (80,80), so
    // coordinates are relative to the top screenshot, not the frame.
    assert.equal(email.bbox.x, 80);
    assert.equal(email.bbox.y, 80);

    assert.equal(map.some((node) => node.tag === "form"), true, "inner form present");
    assert.ok(hasFrameNodes(map));
  });

  test("cross-origin frames are flagged, never crash, and are not descended into", () => {
    const top = setupDom(TOP_PAGE);
    crossOriginFrame(top);

    const map = extractStructuralMap(top.doc);

    const frameNode = map.find((node) => node.tag === "iframe");
    assert.ok(frameNode, "cross-origin iframe is still listed so the model knows it exists");
    assert.equal(frameNode.crossOrigin, true);
    assert.equal(
      map.filter((node) => (node.frameDepth ?? 0) > 0).length,
      0,
      "no cross-origin inner elements leaked into the map"
    );
  });

  test("hidden iframes are excluded like any other invisible element", () => {
    const top = setupDom(TOP_PAGE);
    const inner = setupDom(INNER_FORM);
    const iframe = frameIn(top, inner);
    iframe.className = "hidden";

    const map = extractStructuralMap(top.doc);
    assert.equal(map.some((node) => node.tag === "iframe"), false);
  });
});