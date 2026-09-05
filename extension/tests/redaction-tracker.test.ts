import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRedactionTracker, resolveTokens } from "../src/redaction.ts";
import type { ElementNode } from "../src/dom-sensitivity.ts";

function node(id: string, inputType: string, value: string | null): ElementNode {
  return {
    id,
    tag: "input",
    role: "textbox",
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    inputType,
    ariaLabel: null,
    autocomplete: null,
    placeholder: null,
    value
  };
}

describe("createRedactionTracker", () => {
  test("tokens stay stable across steps and map to the latest value", () => {
    const tracker = createRedactionTracker();
    const map = [node("mail", "email", "a@b.com")];

    tracker.redactNodes(map, ["mail"]);
    const firstTokens = map[0].value;
    assert.match(firstTokens ?? "", /^\[REDACTED_EMAIL_\d+\]$/);
    assert.equal(resolveTokens(firstTokens!, tracker.getRedactionKey()), "a@b.com");

    // Same element re-typed in a later step: same token, key now maps to the
    // latest value so resolveTokens restores what the user actually typed.
    const next = [node("mail", "email", "new@mail.org")];
    tracker.redactNodes(next, ["mail"]);
    assert.equal(next[0].value, firstTokens, "token does not churn between steps");
    assert.equal(
      resolveTokens(firstTokens!, tracker.getRedactionKey()),
      "new@mail.org"
    );
  });

  test("redactNodes only touches the given ids", () => {
    const tracker = createRedactionTracker();
    const clean = node("name", "text", "plain");
    const sensitive = node("mail", "email", "x@y.z");
    const map = [clean, sensitive];

    tracker.redactNodes(map, ["mail"]);

    assert.equal(clean.value, "plain", "unchanged elements are left alone");
    assert.match(sensitive.value ?? "", /^\[REDACTED_EMAIL_\d+\]$/);
  });

  test("non-sensitive elements are not tokenized", () => {
    const tracker = createRedactionTracker();
    const map = [node("title", "text", "Hello world")];

    tracker.redactNodes(map, ["title"]);
    assert.equal(map[0].value, "Hello world");
    assert.equal(tracker.redactionKeySize(), 0);
  });
});