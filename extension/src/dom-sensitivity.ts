export type BoundingBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type ElementNode = {
  id: string;
  tag: string;
  role: string | null;
  bbox: BoundingBox;
  inputType: string | null;
  ariaLabel: string | null;
  autocomplete: string | null;
  placeholder: string | null;
  value: string | null;
  /**
   * Cross-document depth of the element's owning document: 0 for the top
   * document, 1 for a direct same-origin iframe, etc. Present only when the
   * element lives inside an iframe subtree.
   */
  frameDepth?: number;
  /**
   * True when the node is an <iframe> whose content could not be introspected
   * (cross-origin). The iframe itself is still listed so the model knows it
   * exists; its contents are handled by the screenshot path instead.
   */
  crossOrigin?: boolean;
};

export type SensitiveClass =
  | "password"
  | "card-number"
  | "card-cvc"
  | "email"
  | "phone"
  | "ssn"
  | "otp"
  | "passport";

export type SensitiveHit = {
  elementId: string;
  sensitivityClass: SensitiveClass;
  confidence: 1;
  source: "dom";
};

export type VisualSensitivityClass =
  | "face"
  | "email"
  | "phone"
  | "card-number"
  | "name";

export type VisualSensitivityHit = {
  bbox: BoundingBox;
  sensitivityClass: VisualSensitivityClass;
  confidence: number;
  source: "visual";
};

const AUTOCOMPLETE_SENSITIVITY: Readonly<Record<string, SensitiveClass>> = {
  "cc-number": "card-number",
  "cc-csc": "card-cvc",
  email: "email",
  tel: "phone"
};

const SENSITIVE_TEXT_PATTERN = /ssn|otp|credit card|cvv|passport/i;

const SENSITIVE_TEXT_CLASS: Readonly<Record<string, SensitiveClass>> = {
  ssn: "ssn",
  otp: "otp",
  "credit card": "card-number",
  cvv: "card-cvc",
  passport: "passport"
};

export function detectSensitiveDomElements(map: ElementNode[]): SensitiveHit[] {
  const hits: SensitiveHit[] = [];

  for (const node of map) {
    const classes = new Set<SensitiveClass>();

    if (node.inputType === "password") {
      classes.add("password");
    }

    if (node.inputType === "email") {
      classes.add("email");
    }

    if (node.inputType === "tel") {
      classes.add("phone");
    }

    for (const token of (node.autocomplete ?? "").toLowerCase().split(/\s+/)) {
      const sensitivityClass = AUTOCOMPLETE_SENSITIVITY[token];

      if (sensitivityClass) {
        classes.add(sensitivityClass);
      }
    }

    const labeledText = `${node.ariaLabel ?? ""} ${node.placeholder ?? ""}`.toLowerCase();
    const textMatch = labeledText.match(SENSITIVE_TEXT_PATTERN);

    if (textMatch) {
      const sensitivityClass = SENSITIVE_TEXT_CLASS[textMatch[0]];

      if (sensitivityClass) {
        classes.add(sensitivityClass);
      }
    }

    for (const sensitivityClass of classes) {
      hits.push({
        elementId: node.id,
        sensitivityClass,
        confidence: 1,
        source: "dom"
      });
    }
  }

  return hits;
}