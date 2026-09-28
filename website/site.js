/* SecureLink showcase — client interactions. Vanilla JS, no dependencies. */
(function () {
  "use strict";

  /* Header: subtle shadow once the page scrolls. */
  var header = document.querySelector(".site-header");
  if (header) {
    window.addEventListener(
      "scroll",
      function () {
        header.classList.toggle("scrolled", window.scrollY > 8);
      },
      { passive: true }
    );
  }

  /* ── Live redaction micro-demo ───────────────────────────────────────── */
  var RULES = [
    { type: "card", re: /\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}/g, label: "Card number" },
    { type: "ssn", re: /\d{3}-\d{2}-\d{4}/g, label: "SSN" },
    { type: "email", re: /\S+@\S+\.\S+/g, label: "Email" },
    {
      type: "phone",
      re: /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/g,
      label: "Phone number"
    },
    {
      type: "secret",
      re: /\b(?:pass(?:word)?|pwd|secret|api[- ]?key)\b/gi,
      label: "Secret"
    }
  ];

  var counters = {};
  var matchedTypes = new Set();

  var input = document.getElementById("demo-input");
  var raw = document.getElementById("demo-raw");
  var fields = document.getElementById("demo-fields");
  var auditList = document.getElementById("demo-audit-list");
  var countEl = document.getElementById("demo-count");
  var sampleBtn = document.getElementById("demo-sample");

  function esc(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function tokenRe() {
    return /\[REDACTED_[A-Z_]+_\d+\]/g;
  }

  function renderRaw(output) {
    raw.replaceChildren();
    if (!output) {
      var ph = document.createElement("span");
      ph.className = "demo-placeholder";
      ph.textContent = "Your message appears here, redacted.";
      raw.appendChild(ph);
      return;
    }
    var parts = output.split(tokenRe());
    var tokens = output.match(tokenRe());
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) raw.appendChild(document.createTextNode(esc(parts[i])));
      if (tokens && tokens[i]) {
        var tok = document.createElement("span");
        tok.className = "tok";
        tok.textContent = tokens[i];
        raw.appendChild(tok);
      }
    }
  }

  function renderFields() {
    fields.replaceChildren();
    var types = Array.from(matchedTypes);
    types.forEach(function (type) {
      var rule = RULES.find(function (r) { return r.type === type; });
      var chip = document.createElement("span");
      chip.className = "field-chip";
      chip.textContent = (rule ? rule.label + " · " : type + " · ") + counters[type] + " masked";
      fields.appendChild(chip);
    });
  }

  function addAudit(line, kind) {
    var empty = auditList.querySelector(".audit-empty");
    if (empty) empty.remove();
    var li = document.createElement("li");
    if (kind) {
      var badge = document.createElement("span");
      badge.className = "badge badge-" + kind;
      badge.textContent = kind;
      li.appendChild(badge);
    }
    li.appendChild(document.createTextNode(line));
    auditList.prepend(li);
    if (auditList.children.length > 6) auditList.lastElementChild.remove();
  }

  function tokenize(text) {
    var out = text;
    var hits = [];
    RULES.forEach(function (rule) {
      var seen = 0;
      out = out.replace(rule.re, function () {
        counters[rule.type] = (counters[rule.type] || 0) + 1;
        seen += 1;
        matchedTypes.add(rule.type);
        return "[REDACTED_" + rule.type.toUpperCase() + "_" + counters[rule.type] + "]";
      });
      if (seen > 0) {
        hits.push({ label: rule.label, type: rule.type, count: seen });
      }
    });
    return { out: out, hits: hits };
  }

  function run(text) {
    var result = tokenize(text);
    renderRaw(result.out);
    renderFields();
    countEl.textContent = String(matchedTypes.size);

    if (!text.trim()) {
      return;
    }
    if (result.hits.length === 0) {
      addAudit("Nothing sensitive detected — not a single token needed.", null);
    } else {
      result.hits.forEach(function (hit) {
        addAudit(
          hit.label + " → [REDACTED_" + hit.type.toUpperCase() + "] · kept on-device, never sent",
          "redaction"
        );
      });
    }
  }

  var form = document.getElementById("mini-demo");
  if (form && input) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      run(input.value);
    });
    input.addEventListener("input", function () {
      if (input.value) run(input.value);
    });

    if (sampleBtn) {
      sampleBtn.addEventListener("click", function () {
        input.value = "Hi, my email is sarah@acme.com and my card is 4111 1111 1111 1111. Call 555-010-1234. I logged in with password.";
        run(input.value);
        input.focus();
      });
    }
  }
})();