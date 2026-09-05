import type {
  BoundingBox,
  VisualSensitivityHit,
  VisualSensitivityClass
} from "./dom-sensitivity.ts";

export type OcrWord = {
  text: string;
  bbox: BoundingBox;
};

export type OcrLine = {
  text: string;
  bbox: BoundingBox;
  words: OcrWord[];
};

const EMAIL_PATTERN =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

const PHONE_PATTERN =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\d-])/g;

const CARD_PATTERN = /\b(?:\d[ \u2011-]?){13,19}\b/g;

const NAME_WORD_PATTERN = /^[A-Z][a-z]{1,}$/;
const NAME_STOPWORDS = new Set([
  "The",
  "A",
  "An",
  "And",
  "Or",
  "Of",
  "To",
  "In",
  "On",
  "For",
  "With",
  "By",
  "At",
  "From",
  "As",
  "Have",
  "Has",
  "Is",
  "Are",
  "Was",
  "Were",
  "Be",
  "It",
  "This",
  "That",
  "My",
  "Your",
  "Our",
  "Their",
  "His",
  "Her",
  "Its",
  "Not",
  "No",
  "Yes",
  "Login",
  "Sign",
  "Secure",
  "Support",
  "Customer",
  "Order",
  "Balance",
  "Total",
  "Amount",
  "Address",
  "Phone",
  "Email",
  "Password",
  "About",
  "Contact",
  "Home",
  "Menu",
  "Cart",
  "Checkout",
  "Payment",
  "Shipping",
  "Track",
  "Forgot",
  "Reset",
  "Create",
  "Account",
  "Welcome",
  "Thank",
  "Please",
  "Select",
  "Choose",
  "Version",
  "Update",
  "Download",
  "Install",
  "Error",
  "Warning",
  "Success"
]);

const NAME_MIN_LENGTH = 2;
const NAME_MAX_PHRASE = 4;

const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

const CARD_MIN_LENGTH = 13;
const CARD_MAX_LENGTH = 19;

const CONFIDENCE = {
  email: 0.92,
  phone: 0.85,
  "card-number": 0.95,
  name: 0.5
} as const;

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) {
    return false;
  }

  let sum = 0;
  const parity = digits.length % 2;

  for (let i = 0; i < digits.length; i += 1) {
    let value = digits.charCodeAt(i) - 48;

    if (i % 2 === parity) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }

    sum += value;
  }

  return sum % 10 === 0;
}

type Match = {
  start: number;
  end: number;
  text: string;
};

function unionBbox(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  const x0 = Math.min(...boxes.map((box) => box.x));
  const y0 = Math.min(...boxes.map((box) => box.y));
  const x1 = Math.max(...boxes.map((box) => box.x + box.w));
  const y1 = Math.max(...boxes.map((box) => box.y + box.h));

  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function bboxForSegment(line: OcrLine, segment: string): BoundingBox {
  const segmentLower = segment.toLowerCase();
  const matchedWords = line.words.filter((word) => word.text.length > 0);
  const covered: BoundingBox[] = [];

  for (const word of matchedWords) {
    const wordLower = word.text.toLowerCase();

    if (wordLower.includes(segmentLower) || segmentLower.includes(wordLower)) {
      covered.push(word.bbox);
    } else if (segmentLower.includes(wordLower)) {
      covered.push(word.bbox);
    }
  }

  if (covered.length > 0) {
    return unionBbox(covered);
  }

  return line.bbox;
}

function pushHits(
  hits: VisualSensitivityHit[],
  seen: Set<string>,
  line: OcrLine,
  matches: Match[],
  sensitivityClass: VisualSensitivityClass,
  confidence: number
): void {
  for (const match of matches) {
    const bbox = bboxForSegment(line, match.text);

    if (bbox.w <= 0 || bbox.h <= 0) {
      continue;
    }

    const key = `${sensitivityClass}:${bbox.x}:${bbox.y}:${bbox.w}:${bbox.h}:${match.text}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    hits.push({
      bbox,
      sensitivityClass,
      confidence,
      source: "visual"
    });
  }
}

function matchEmail(line: OcrLine): Match[] {
  return [...line.text.matchAll(EMAIL_PATTERN)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    text: match[0]
  }));
}

function matchPhone(line: OcrLine): Match[] {
  const matches: Match[] = [];

  for (const match of line.text.matchAll(PHONE_PATTERN)) {
    const digits = match[0].replace(/\D/g, "");

    if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
      continue;
    }

    matches.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: match[0]
    });
  }

  return matches;
}

function digitCandidates(text: string): Match[] {
  const candidates: Match[] = [];

  for (const match of text.matchAll(CARD_PATTERN)) {
    const digits = match[0].replace(/\D/g, "");

    if (digits.length < CARD_MIN_LENGTH || digits.length > CARD_MAX_LENGTH) {
      continue;
    }

    candidates.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: match[0]
    });
  }

  return candidates;
}

function matchCard(line: OcrLine): Match[] {
  return digitCandidates(line.text).filter((candidate) =>
    luhnValid(candidate.text.replace(/\D/g, ""))
  );
}

function matchName(line: OcrLine): Match[] {
  if (hitsInLine(line, new Set(["email", "phone", "card-number"]))) {
    return [];
  }

  const words = line.text.split(/\s+/);
  const matches: Match[] = [];
  let cursor = 0;

  const wordOffsets = words.map((word) => {
    const index = line.text.indexOf(word, cursor);
    cursor = index + word.length;
    return index;
  });

  let i = 0;

  while (i < words.length) {
    if (!isNameWord(words[i])) {
      i += 1;
      continue;
    }

    let end = i;

    while (
      end + 1 < words.length &&
      end - i + 1 < NAME_MAX_PHRASE &&
      isNameWord(words[end + 1])
    ) {
      end += 1;
    }

    if (end - i + 1 < NAME_MIN_LENGTH) {
      i = end + 1;
      continue;
    }

    if (words[i].endsWith(".")) {
      i = end + 1;
      continue;
    }

    const start = wordOffsets[i];
    const lastIndex = wordOffsets[end];
    const span = `${line.text.slice(start, lastIndex + words[end].length)}`;
    const phrase = line.text
      .slice(start, lastIndex + words[end].length)
      .trim();

    if (span.includes(",") || span.includes(".") || /[0-9@]/.test(span)) {
      i = end + 1;
      continue;
    }

    matches.push({ start, end: start + phrase.length, text: phrase });
    i = end + 1;
  }

  return matches;
}

function isNameWord(word: string): boolean {
  if (NAME_STOPWORDS.has(word)) {
    return false;
  }

  return NAME_WORD_PATTERN.test(word);
}

const NON_NAME_CLASSES = new Set<VisualSensitivityClass>([
  "email",
  "phone",
  "card-number"
]);

function hitsInLine(line: OcrLine, classes: Set<VisualSensitivityClass>): boolean {
  const hasPhone = classes.has("phone") && matchPhone(line).length > 0;
  const hasEmail = classes.has("email") && matchEmail(line).length > 0;
  const hasCard = classes.has("card-number") && matchCard(line).length > 0;

  return hasPhone || hasEmail || hasCard;
}

export function classifyOcrLines(lines: OcrLine[]): VisualSensitivityHit[] {
  const hits: VisualSensitivityHit[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    pushHits(
      hits,
      seen,
      line,
      matchEmail(line),
      "email",
      CONFIDENCE.email
    );

    pushHits(
      hits,
      seen,
      line,
      matchPhone(line),
      "phone",
      CONFIDENCE.phone
    );

    pushHits(hits, seen, line, matchCard(line), "card-number", CONFIDENCE["card-number"]);

    if (!hitsInLine(line, NON_NAME_CLASSES)) {
      pushHits(hits, seen, line, matchName(line), "name", CONFIDENCE.name);
    }
  }

  return hits;
}