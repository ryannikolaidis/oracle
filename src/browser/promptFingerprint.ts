import { buildPromptObservationExpression } from "./promptObservation.js";
import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import { buildConversationTurnListExpression, buildUserMessageIdExpression } from "./conversationTurns.js";

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

// Preserve the existing fingerprint-only interface for callers such as tab harvest.
export async function readSubmittedPromptFingerprint(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
): Promise<string | undefined> {
  return (await readSubmittedPromptEvidence(runtime, previousMessageIds, timeoutMs))?.fingerprint;
}

/** Session binding requires the conversation and observation from the same DOM read. */
export function readBoundSubmittedPromptEvidence(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
): Promise<SubmittedPromptEvidence | undefined> {
  return readSubmittedPromptEvidence(runtime, previousMessageIds, timeoutMs, true);
}

/** Read both digests from one fresh DOM turn; never substitute requested prompt text. */
export async function readSubmittedPromptEvidence(
  runtime: ChromeClient["Runtime"],
  previousMessageIds: readonly string[] | undefined,
  timeoutMs = 0,
  requireContinuity = false,
): Promise<SubmittedPromptEvidence | undefined> {
  if (previousMessageIds === undefined) return undefined;
  const previous = new Set(previousMessageIds);
  return readDomUntil(
    runtime,
    `(() => {
        const turns = ${buildConversationTurnListExpression()};
        for (let index = turns.length - 1; index >= 0; index--) {
          const turn = turns[index];
          const user = turn.matches(':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])') ? turn : turn.querySelector(':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])');
          if (user) {
            const messageId = ${buildUserMessageIdExpression()};
            if (${JSON.stringify([...previous])}.includes(messageId)) return null;
            return {
              observationId: ${requireContinuity ? `typeof location === 'object' ? ${buildPromptObservationExpression()} : undefined` : "undefined"},
              conversationId: typeof location === 'object' && typeof location.href === 'string' ? location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] : undefined,
              text: (user.querySelector('[data-user-message-bubble="true"]') || user).textContent,
              messageId,
            };
          }
        }
        return null;
      })()`,
    timeoutMs,
    (value) => {
      const turn = value as { text?: unknown; messageId?: unknown; conversationId?: unknown; observationId?: unknown } | null;
      if (
        typeof turn?.text === "string" &&
        turn.text.trim() &&
        typeof turn.messageId === "string" &&
        turn.messageId.trim() &&
        !previous.has(turn.messageId) &&
        (!requireContinuity || (
          typeof turn.conversationId === "string" && turn.conversationId.trim() &&
          typeof turn.observationId === "string" && turn.observationId.trim()
        ))
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
          ...(typeof turn.conversationId === "string" ? { conversationId: turn.conversationId } : {}),
        };
      }
      return undefined;
    },
  );
}

async function readDomUntil<T>(
  runtime: ChromeClient["Runtime"],
  expression: string,
  timeoutMs: number,
  select: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      const result = await runtime.evaluate({ expression, returnByValue: true });
      const selected = select(result.result?.value);
      if (selected !== undefined) return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/Cannot find (?:default )?(?:execution )?context|Execution context (?:was destroyed|is not available)/i.test(
          message,
        )
      )
        return undefined;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}
