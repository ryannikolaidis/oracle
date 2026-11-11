import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { verifyStrictCaptureResult } from "../../src/browser/strictCapture.js";
import type { BrowserRunResult } from "../../src/browser/types.js";

const prompt = "  café\n原文\n ";
const answer = ' {"ok":true}\n';
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const result: BrowserRunResult = {
  answerText: answer,
  answerMarkdown: answer,
  tookMs: 1,
  answerTokens: 1,
  answerChars: answer.length,
  submittedPromptHash: "fingerprint",
  submittedPromptSha256: digest(prompt),
  submittedPromptLength: Buffer.byteLength(prompt),
  submittedPromptMessageId: "user",
  submittedPromptConversationId: "conversation",
  submittedPromptObservationId: "observation",
  answerRelationship: {
    version: 1,
    relationship: "sole-assistant-after-user",
    answerCapture: "json-code",
    conversationId: "conversation",
    observationId: "observation",
    userMessageId: "user",
    userSha256: digest(prompt),
    userLength: Buffer.byteLength(prompt),
    assistantMessageId: "assistant",
    answerTextSha256: digest(answer),
    answerMarkdownSha256: digest(answer),
  },
};

test("strict success normalizes only line endings and counts UTF-8 bytes", () => {
  expect(result.submittedPromptLength).toBeGreaterThan(prompt.length);
  expect(() => verifyStrictCaptureResult(result, prompt.replace(/\n/g, "\r\n"))).not.toThrow();
  expect(() => verifyStrictCaptureResult(result, prompt.replace(/\n/g, "\r"))).not.toThrow();
});

test.each(["different prompt", prompt.trim(), prompt.replace("  ", " ")])(
  "strict success rejects a receipt for another invocation: %j",
  (invocation) => {
    expect(() => verifyStrictCaptureResult(result, invocation)).toThrow(/mismatched json-code/);
  },
);

test("strict success rejects a self-consistent character count in place of UTF-8 byte length", () => {
  const wrongLength = {
    ...result,
    submittedPromptLength: prompt.length,
    answerRelationship: { ...result.answerRelationship!, userLength: prompt.length },
  };
  expect(() => verifyStrictCaptureResult(wrongLength, prompt)).toThrow(/mismatched json-code/);
});
