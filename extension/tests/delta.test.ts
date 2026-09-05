import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createDeltaTracker, expandDeltaContext } from "../src/delta.ts";
import { extractStructuralMap } from "../src/dom-map.ts";
import { setupDom, type DomSetup } from "./helpers/setup-dom.ts";

const FORM_HTML = `<!doctype html><html><body>
  <label>Name <input type="text" aria-label="Full name"></label>
  <label>Email <input type="email" aria-label="Email address"></label>
  <button type="submit">Create Account</button>
</body></html>`;

function fillValue(setup: DomSetup, target: Element, value: string): void {
  const { win } = setup;
  const valueSetter = Object.getOwnPropertyDescriptor(
    win.HTMLInputElement.prototype,
    "value"
  )?.set;
  assert.ok(valueSetter, "jsdom input value setter must exist");
  valueSetter.call(target, value);
  target.dispatchEvent(new win.Event("input", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new win.Event("change", { bubbles: true, cancelable: true }));
}

describe("delta tracker", () => {
  test("a single typed character re-processes only that field", () => {
    const setup = setupDom(FORM_HTML);
    const { doc } = setup;

    // First capture assigns synthetic ids → discard those attribute mutations.
    const map = extractStructuralMap(doc);
    const tracker = createDeltaTracker();
    tracker.attach(doc);
    tracker.collectChangedElements();

    const email = Array.from(doc.querySelectorAll<HTMLInputElement>("input[type=email]"))[0];
    assert.ok(email, "email input must exist");

    // User types ONE character into the email field.
    fillValue(setup, email, "a@b.c!");

    const changed = tracker.collectChangedElements();
    assert.equal(changed.length, 1, "only the typed-into element is changed");
    assert.equal(changed[0], email);

    const reProcessedIds = expandDeltaContext(changed);
    assert.equal(reProcessedIds.length, 1, "context expansion stays on the changed field");
    assert.equal(reProcessedIds[0], email.getAttribute("data-agent-id"));
    assert.ok(map.some((node) => node.id === reProcessedIds[0]));
  });

  test("no page changes since the last step → empty diff", () => {
    const setup = setupDom(FORM_HTML);
    const tracker = createDeltaTracker();
    tracker.attach(setup.doc);
    assert.equal(tracker.hasChanges, false);
    assert.equal(tracker.collectChangedElements().length, 0);
  });

  test("attribute change on one element is tracked", async () => {
    const setup = setupDom(FORM_HTML);
    const tracker = createDeltaTracker();
    tracker.attach(setup.doc);

    const button = setup.doc.querySelector("button");
    assert.ok(button, "button must exist");
    button.setAttribute("aria-label", "Changed label");

    // jsdom delivers MutationObserver records asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const changed = tracker.collectChangedElements();
    assert.equal(changed.length, 1);
    assert.equal(changed[0], button);
  });
});

describe("expandDeltaContext", () => {
  test("only returns in-map ids, excluding the parent label", () => {
    const setup = setupDom(FORM_HTML);
    const tracker = createDeltaTracker();
    tracker.attach(setup.doc);
    extractStructuralMap(setup.doc);
    tracker.collectChangedElements();

    const input = setup.doc.querySelector("input[type=text]");
    assert.ok(input, "text input must exist");
    fillValue(setup, input, "x");

    const changed = tracker.collectChangedElements();
    const ids = expandDeltaContext(changed);

    // The changed input is the only structural element in its context; the
    // wrapping <label> is not part of the structural-map selector.
    assert.equal(ids.length, 1);
    assert.equal(ids[0], input.getAttribute("data-agent-id"));
  });
});