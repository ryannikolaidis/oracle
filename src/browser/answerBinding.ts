import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import { browserPromptFingerprint, type SubmittedPromptEvidence } from "./promptFingerprint.js";
import {
  buildAssistantMessageIdExpression,
  buildConversationTurnListExpression,
  buildUserMessageIdExpression,
} from "./conversationTurns.js";
import { ASSISTANT_ROLE_SELECTOR } from "./constants.js";

export interface AnswerRelationship {
  version: 1;
  relationship: "sole-assistant-after-user";
  conversationId: string;
  observationId: string;
  userMessageId: string;
  userSha256: string;
  userLength: number;
  assistantMessageId: string;
  answerTextSha256: string;
  answerMarkdownSha256: string;
  /** Additive representation marker; absent on older receipts. */
  answerCapture?: "dom-text" | "json-code";
}

type Binding = SubmittedPromptEvidence & { conversationId: string; observationId: string };
const poisoned = new WeakSet<ChromeClient["Runtime"]>();
const bindings = new WeakMap<ChromeClient["Runtime"], Binding>();
// JSON capture revalidates its complete layout on each read. Its payload and identity
// are stable evidence; accepted code-header labels are presentation only.
function snapshotKey(
  snapshot: { text?: string; contentText?: string; html?: string; messageId?: string | null },
  mode: "dom-text" | "json-code" = "dom-text",
): string {
  return JSON.stringify(
    mode === "json-code"
      ? [snapshot.messageId, snapshot.text]
      : [snapshot.messageId, snapshot.text, snapshot.contentText, snapshot.html],
  );
}

const finalized = new WeakMap<
  ChromeClient["Runtime"],
  { snapshot: string; evidence: AnswerRelationship }
>();
export const answerDigest = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export function bindSubmittedAnswer(
  runtime: ChromeClient["Runtime"],
  prompt: SubmittedPromptEvidence,
): void {
  finalized.delete(runtime);
  poisoned.delete(runtime);
  bindings.delete(runtime);
  if (
    !prompt.conversationId ||
    !prompt.messageId ||
    !prompt.sha256 ||
    !prompt.fingerprint ||
    !prompt.observationId
  ) {
    throw new Error("Cannot bind answer: missing observed user/conversation identity or digest");
  }
  bindings.set(runtime, {
    ...prompt,
    conversationId: prompt.conversationId,
    observationId: prompt.observationId,
  });
}

export function hasAnswerBinding(runtime: ChromeClient["Runtime"]): boolean {
  return bindings.has(runtime);
}

export function requireAnswerBinding(runtime: ChromeClient["Runtime"]): void {
  if (poisoned.has(runtime))
    throw new Error("Observed turn changed during capture; answer binding is invalidated");
  if (!bindings.has(runtime))
    throw new Error("Cannot establish answer relationship to the observed user turn");
}

/** One synchronous DOM read: unknown, duplicated or unmounted relationships are refused. */
export function buildAnswerRelationshipExpression(): string {
  return `(() => {
    const id = node => ${buildAssistantMessageIdExpression()};
    const userSelector = ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])';
    const assistantSelector = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
    const turns = ${buildConversationTurnListExpression()};
    const messages = [];
    for (const turn of turns) {
      const nodes = [turn, ...turn.querySelectorAll(userSelector + ', ' + assistantSelector)];
      for (const node of nodes) {
        if (!node.matches(userSelector + ', ' + assistantSelector)) continue;
        if (messages.some(item => item.node === node || item.node.contains(node))) continue;
        messages.push({ node, role: node.matches(userSelector) ? 'user' : 'assistant' });
      }
    }
    const users = messages.filter(item => item.role === 'user');
    const user = users.at(-1)?.node;
    const after = messages.slice(messages.findIndex(item => item.node === user) + 1);
    return {
      conversationId: location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
      userMessageId: ${buildUserMessageIdExpression()},
      userIds: users.map(item => { const user = item.node; return ${buildUserMessageIdExpression()}; }),
      userText: user ? (user.querySelector('[data-user-message-bubble="true"]') || user).textContent : null,
      assistantIds: after.map(item => id(item.node)),
      roles: after.map(item => item.role),
    };
  })()`;
}

type RelationshipRead = {
  conversationId?: string;
  userMessageId?: string;
  userIds?: string[];
  userText?: string;
  assistantIds?: string[];
  roles?: string[];
};

function validate(
  binding: Binding,
  read: RelationshipRead | undefined,
  messageId?: string | null,
): void {
  const text = read?.userText?.replace(/\r\n?/g, "\n");
  if (
    !read ||
    read.conversationId !== binding.conversationId ||
    read.userMessageId !== binding.messageId ||
    read.userIds?.filter((id) => id === binding.messageId).length !== 1 ||
    typeof text !== "string" ||
    answerDigest(text) !== binding.sha256 ||
    Buffer.byteLength(text, "utf8") !== binding.length ||
    browserPromptFingerprint(text, binding.messageId) !== binding.fingerprint ||
    !Array.isArray(read.roles) ||
    read.roles.some((role) => role !== "assistant") ||
    !Array.isArray(read.assistantIds) ||
    read.assistantIds.length > 1 ||
    read.assistantIds.some((id) => typeof id !== "string" || !id.trim()) ||
    (messageId !== undefined &&
      (!messageId || read.assistantIds.length !== 1 || read.assistantIds[0] !== messageId))
  ) {
    throw new Error(
      "Answer binding rejected: conversation/user changed, edited, missing, intervening or ambiguous turn, or unrelated assistant",
    );
  }
}

/** Guard observers, snapshots and copy in the same browser evaluation, including async recovery. */
export async function evaluateBoundAnswer(
  runtime: ChromeClient["Runtime"],
  params: Parameters<ChromeClient["Runtime"]["evaluate"]>[0],
  messageId?: string | null,
): ReturnType<ChromeClient["Runtime"]["evaluate"]> {
  const binding = bindings.get(runtime);
  if (!binding) return runtime.evaluate(params); // Non-session DOM utilities retain their legacy interface.
  requireAnswerBinding(runtime);
  const read = buildAnswerRelationshipExpression();
  const response = await runtime.evaluate({
    ...params,
    expression: `(async () => {
      const observation = globalThis.__oraclePromptObservations?.get(${JSON.stringify(binding.observationId)});
      const before = ${read};
      const value = await (${params.expression});
      const after = ${read};
      return { before, value, after, observationValid: observation?.invalidated === false && observation.conversationId === ${JSON.stringify(binding.conversationId)} };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const envelope = response.result?.value;
  try {
    if (envelope?.observationValid !== true)
      throw new Error(
        "Original user-turn observation lost or invalidated; cannot establish answer relationship after navigation/recovery",
      );
    validate(binding, envelope?.before);
    validate(binding, envelope?.after);
    const selectedId =
      messageId !== undefined
        ? messageId
        : envelope.value == null
          ? undefined
          : typeof envelope.value === "object" && typeof envelope.value.text === "string"
            ? (envelope.value.messageId ?? null)
            : null;
    if (selectedId !== undefined) {
      if (messageId !== undefined) validate(binding, envelope?.before, selectedId);
      validate(binding, envelope?.after, selectedId);
    }
  } catch (error) {
    poisoned.add(runtime);
    throw error;
  }
  return { ...response, result: { ...response.result, value: envelope.value } };
}

export function recordBoundAnswer(
  runtime: ChromeClient["Runtime"],
  snapshot: { text?: string; contentText?: string; html?: string; messageId?: string | null },
  answerText: string,
  answerMarkdown: string,
  answerCapture: "dom-text" | "json-code" = "dom-text",
): AnswerRelationship {
  requireAnswerBinding(runtime);
  const binding = bindings.get(runtime)!;
  if (!snapshot.messageId) throw new Error("Answer has no verifiable assistant identity");
  const evidence: AnswerRelationship = {
    version: 1,
    relationship: "sole-assistant-after-user",
    conversationId: binding.conversationId,
    observationId: binding.observationId,
    userMessageId: binding.messageId,
    userSha256: binding.sha256,
    userLength: binding.length,
    assistantMessageId: snapshot.messageId,
    answerTextSha256: answerDigest(answerText),
    answerMarkdownSha256: answerDigest(answerMarkdown),
    answerCapture,
  };
  Object.freeze(evidence);
  finalized.set(runtime, { snapshot: snapshotKey(snapshot, answerCapture), evidence });
  return evidence;
}

export function recheckBoundAnswer(
  runtime: ChromeClient["Runtime"],
  snapshot: {
    text?: string;
    contentText?: string;
    html?: string;
    messageId?: string | null;
  } | null,
  answerText: string,
  answerMarkdown: string,
): AnswerRelationship {
  const saved = finalized.get(runtime);
  if (
    !saved ||
    !snapshot ||
    saved.snapshot !== snapshotKey(snapshot, saved.evidence.answerCapture) ||
    saved.evidence.answerTextSha256 !== answerDigest(answerText) ||
    saved.evidence.answerMarkdownSha256 !== answerDigest(answerMarkdown)
  ) {
    throw new Error("Answer changed after relationship verification; refusing successful return");
  }
  return saved.evidence;
}

export function restoreAnswerBinding(
  runtime: ChromeClient["Runtime"],
  metadata: {
    submittedPromptHash?: string | null;
    submittedPromptSha256?: string | null;
    submittedPromptLength?: number | null;
    submittedPromptMessageId?: string | null;
    submittedPromptConversationId?: string | null;
    submittedPromptObservationId?: string | null;
  },
): void {
  if (
    !metadata.submittedPromptHash ||
    !metadata.submittedPromptSha256 ||
    !metadata.submittedPromptMessageId ||
    !metadata.submittedPromptConversationId ||
    !metadata.submittedPromptObservationId ||
    typeof metadata.submittedPromptLength !== "number"
  ) {
    throw new Error(
      "Saved session has no verifiable observed user/conversation binding; inspect legacy output as candidate data only",
    );
  }
  bindSubmittedAnswer(runtime, {
    fingerprint: metadata.submittedPromptHash,
    sha256: metadata.submittedPromptSha256,
    length: metadata.submittedPromptLength,
    messageId: metadata.submittedPromptMessageId,
    conversationId: metadata.submittedPromptConversationId,
    observationId: metadata.submittedPromptObservationId,
  });
}
