import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  auditStorageKey,
  capAuditEntries,
  formatAuditTime,
  redactionAuditTexts,
  AUDIT_MAX_ENTRIES,
  type AuditLogEntry
} from "../src/audit-log.ts";
import { extractRedactionTokens } from "../src/redaction.ts";
import type { ElementNode } from "../src/dom-sensitivity.ts";

function entry(seq: number, text: string): AuditLogEntry {
  return { seq, ts: 1_700_000_000_000 + seq, kind: "info", text };
}

const map: ElementNode[] = [
  {
    id: "cc",
    tag: "input",
    role: null,
    inputType: "text",
    value: "[REDACTED_CREDIT_CARD_1]",
    placeholder: null,
    ariaLabel: "card number",
    autocomplete: null,
    bbox: { x: 0, y: 0, w: 100, h: 40 }
  },
  {
    id: "search",
    tag: "input",
    role: null,
    inputType: "search",
    value: "cats",
    placeholder: "Search",
    ariaLabel: null,
    autocomplete: null,
    bbox: { x: 0, y: 0, w: 100, h: 40 }
  },
  {
    id: "name",
    tag: "input",
    role: null,
    inputType: "text",
    value: "[REDACTED_NAME_2]",
    placeholder: null,
    ariaLabel: null,
    autocomplete: null,
    bbox: { x: 0, y: 0, w: 100, h: 40 }
  }
];

describe("extractRedactionTokens", () => {
  test("finds embedded tokens", () => {
    assert.deepEqual(extractRedactionTokens("[REDACTED_CREDIT_CARD_1]"), [
      "[REDACTED_CREDIT_CARD_1]"
    ]);
    assert.deepEqual(extractRedactionTokens("a [REDACTED_EMAIL_3] and [REDACTED_PHONE_2]"), [
      "[REDACTED_EMAIL_3]",
      "[REDACTED_PHONE_2]"
    ]);
  });

  test("returns empty for non-token text", () => {
    assert.deepEqual(extractRedactionTokens("cats"), []);
    assert.deepEqual(extractRedactionTokens(null), []);
    assert.deepEqual(extractRedactionTokens(undefined), []);
  });
});

describe("redactionAuditTexts", () => {
  test("summarises redacted fields without leaking real values", () => {
    const texts = redactionAuditTexts(map, ["cc", "name", "search"]);

    assert.equal(texts.length, 2);
    assert.match(texts[0], /Redacted credit-card on <input> card number/);
    assert.match(texts[0], /-> \[REDACTED_CREDIT_CARD_1\]/);
    assert.match(texts[1], /Redacted name on <input> /);
    assert.ok(!texts.join("\n").includes("null"));
  });

  test("degrades a tokenized label to the element id", () => {
    const tokenized: ElementNode = {
      ...map[0],
      ariaLabel: "[REDACTED_EMAIL_1]"
    };
    const texts = redactionAuditTexts([tokenized], ["cc"]);

    assert.equal(texts.length, 1);
    assert.match(texts[0], /Redacted credit-card on <input> cc/);
  });

  test("ignores ids not in the map and elements without tokens", () => {
    assert.deepEqual(redactionAuditTexts(map, ["missing", "search"]), []);
  });
});

describe("capAuditEntries", () => {
  test("keeps only the most recent entries past the cap", () => {
    const all = Array.from({ length: AUDIT_MAX_ENTRIES + 10 }, (_, i) =>
      entry(i, `event ${i}`)
    );
    const capped = capAuditEntries(all, AUDIT_MAX_ENTRIES);

    assert.equal(capped.length, AUDIT_MAX_ENTRIES);
    assert.equal(capped[0].seq, 10);
    assert.equal(capped.at(-1)?.seq, AUDIT_MAX_ENTRIES + 9);
  });

  test("returns a copy when under the cap", () => {
    const source = [entry(1, "a")];
    const capped = capAuditEntries(source, AUDIT_MAX_ENTRIES);
    assert.deepEqual(capped, source);
    assert.notEqual(capped, source);
  });
});

describe("auditStorageKey + formatAuditTime", () => {
  test("scopes the storage key by session", () => {
    assert.equal(auditStorageKey("abc"), "securelink:audit:abc");
  });

  test("formats timestamps as HH:MM:SS", () => {
    const date = new Date(2026, 4, 5, 14, 32, 5);
    assert.equal(formatAuditTime(date.getTime()), "14:32:05");
  });
});