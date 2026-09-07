/**
 * Minimal jsdom setup used by DOM-facing unit tests (delta, dom-map).
 * Exposes jsdom's DOM classes as Node globals (the pipeline modules reference
 * bare `HTMLElement`, `MutationObserver`, `CSS`, …), polyfills CSS.escape, and
 * stubs layout so visibility checks behave like a rendered page.
 */
import { JSDOM, VirtualConsole } from "jsdom";

export type DomSetup = {
  doc: Document;
  win: Window & typeof globalThis;
};

const DOM_GLOBALS = [
  "HTMLElement",
  "Element",
  "Node",
  "Document",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLAnchorElement",
  "HTMLIFrameElement",
  "MutationObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
];

/**
 * Give *win* deterministic layout so visibility checks behave like a rendered
 * page. Call again on any extra window (e.g. an iframe's inner window).
 */
export function installRectStub(win: unknown): void {
  const anyWindow = win as { HTMLElement: { prototype: HTMLElement } };
  anyWindow.HTMLElement.prototype.getBoundingClientRect = function () {
    const cls = String((this as Element).className ?? "");
    if (/hidden|offscreen/.test(cls)) {
      return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } as DOMRect;
    }
    return { x: 40, y: 40, width: 180, height: 36, left: 40, top: 40, right: 220, bottom: 76 } as DOMRect;
  };
}

export function setupDom(html: string, url = "http://localhost/test.html"): DomSetup {
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });

  const anyWindow = dom.window as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    (globalThis as unknown as Record<string, unknown>)[name] = anyWindow[name];
  }

  if (!anyWindow.CSS) {
    anyWindow.CSS = {};
  }
  const css = anyWindow.CSS as { escape: (value: string) => string };
  css.escape = (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  anyWindow.CSS = css;
  (globalThis as unknown as Record<string, unknown>).CSS = anyWindow.CSS;

  installRectStub(dom.window);

  return { doc: (anyWindow.document as Document), win: dom.window as unknown as Window & typeof globalThis };
}