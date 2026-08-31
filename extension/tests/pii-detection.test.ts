import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { BoundingBox } from "../src/dom-sensitivity.ts";
import {
  classifyOcrLines,
  luhnValid,
  type OcrLine,
  type OcrWord
} from "../src/pii-detection.ts";

function box(wordIndex: number, lineY = 0): BoundingBox {
  return { x: wordIndex * 12, y: lineY, w: 10, h: 14 };
}

function words(text: string): OcrWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => ({ text: word, bbox: box(index) }));
}

function line(text: string, lineY = 0): OcrLine {
  return { text, bbox: { x: 0, y: lineY, w: text.length * 6, h: 14 }, words: words(text) };
}

function classesOf(text: string): string[] {
  return classifyOcrLines([line(text)]).map((hit) => hit.sensitivityClass).sort();
}

describe("luhnValid", () => {
  test("accepts a valid Visa test number", () => {
    assert.equal(luhnValid("4111111111111111"), true);
  });

  test("rejects an invalid number", () => {
    assert.equal(luhnValid("4111111111111112"), false);
  });

  test("rejects non-digit input", () => {
    assert.equal(luhnValid("4111abcd"), false);
  });
});

describe("classifyOcrLines", () => {
  test("detects an email address", () => {
    const hits = classifyOcrLines([line("Contact: john.doe@example.com for issues")]);
    const emails = hits.filter((hit) => hit.sensitivityClass === "email");

    assert.equal(emails.length, 1);
    assert.equal(emails[0].source, "visual");
    assert.equal(emails[0].confidence, 0.92);
    assert.deepEqual(emails[0].bbox, words("Contact: john.doe@example.com for issues")[1].bbox);
  });

  test("detects a parenthesized phone number", () => {
    const hits = classifyOcrLines([line("Call (415) 555-0132 now")]);
    const phones = hits.filter((hit) => hit.sensitivityClass === "phone");

    assert.equal(phones.length, 1);
    assert.equal(phones[0].confidence, 0.85);
  });

  test("detects a dashed phone number", () => {
    const hit = classifyOcrLines([line("415-555-0132")]);
    assert.equal(hit.filter((h) => h.sensitivityClass === "phone").length, 1);
  });

  test("detects an international phone number", () => {
    const hit = classifyOcrLines([line("+1-415-555-0132")]);
    assert.equal(hit.filter((h) => h.sensitivityClass === "phone").length, 1);
  });

  test("rejects phone numbers with too few digits", () => {
    assert.equal(classesOf("ext 555-0132").includes("phone"), false);
  });

  test("detects a Luhn-valid credit card number", () => {
    const hits = classifyOcrLines([line("Card 4111 1111 1111 1111 expires soon")]);
    const cards = hits.filter((hit) => hit.sensitivityClass === "card-number");

    assert.equal(cards.length, 1);
    assert.equal(cards[0].confidence, 0.95);
  });

  test("rejects a card number that fails Luhn", () => {
    assert.equal(
      classifyOcrLines([line("Card 4111 1111 1111 1112")]).some(
        (h) => h.sensitivityClass === "card-number"
      ),
      false
    );
  });

  test("detects a two-word person name", () => {
    const hits = classifyOcrLines([line("Signed by John Smith")]);
    const names = hits.filter((hit) => hit.sensitivityClass === "name");

    assert.equal(names.length, 1);
    assert.equal(names[0].confidence, 0.5);
    assert.equal(names[0].bbox.w, 22);
    assert.equal(names[0].bbox.h, 14);
  });

  test("names bbox spans both words", () => {
    const hit = classifyOcrLines([line("Order by Jane Marie")])
      .filter((h) => h.sensitivityClass === "name")[0];

    assert.ok(hit);
    assert.equal(hit.bbox.w, 22);
  });

  test("does not emit a name when the line contains an email", () => {
    const hits = classifyOcrLines([line("John Smith john.smith@example.com")]);
    assert.ok(hits.some((h) => h.sensitivityClass === "email"));
    assert.equal(hits.some((h) => h.sensitivityClass === "name"), false);
  });

  test("does not emit a name for capitalized UI words", () => {
    assert.equal(classesOf("Sign In").includes("name"), false);
  });

  test("does not emit a name for a single capital word", () => {
    assert.equal(classesOf("Welcome").includes("name"), false);
  });

  test("does not emit a name for an initial", () => {
    assert.equal(classesOf("Mr. John").includes("name"), false);
  });

  test("returns no hits for an empty line", () => {
    assert.equal(classesOf("").length, 0);
  });

  test("deduplicates repeated matches", () => {
    const hits = classifyOcrLines([line("john@example.com"), line("jane@example.org")]);
    assert.equal(hits.filter((h) => h.sensitivityClass === "email").length, 2);
  });
});