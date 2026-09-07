import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/setup-dom.ts";
import {
  createDeltaTracker,
  expandDeltaContext,
  assignStructuralIds
} from "../src/delta.ts";
import { extractStructuralMap, findElementById, toElementNode } from "../src/dom-map.ts";
import { createRedactionTracker } from "../src/redaction.ts";

const RAW = `<!doctype html><html><body>
  <input type="text" aria-label="Search">
</body></html>`;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("React-style dynamic mount scenario", () => {
  test("a subtree mounted after capture is fully re-processed by the delta path", async () => {
    const { doc } = setupDom(RAW);
    extractStructuralMap(doc);

    const tracker = createDeltaTracker();
    tracker.attach(doc);
    tracker.collectChangedElements();

    // React mounts the whole subtree in a single DOM commit.
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
    assert.equal(changed.length > 0, true, "observer recorded the mount");

    assignStructuralIds(doc, changed);
    const ids = expandDeltaContext(changed);

    const idOf = (el: HTMLElement) => el.getAttribute("data-agent-id");
    assert.ok(idOf(form), "the mounted form got a synthetic id");
    assert.ok(idOf(email), "the mounted input got a synthetic id");
    assert.equal(ids.some((id) => id === idOf(email)), true, "expansion covered the new input");
    assert.equal(ids.some((id) => id === idOf(form)), true, "expansion covered the new form");

    const updated = ids.map((id) => toElementNode(doc, findElementById(doc, id)!));
    const emailNode = updated.find((node) => node.inputType === "email");
    assert.ok(emailNode, "re-extraction picked up the new email field");
    assert.equal(emailNode.value, "ada@example.com");
    assert.match(emailNode.id, /^el_\d+$/);
  });

  test("dynamically mounted sensitive input is redacted, not just listed", async () => {
    const { doc } = setupDom(RAW);
    extractStructuralMap(doc);

    const tracker = createDeltaTracker();
    tracker.attach(doc);
    tracker.collectChangedElements();

    const card = doc.createElement("input");
    card.type = "text";
    card.autocomplete = "cc-number";
    card.setAttribute("aria-label", "Card number");
    card.value = "4111 1111 1111 1111";
    doc.body.appendChild(card);
    await flush();

    const changed = tracker.collectChangedElements();
    assignStructuralIds(doc, changed);
    const ids = expandDeltaContext(changed);
    const updated = ids.map((id) => toElementNode(doc, findElementById(doc, id)!));

    const redactor = createRedactionTracker();
    redactor.redactNodes(updated, updated.map((node) => node.id));

    const cardNode = updated.find((node) => node.id !== null && node.autocomplete === "cc-number");
    assert.ok(cardNode, "new card field was re-extracted");
    assert.match(cardNode.value ?? "", /REDACTED/);
  });
});