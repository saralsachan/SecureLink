import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSensitiveDomElements,
  type ElementNode,
  type SensitiveHit
} from "../src/dom-sensitivity.ts";

function fakeNode(overrides: Partial<ElementNode> & { id: string }): ElementNode {
  return {
    tag: "input",
    role: "textbox",
    bbox: { x: 0, y: 0, w: 40, h: 24 },
    inputType: null,
    ariaLabel: null,
    autocomplete: null,
    placeholder: null,
    ...overrides
  };
}

function hit(elementId: string, sensitivityClass: SensitiveHit["sensitivityClass"]): SensitiveHit {
  return { elementId, sensitivityClass, confidence: 1, source: "dom" };
}

test("flags input[type=password]", () => {
  const hits = detectSensitiveDomElements([fakeNode({ id: "pw", inputType: "password" })]);
  assert.deepEqual(hits, [hit("pw", "password")]);
});

test("flags autocomplete=cc-number as card-number", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "card", inputType: "text", autocomplete: "cc-number" })
  ]);
  assert.deepEqual(hits, [hit("card", "card-number")]);
});

test("flags autocomplete=cc-csc as card-cvc", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "cvc", inputType: "text", autocomplete: "cc-csc" })
  ]);
  assert.deepEqual(hits, [hit("cvc", "card-cvc")]);
});

test("flags autocomplete=email", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "mail", inputType: "text", autocomplete: "email" })
  ]);
  assert.deepEqual(hits, [hit("mail", "email")]);
});

test("flags input[type=email]", () => {
  const hits = detectSensitiveDomElements([fakeNode({ id: "mail2", inputType: "email" })]);
  assert.deepEqual(hits, [hit("mail2", "email")]);
});

test("flags autocomplete=tel and input[type=tel] as phone", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "phone1", inputType: "text", autocomplete: "tel" }),
    fakeNode({ id: "phone2", inputType: "tel" })
  ]);
  assert.deepEqual(hits, [hit("phone1", "phone"), hit("phone2", "phone")]);
});

test("flags aria-label containing OTP", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "otp", inputType: "text", ariaLabel: "Enter OTP" })
  ]);
  assert.deepEqual(hits, [hit("otp", "otp")]);
});

test("flags placeholder matching SSN", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "ssn", inputType: "text", placeholder: "SSN" })
  ]);
  assert.deepEqual(hits, [hit("ssn", "ssn")]);
});

test("flags placeholder matching credit card", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "cc", inputType: "text", placeholder: "Credit Card Number" })
  ]);
  assert.deepEqual(hits, [hit("cc", "card-number")]);
});

test("flags aria-label containing CVV", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "cvv", inputType: "text", ariaLabel: "CVV" })
  ]);
  assert.deepEqual(hits, [hit("cvv", "card-cvc")]);
});

test("flags placeholder matching passport", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "pass", inputType: "text", placeholder: "Passport number" })
  ]);
  assert.deepEqual(hits, [hit("pass", "passport")]);
});

test("dedupes overlapping rules per element", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "dup-email", inputType: "email", autocomplete: "email" }),
    fakeNode({
      id: "dup-card",
      inputType: "text",
      autocomplete: "cc-number",
      placeholder: "Credit Card Number"
    })
  ]);
  assert.deepEqual(hits, [hit("dup-email", "email"), hit("dup-card", "card-number")]);
});

test("reads multi-token autocomplete with prefix", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "card2", inputType: "text", autocomplete: "shipping cc-number" })
  ]);
  assert.deepEqual(hits, [hit("card2", "card-number")]);
});

test("returns no hits for benign fields", () => {
  const hits = detectSensitiveDomElements([
    fakeNode({ id: "search", inputType: "search", ariaLabel: "Search" }),
    fakeNode({ id: "name", inputType: "text", autocomplete: "name" }),
    fakeNode({
      id: "address",
      inputType: "text",
      autocomplete: "street-address",
      placeholder: "Street address"
    }),
    fakeNode({ id: "agree", inputType: "checkbox", role: "checkbox" })
  ]);
  assert.deepEqual(hits, []);
});

test("detects all sensitive types in a mixed map with no false positives", () => {
  const map: ElementNode[] = [
    fakeNode({ id: "a-pw", inputType: "password" }),
    fakeNode({ id: "b-cc", inputType: "text", autocomplete: "cc-number" }),
    fakeNode({ id: "c-cvc", inputType: "text", autocomplete: "cc-csc" }),
    fakeNode({ id: "d-email", inputType: "email" }),
    fakeNode({ id: "e-tel", inputType: "tel" }),
    fakeNode({ id: "f-otp", inputType: "text", ariaLabel: "Two-factor OTP code" }),
    fakeNode({ id: "g-ssn", inputType: "text", placeholder: "SSN" }),
    fakeNode({ id: "h-pass", inputType: "text", placeholder: "Passport number" }),
    fakeNode({ id: "benign-search", inputType: "search", ariaLabel: "Search site" }),
    fakeNode({ id: "benign-name", inputType: "text", autocomplete: "name" }),
    fakeNode({ id: "benign-submit", tag: "button", role: "button", inputType: "submit" })
  ];

  const hits = detectSensitiveDomElements(map);
  assert.deepEqual(hits, [
    hit("a-pw", "password"),
    hit("b-cc", "card-number"),
    hit("c-cvc", "card-cvc"),
    hit("d-email", "email"),
    hit("e-tel", "phone"),
    hit("f-otp", "otp"),
    hit("g-ssn", "ssn"),
    hit("h-pass", "passport")
  ]);
});