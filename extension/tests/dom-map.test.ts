import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { setupDom } from "./helpers/setup-dom.ts";
import {
  extractStructuralMap,
  findElementById,
  mergeDeltaNodes,
  toElementNode
} from "../src/dom-map.ts";
import type { ElementNode } from "../src/dom-sensitivity.ts";

const PAGE_HTML = `<!doctype html><html><body>
  <h1>Page</h1>
  <form aria-label="Signup">
    <input type="text" aria-label="Full name" value="Alice">
    <button type="submit">Go</button>
  </form>
  <button class="hidden" type="button">Hidden</button>
  <button class="offscreen" type="button">Offscreen</button>
  <a href="https://example.com">Link</a>
</body></html>`;

describe("extractStructuralMap", () => {
  test("keeps visible interactive elements and drops hidden/offscreen ones", () => {
    const { doc } = setupDom(PAGE_HTML);
    const map = extractStructuralMap(doc);

    const ids = map.map((node) => node.id);
    assert.equal(map.length, 5, "h1 + form + input + button + link");

    assert.equal(map.find((n) => n.tag === "h1")!.role, "heading");
    assert.equal(map.find((n) => n.inputType === "text")!.value, "Alice");
    assert.equal(map.find((n) => n.tag === "button" && n.value === null)!.role, "button");
    assert.equal(map.find((n) => n.tag === "a")!.role, "link");
    assert.equal(ids.length, new Set(ids).size, "ids are unique");
  });

  test("re-extraction reuses stable synthetic ids", () => {
    const { doc } = setupDom(PAGE_HTML);
    const first = extractStructuralMap(doc);
    const second = extractStructuralMap(doc);
    const firstIds = first.map((n) => n.id).sort();
    const secondIds = second.map((n) => n.id).sort();
    assert.deepEqual(firstIds, secondIds);
  });

  test("toElementNode reads live values", () => {
    const { doc, win } = setupDom(PAGE_HTML);
    const input = doc.querySelector<HTMLInputElement>("input[type=text]")!;
    const valueSetter = Object.getOwnPropertyDescriptor(
      win.HTMLInputElement.prototype,
      "value"
    )?.set;
    assert.ok(valueSetter);
    valueSetter.call(input, "Bob");
    input.dispatchEvent(new win.Event("input", { bubbles: true }));

    const node = toElementNode(doc, input);
    assert.equal(node.value, "Bob");
    assert.equal(node.inputType, "text");
  });
});

describe("mergeDeltaNodes", () => {
  test("replaces updated ids, drops removed ids, preserves order", () => {
    const cached: ElementNode[] = [
      node("a", "h1"),
      node("b", "input"),
      node("c", "button")
    ];
    const updated = [node("b", "textarea", "changed")];
    const merged = mergeDeltaNodes(cached, updated, ["c"]);

    assert.deepEqual(
      merged.map((n) => n.id),
      ["a", "b"]
    );
    assert.equal(merged[1].tag, "textarea");
    assert.equal(merged[1].ariaLabel, "changed");
  });

  test("no-op when nothing changed", () => {
    const cached: ElementNode[] = [node("a", "h1"), node("b", "input")];
    assert.deepEqual(mergeDeltaNodes(cached, [], []), cached);
  });
});

describe("findElementById", () => {
  test("finds an element by its synthetic id", () => {
    const { doc } = setupDom(PAGE_HTML);
    const map = extractStructuralMap(doc);
    assert.ok(map.length > 0);
    assert.ok(findElementById(doc, map[0].id), "lookup by synthetic id works");
  });
});

function node(id: string, tag: string, ariaLabel: string | null = null): ElementNode {
  return {
    id,
    tag,
    role: null,
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    inputType: null,
    ariaLabel,
    autocomplete: null,
    placeholder: null,
    value: null
  };
}