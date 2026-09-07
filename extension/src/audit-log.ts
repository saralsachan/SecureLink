/**
 * Audit log — user-facing transparency trail for the current session.
 *
 * Every redaction event and every executed action is appended (by the content
 * script) to a per-session structured log persisted in `chrome.storage.session`
 * and mirrored to the popup, which renders it timestamped in the Audit Log
 * panel. Storage functions are defensive (never throw into the pipeline), so a
 * storage failure degrades to "audit skipped" instead of breaking the agent.
 *
 * Only tokens and non-secret summaries are logged — raw sensitive values are
 * never written here, so the log itself is safe to display.
 */
import type { ElementNode } from "./dom-sensitivity.ts";
import { extractRedactionTokens } from "./redaction.ts";

export type AuditEventKind = "redaction" | "action" | "info";

export type AuditLogEntry = {
  /** Monotonic per-session sequence number (ordering + dedupe aid). */
  seq: number;
  /** Epoch millis when the event happened. */
  ts: number;
  kind: AuditEventKind;
  /** Human-readable summary, safe to display (no raw sensitive values). */
  text: string;
};

export type AuditUpdateMessage = {
  type: "SECURELINK_AUDIT_UPDATE";
  sessionId: string;
  entries: AuditLogEntry[];
};

export const AUDIT_MAX_ENTRIES = 500;
const AUDIT_STORAGE_PREFIX = "securelink:audit:";

export function auditStorageKey(sessionId: string): string {
  return `${AUDIT_STORAGE_PREFIX}${sessionId}`;
}

/** Keep only the most recent *max* entries (oldest dropped). */
export function capAuditEntries(
  entries: readonly AuditLogEntry[],
  max = AUDIT_MAX_ENTRIES
): AuditLogEntry[] {
  return entries.length > max ? entries.slice(entries.length - max) : [...entries];
}

export function formatAuditTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Build the human-readable redaction summaries for *ids* within *map*.
 * One entry per element that actually carries a token (the value, placeholder
 * and label fields can all be tokenized by the same redaction, so they collapse
 * into a single event rather than noisy duplicates).
 */
export function redactionAuditTexts(
  map: readonly ElementNode[],
  ids: readonly string[]
): string[] {
  const byId = new Map(map.map((node) => [node.id, node]));
  const texts: string[] = [];

  for (const id of ids) {
    const node = byId.get(id);

    if (!node) {
      continue;
    }

    const fields: Array<{ value: string | null }> = [
      { value: node.value },
      { value: node.placeholder },
      { value: node.ariaLabel }
    ];
    const tokens = fields.flatMap((field) => extractRedactionTokens(field.value));

    if (tokens.length === 0) {
      continue;
    }

    const token = tokens[0];
    const tokenClass = token
      .replace(/^\[REDACTED_/, "")
      .replace(/_\d+\]$/, "")
      .toLowerCase()
      .replace(/_/g, "-");

    // The label may itself have been tokenized (redaction rewrites ariaLabel);
    // fall back to the element id so the entry stays readable.
    let label = node.ariaLabel || node.placeholder || node.id;
    if (extractRedactionTokens(label).length > 0) {
      label = node.id;
    }

    texts.push(
      `Redacted ${tokenClass} on <${node.tag}> ${label} -> ${token}`
    );
  }

  return texts;
}

// ── Chrome-backed persistence (defensive: never throws into the pipeline) ────

export async function readAuditEntries(sessionId: string): Promise<AuditLogEntry[]> {
  try {
    const key = auditStorageKey(sessionId);
    const stored = await chrome.storage.session.get(key);
    const entries = stored?.[key] as AuditLogEntry[] | undefined;
    return Array.isArray(entries) ? entries : [];
  } catch (error) {
    console.warn("SecureLink audit: could not read log.", error);
    return [];
  }
}

export async function appendAuditEntries(
  sessionId: string,
  entries: readonly AuditLogEntry[]
): Promise<void> {
  if (!sessionId || entries.length === 0) {
    return;
  }

  try {
    const key = auditStorageKey(sessionId);
    const stored = await chrome.storage.session.get(key);
    const existing = (stored?.[key] as AuditLogEntry[] | undefined) ?? [];
    const merged = capAuditEntries([...existing, ...entries], AUDIT_MAX_ENTRIES);

    await chrome.storage.session.set({ [key]: merged });

    try {
      const message: AuditUpdateMessage = {
        type: "SECURELINK_AUDIT_UPDATE",
        sessionId,
        entries: merged
      };
      await chrome.runtime.sendMessage(message);
    } catch {
      // Popup closed — the entry is already persisted for the next open.
    }
  } catch (error) {
    console.warn("SecureLink audit: could not append log entries.", error);
  }
}

export async function clearAuditEntries(sessionId: string): Promise<void> {
  try {
    await chrome.storage.session.remove(auditStorageKey(sessionId));
  } catch (error) {
    console.warn("SecureLink audit: could not clear log.", error);
  }
}