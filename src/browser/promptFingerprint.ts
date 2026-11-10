import { buildPromptObservationExpression } from "./promptObservation.js";
import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import {
  buildConversationTurnListExpression,
  buildUserMessageIdExpression,
} from "./conversationTurns.js";

export function browserPromptFingerprint(value: unknown, messageId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([messageId, String(value ?? "").replace(/\r\n?/g, "\n")]))
    .digest("hex");
}

export function readUserMessageIds(
  runtime: ChromeClient["Runtime"],
  timeoutMs = 0,
): Promise<string[] | undefined> {
  return readDomUntil(
    runtime,
    `Array.from(document.querySelectorAll(':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])'), user => user.getAttribute('data-message-id') || user.getAttribute('data-chatgpt-selection-message-id') || user.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || user.closest('[data-turn-key]')?.getAttribute('data-turn-key') || (user.getAttribute('data-content-search-unit-key') || user.getAttribute('data-chatgpt-search-unit-key')))`,
    timeoutMs,
    (value) =>
      Array.isArray(value) && value.every((id) => typeof id === "string" && id.trim())
        ? (value as string[])
        : undefined,
  );
}

export interface SubmittedPromptEvidence {
  fingerprint: string;
  sha256: string;
  /** UTF-8 byte length after CRLF and lone CR are converted to LF. */
  length: number;
  messageId: string;
  conversationId?: string;
  observationId?: string;
}

/** Failure-only telemetry. Never a substitute for SubmittedPromptEvidence. */
export interface PromptAssociationFailure {
  version: 1;
  outcome: "rejected" | "timeout" | "evaluation-error";
  reason:
    | "baseline-unavailable"
    | "submission-unavailable"
    | "missing-identity"
    | "multiple-fresh-users"
    | "text-mismatch"
    | "no-fresh-user"
    | "continuity-unavailable"
    | "evaluation-error"
    | "context-unavailable"
    | "unreadable-result";
  attempts: number;
  baselineAvailable: boolean;
  expectedLength?: number;
  expectedSha256?: string;
  observedLength?: number;
  observedSha256?: string;
  rawCandidates?: number;
  canonicalCandidates?: number;
  freshCandidates?: number;
  missingIdentities?: number;
  bubbleCount?: number;
  brCount?: number;
  blockCount?: number;
  conversationAvailable?: boolean;
  observationAvailable?: boolean;
}

type FailureReporter = (failure: PromptAssociationFailure) => void;
type ReadFailure = (
  outcome: PromptAssociationFailure["outcome"],
  value: unknown,
  attempts: number,
  contextUnavailable?: boolean,
) => void;

// Copy an allowlist only. Page values and exception messages must never leak into metadata.
function associationFailure(
  outcome: PromptAssociationFailure["outcome"],
  value: unknown,
  attempts: number,
  previousMessageIds: readonly string[] | undefined,
  submittedPrompt: string | undefined,
  contextUnavailable = false,
): PromptAssociationFailure {
  const read = value as {
    diagnostic?: Record<string, unknown>;
    text?: unknown;
    conversationId?: unknown;
    observationId?: unknown;
  } | null;
  const diagnostic = read?.diagnostic;
  const reasons: PromptAssociationFailure["reason"][] = [
    "missing-identity",
    "multiple-fresh-users",
    "text-mismatch",
    "no-fresh-user",
  ];
  const reason: PromptAssociationFailure["reason"] =
    previousMessageIds === undefined
      ? "baseline-unavailable"
      : typeof submittedPrompt !== "string"
        ? "submission-unavailable"
        : outcome === "evaluation-error"
          ? "evaluation-error"
          : contextUnavailable
            ? "context-unavailable"
            : reasons.includes(diagnostic?.reason as PromptAssociationFailure["reason"])
              ? (diagnostic!.reason as PromptAssociationFailure["reason"])
              : typeof read?.text === "string"
                ? "continuity-unavailable"
                : "unreadable-result";
  const failure: PromptAssociationFailure = {
    version: 1,
    outcome,
    reason,
    attempts: Math.min(1_000_000, Math.max(0, attempts)),
    baselineAvailable: previousMessageIds !== undefined,
  };
  if (typeof submittedPrompt === "string") {
    const text = submittedPrompt.replace(/\r\n?/g, "\n");
    failure.expectedLength = Buffer.byteLength(text, "utf8");
    failure.expectedSha256 = createHash("sha256").update(text, "utf8").digest("hex");
  }
  // The DOM expression returns text only for a sole identified fresh candidate.
  if (typeof read?.text === "string") {
    const text = read.text.replace(/\r\n?/g, "\n");
    failure.observedLength = Buffer.byteLength(text, "utf8");
    failure.observedSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    failure.conversationAvailable =
      typeof read.conversationId === "string" && !!read.conversationId.trim();
    failure.observationAvailable =
      typeof read.observationId === "string" && !!read.observationId.trim();
  }
  for (const key of [
    "rawCandidates",
    "canonicalCandidates",
    "freshCandidates",
    "missingIdentities",
    "bubbleCount",
    "brCount",
    "blockCount",
  ] as const) {
    const count = diagnostic?.[key];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0)
      failure[key] = Math.min(1_000_000, Math.floor(count));
  }
  for (const key of ["conversationAvailable", "observationAvailable"] as const) {
    const available = diagnostic?.[key];
    if (typeof available === "boolean") failure[key] = available;
  }
  return failure;
}

// Preserve the existing fingerprint-only interface for callers such as tab harvest.
export async function readSubmittedPromptFingerprint(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
): Promise<string | undefined> {
  return (await readSubmittedPromptEvidence(runtime, previousMessageIds, timeoutMs))?.fingerprint;
}

/**
 * Bind only one fresh user turn to the actual submission. Normalize CRLF/lone CR
 * to LF only: spaces, tabs, trailing newlines, case and Unicode remain significant.
 * Conversation and observation identity must come from that same DOM read.
 */
export function readBoundSubmittedPromptEvidence(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  submittedPrompt: string,
  timeoutMs = 0,
  onFailure?: FailureReporter,
): Promise<SubmittedPromptEvidence | undefined> {
  return readSubmittedPromptEvidence(
    runtime,
    previousMessageIds,
    timeoutMs,
    true,
    submittedPrompt,
    onFailure,
  );
}

/** Read both digests from one fresh DOM turn; never substitute requested prompt text. */
export async function readSubmittedPromptEvidence(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
  requireContinuity = false,
  submittedPrompt?: string,
  onFailure?: FailureReporter,
): Promise<SubmittedPromptEvidence | undefined> {
  if (
    previousMessageIds === undefined ||
    (requireContinuity && typeof submittedPrompt !== "string")
  ) {
    if (requireContinuity)
      onFailure?.(associationFailure("rejected", null, 0, previousMessageIds, submittedPrompt));
    return undefined;
  }
  const previous = new Set(previousMessageIds);
  const normalizedSubmittedPrompt = submittedPrompt?.replace(/\r\n?/g, "\n");
  return readDomUntil(
    runtime,
    `(() => {
        const diagnostic = {};
        const turns = ${
          requireContinuity
            ? `(() => {
          const selector = ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])';
          const raw = Array.from(document.querySelectorAll(selector));
          const users = raw.filter(user => {
            const owner = user.parentElement?.closest(selector);
            // Nested role wrappers in one turn represent one message. Separate
            // turns stay distinct even when their text or reported IDs agree.
            return !owner || owner.closest('[data-turn-key]') !== user.closest('[data-turn-key]');
          });
          const previous = ${JSON.stringify([...previous])};
          const fresh = [];
          let missingIdentities = 0;
          for (const user of users) {
            const id = ${buildUserMessageIdExpression()};
            // An unidentified user could be a competing submission. Never skip it.
            if (typeof id !== 'string' || !id.trim()) missingIdentities++;
            else if (!previous.includes(id)) fresh.push(user);
          }
          Object.assign(diagnostic, { rawCandidates: raw.length, canonicalCandidates: users.length,
            freshCandidates: fresh.length, missingIdentities });
          if (missingIdentities) { diagnostic.reason = 'missing-identity'; return null; }
          if (fresh.length > 1) { diagnostic.reason = 'multiple-fresh-users'; return null; }
          if (!fresh.length) diagnostic.reason = 'no-fresh-user';
          return fresh;
        })()`
            : buildConversationTurnListExpression()
        };
        if (turns === null) return { associationRejected: true, diagnostic };
        for (let index = turns.length - 1; index >= 0; index--) {
          const turn = turns[index];
          const user = turn.matches(':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])') ? turn : turn.querySelector(':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])');
          if (user) {
            const messageId = ${buildUserMessageIdExpression()};
            if (${JSON.stringify([...previous])}.includes(messageId)) return null;
            ${
              requireContinuity
                ? `const bubble = user.querySelector('[data-user-message-bubble="true"]') || user;
            const text = bubble.textContent;
            const conversationId = typeof location === 'object' && typeof location.href === 'string'
              ? location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] : undefined;
            Object.assign(diagnostic, {
              bubbleCount: user.querySelectorAll('[data-user-message-bubble="true"]').length,
              brCount: bubble.querySelectorAll('br').length,
              blockCount: bubble.querySelectorAll('div, p, pre, li, blockquote').length,
              conversationAvailable: typeof conversationId === 'string' && !!conversationId,
              observationAvailable: false,
            });
            if (typeof text !== 'string' || text.replace(/\\r\\n?/g, '\\n') !== ${JSON.stringify(normalizedSubmittedPrompt)})
              return { associationRejected: true, diagnostic: { ...diagnostic, reason: 'text-mismatch' }, text, conversationId };`
                : ""
            }
            const observationId = ${requireContinuity ? `typeof location === 'object' ? ${buildPromptObservationExpression()} : undefined` : "undefined"};
            if (${requireContinuity}) diagnostic.observationAvailable = typeof observationId === 'string' && !!observationId;
            return {
              diagnostic,
              observationId,
              conversationId: typeof location === 'object' && typeof location.href === 'string' ? location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] : undefined,
              text: (user.querySelector('[data-user-message-bubble="true"]') || user).textContent,
              messageId,
            };
          }
        }
        return ${requireContinuity ? "{ diagnostic }" : "null"};
      })()`,
    timeoutMs,
    (value) => {
      const turn = value as {
        text?: unknown;
        messageId?: unknown;
        conversationId?: unknown;
        observationId?: unknown;
      } | null;
      if (
        typeof turn?.text === "string" &&
        turn.text.trim() &&
        typeof turn.messageId === "string" &&
        turn.messageId.trim() &&
        !previous.has(turn.messageId) &&
        (!requireContinuity || turn.text.replace(/\r\n?/g, "\n") === normalizedSubmittedPrompt) &&
        (!requireContinuity ||
          (typeof turn.conversationId === "string" &&
            turn.conversationId.trim() &&
            typeof turn.observationId === "string" &&
            turn.observationId.trim()))
      ) {
        // Match the legacy fingerprint's line-ending normalization only. Preserve
        // case, spaces, tabs, trailing newlines and Unicode without trimming.
        const text = turn.text.replace(/\r\n?/g, "\n");
        return {
          fingerprint: browserPromptFingerprint(turn.text, turn.messageId),
          sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          length: Buffer.byteLength(text, "utf8"),
          messageId: turn.messageId,
          ...(typeof turn.observationId === "string" ? { observationId: turn.observationId } : {}),
          ...(typeof turn.conversationId === "string"
            ? { conversationId: turn.conversationId }
            : {}),
        };
      }
      return undefined;
    },
    requireContinuity
      ? (value) => (value as { associationRejected?: unknown } | null)?.associationRejected === true
      : undefined,
    requireContinuity && onFailure
      ? (outcome, value, attempts, contextUnavailable) =>
          onFailure(
            associationFailure(
              outcome,
              value,
              attempts,
              previousMessageIds,
              submittedPrompt,
              contextUnavailable,
            ),
          )
      : undefined,
  );
}

async function readDomUntil<T>(
  runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutMs: number,
  select: (value: unknown) => T | undefined,
  reject?: (value: unknown) => boolean,
  onFailure?: ReadFailure,
): Promise<T | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let attempts = 0;
  let lastValue: unknown;
  let contextUnavailable = false;
  for (;;) {
    attempts++;
    try {
      const result = await runtime.evaluate({ expression, returnByValue: true });
      contextUnavailable = false;
      lastValue = result.result?.value;
      if (onFailure && result.exceptionDetails) {
        onFailure("evaluation-error", null, attempts);
        return undefined;
      }
      if (reject?.(lastValue)) {
        onFailure?.("rejected", lastValue, attempts);
        return undefined;
      }
      const selected = select(result.result?.value);
      if (selected !== undefined) return selected;
    } catch (error) {
      lastValue = undefined;
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/Cannot find (?:default )?(?:execution )?context|Execution context (?:was destroyed|is not available)/i.test(
          message,
        )
      ) {
        onFailure?.("evaluation-error", null, attempts);
        return undefined;
      }
      contextUnavailable = true;
    }
    if (Date.now() >= deadline) {
      onFailure?.("timeout", lastValue, attempts, contextUnavailable);
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}
