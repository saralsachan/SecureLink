import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decideLocalAction,
  pickSubmitElement,
  DEFAULT_TASK,
  type AgentAction
} from "../src/local-heuristics.ts";
import type { ElementNode } from "../src/dom-sensitivity.ts";

function node(id: string, partial: Partial<ElementNode> = {}): ElementNode {
  return {
    id,
    tag: "div",
    role: null,
    bbox: { x: 0, y: 0, w: 100, h: 40 },
    inputType: null,
    ariaLabel: null,
    autocomplete: null,
    placeholder: null,
    value: null,
    ...partial
  };
}

function isAction(action: AgentAction, kind: AgentAction["action"]): boolean {
  return action.action === kind;
}

describe("pickSubmitElement", () => {
  test("prefers a labelled submit-like control over the first raw button", () => {
    const map = [
      node("btn1", { tag: "button", value: "💡" }),
      node("search", {
        tag: "button",
        value: "Search",
        ariaLabel: "Search the catalog"
      }),
      node("login", { tag: "button", inputType: "submit", value: "Login" })
    ];

    assert.equal(pickSubmitElement(map)?.id, "search");
  });

  test("falls back to the first button or submit input", () => {
    const map = [
      node("btn1", { tag: "button", value: "💡" }),
      node("inp1", { tag: "input", inputType: "submit" })
    ];

    assert.equal(pickSubmitElement(map)?.id, "btn1");
  });

  test("returns null when there is no button", () => {
    const map = [node("link", { tag: "a" })];
    assert.equal(pickSubmitElement(map), null);
  });
});

describe("decideLocalAction", () => {
  test("returns none when the map is empty", () => {
    const action = decideLocalAction(DEFAULT_TASK, []);
    assert.equal(isAction(action, "none"), true);
  });

  test("clicks the first submit button for the default task", () => {
    const map = [
      node("name", { tag: "input", inputType: "text", value: "[REDACTED_NAME_1]" }),
      node("submit", { tag: "button", inputType: "submit", value: "Submit" })
    ];

    const action = decideLocalAction(DEFAULT_TASK, map);
    assert.equal(isAction(action, "click"), true);
    assert.equal(action.target_id, "submit");
    assert.equal(action.requires_confirmation, true);
  });

  test("navigates to a URL mentioned in the task before anything else", () => {
    const map = [node("submit", { tag: "button", inputType: "submit", value: "Submit" })];
    const action = decideLocalAction("go to https://example.com account", map);

    assert.equal(isAction(action, "navigate"), true);
    assert.equal(action.value, "https://example.com");
    assert.equal(action.requires_confirmation, true);
  });

  test("normalises a bare hostname to https", () => {
    const action = decideLocalAction("open example.com", []);
    assert.equal(isAction(action, "navigate"), true);
    assert.equal(action.value, "https://example.com");
  });

  test("scrolls down", () => {
    const action = decideLocalAction("scroll down", [node("x")]);
    assert.equal(isAction(action, "scroll"), true);
    assert.equal(action.value, "down");
    assert.equal(action.requires_confirmation, false);
  });

  test("types into the first empty text field", () => {
    const map = [
      node("filled", { tag: "input", inputType: "text", value: "[REDACTED_NAME_1]" }),
      node("open", {
        tag: "input",
        inputType: "email",
        value: "",
        ariaLabel: "email address"
      })
    ];

    const action = decideLocalAction('type "banana@example.com"', map);
    assert.equal(isAction(action, "type"), true);
    assert.equal(action.target_id, "open");
    assert.equal(action.value, "banana@example.com");
    assert.equal(action.requires_confirmation, true);
  });

  test("returns none when typing but no empty text field exists", () => {
    const action = decideLocalAction("type hello", [{ ...node("x"), inputType: "password" }]);
    assert.equal(isAction(action, "none"), true);
  });

  test("clicks the first link when only links are present", () => {
    const map = [node("a1", { tag: "a", ariaLabel: "Documentation" })];
    const action = decideLocalAction(DEFAULT_TASK, map);

    assert.equal(isAction(action, "click"), true);
    assert.equal(action.target_id, "a1");
    assert.match(action.reasoning, /first link/);
  });

  test("returns none when nothing is actionable", () => {
    const action = decideLocalAction(DEFAULT_TASK, [node("span", { tag: "span" })]);
    assert.equal(isAction(action, "none"), true);
    assert.ok(action.reasoning.length > 0);
  });
});