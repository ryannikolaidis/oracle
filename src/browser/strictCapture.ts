import type { BrowserRunResult } from "./types.js";
import { answerDigest } from "./answerBinding.js";

export function assertSupportedAnswerCapture(
  mode: "dom-text" | "json-code" | undefined,
  provider: string,
): void {
  if (mode === "json-code" && provider !== "chatgpt") {
    throw new Error("json-code answer capture is only supported by the ChatGPT browser executor");
  }
}

export function assertAttestableAttachments(
  mode: "dom-text" | "json-code" | undefined,
  attachments: readonly unknown[],
): void {
  if (mode === "json-code" && attachments.length > 0) {
    throw new Error("json-code cannot attest uploaded attachment content; use an inline prompt");
  }
}

/** Check the transport receipt without changing the attested answer bytes. */
export function verifyStrictCaptureResult(result: BrowserRunResult, expectedPrompt: string): void {
  const normalizedPrompt = expectedPrompt.replace(/\r\n?/g, "\n");
  const receipt = result.answerRelationship;
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.relationship !== "sole-assistant-after-user" ||
    receipt.answerCapture !== "json-code" ||
    !receipt.conversationId ||
    !receipt.observationId ||
    !receipt.userMessageId ||
    !receipt.assistantMessageId ||
    !result.submittedPromptHash ||
    !result.submittedPromptSha256 ||
    receipt.conversationId !== result.submittedPromptConversationId ||
    receipt.observationId !== result.submittedPromptObservationId ||
    receipt.userMessageId !== result.submittedPromptMessageId ||
    receipt.userSha256 !== result.submittedPromptSha256 ||
    receipt.userLength !== result.submittedPromptLength ||
    receipt.userSha256 !== answerDigest(normalizedPrompt) ||
    receipt.userLength !== Buffer.byteLength(normalizedPrompt, "utf8") ||
    !Number.isSafeInteger(receipt.userLength) ||
    receipt.userLength <= 0 ||
    result.answerText !== result.answerMarkdown ||
    receipt.answerTextSha256 !== answerDigest(result.answerText) ||
    receipt.answerMarkdownSha256 !== answerDigest(result.answerMarkdown)
  ) {
    throw new Error("Missing or mismatched json-code answer relationship; refusing strict success");
  }
  JSON.parse(result.answerText);
}
