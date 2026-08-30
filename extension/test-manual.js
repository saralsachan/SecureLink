(function () {
  const idAttribute = "data-securelink-id";
  const selector = [
    "input",
    "button",
    "a[href]",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "select",
    "textarea"
  ].join(",");

  let nextId = 0;

  function getSyntheticId(element) {
    const existingId = element.getAttribute(idAttribute);

    if (existingId) {
      return existingId;
    }

    let id = `el_${nextId}`;

    while (document.querySelector(`[${idAttribute}="${id}"]`)) {
      nextId += 1;
      id = `el_${nextId}`;
    }

    element.setAttribute(idAttribute, id);
    nextId += 1;
    return id;
  }

  function isVisibleInViewport(element) {
    if (element instanceof HTMLInputElement && element.type === "hidden") {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < viewportHeight &&
      rect.left < viewportWidth
    );
  }

  function inferRole(element) {
    const explicitRole = element.getAttribute("role");
    const tag = element.tagName.toLowerCase();

    if (explicitRole) return explicitRole;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "form") return "form";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      return element.type === "checkbox" || element.type === "radio"
        ? element.type
        : "textbox";
    }

    return null;
  }

  function getInputType(element) {
    if (element instanceof HTMLInputElement) return element.type;
    if (element instanceof HTMLButtonElement) return element.type || "button";
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (element instanceof HTMLSelectElement) {
      return element.multiple ? "select-multiple" : "select-one";
    }

    return null;
  }

  function getAriaLabel(element) {
    const ariaLabel = element.getAttribute("aria-label")?.trim();
    const labelledBy = element.getAttribute("aria-labelledby");

    if (ariaLabel) return ariaLabel;
    if (!labelledBy) return null;

    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");

    return label || null;
  }

  function extractStructuralMap() {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisibleInViewport)
      .map((element) => {
        const rect = element.getBoundingClientRect();

        return {
          id: getSyntheticId(element),
          tag: element.tagName.toLowerCase(),
          role: inferRole(element),
          bbox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height)
          },
          inputType: getInputType(element),
          ariaLabel: getAriaLabel(element)
        };
      });
  }

  window.extractStructuralMap = extractStructuralMap;
  console.log("Structural map:", extractStructuralMap());
})();
