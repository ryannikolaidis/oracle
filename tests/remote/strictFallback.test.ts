import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { createRemoteServer } from "../../src/remote/server.js";
import { runBrowserMode, runSubmissionWithRecoveryForTest } from "../../src/browser/index.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { BrowserRunResult } from "../../src/browser/types.js";
import type { RemoteRunPayload } from "../../src/remote/types.js";

const prompt = "inline source";
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

test.each([undefined, { format: "zip", scope: "all" } as const])(
  "strict client omits unreadable fallback before serialization or bundle negotiation: %o",
  async (pendingBundle) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-strict-fallback-"));
    const requests: string[] = [];
    let received: RemoteRunPayload | undefined;
    const server = http.createServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString());
      res.end(`${JSON.stringify({ type: "result", result })}\n`);
    });
    const prepare = vi.fn(async () => {
      throw new Error("unsupported fallback preparation");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const actual = await createRemoteBrowserExecutor({
        host: `127.0.0.1:${address.port}`,
        token: "strict",
      })({
        prompt,
        config: { answerCapture: "json-code" },
        fallbackSubmission: {
          prompt: "upload instead",
          attachments: [
            {
              path: path.join(root, "missing-private-source.txt"),
              displayPath: "private-source.txt",
            },
          ],
          pendingBundle,
          prepare,
        },
      });
      expect(actual.answerText).toBe(answer);
      expect(actual.answerRelationship).toEqual(result.answerRelationship);
      expect(requests).toEqual(["POST /runs"]);
      expect(received?.prompt).toBe(prompt);
      expect(received?.attachments).toEqual([]);
      expect(received).not.toHaveProperty("fallbackSubmission");
      expect(JSON.stringify(received)).not.toContain("private-source");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "strict remote admission discards fallback before staging, including oversized inline failure: %s",
  async (oversized) => {
    const tooLarge = new BrowserAutomationError("inline too large", { code: "prompt-too-large" });
    const submit = vi.fn().mockRejectedValue(tooLarge);
    const clear = vi.fn(async () => {});
    const runBrowser = vi.fn(async (options: Parameters<typeof runBrowserMode>[0]) => {
      expect(options.fallbackSubmission).toBeUndefined();
      if (oversized) {
        await runSubmissionWithRecoveryForTest({
          prompt: options.prompt,
          attachments: options.attachments ?? [],
          fallbackSubmission: options.fallbackSubmission,
          answerCapture: "json-code",
          submit,
          reloadPromptComposer: vi.fn(async () => {}),
          prepareFallbackSubmission: clear,
          logger: () => {},
        });
      }
      return result;
    });
    const server = await createRemoteServer(
      { host: "127.0.0.1", port: 0, token: "strict", logger: () => {} },
      { runBrowser },
    );
    try {
      // A legacy or direct caller still sends fallback. Invalid file content and
      // bundle metadata make any attempted staging or preparation observable.
      const response = await fetch(`http://127.0.0.1:${server.port}/runs`, {
        method: "POST",
        headers: { Authorization: "Bearer strict", "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          attachments: [],
          browserConfig: { answerCapture: "json-code" },
          options: {},
          fallbackSubmission: {
            prompt: "upload instead",
            attachments: [{ fileName: "private.txt", contentBase64: {} }],
            bundle: { format: "unsupported", scope: "unsupported" },
          },
        }),
      });
      const events = (await response.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(runBrowser).toHaveBeenCalledOnce();
      if (oversized) {
        expect(events.at(-1)).toMatchObject({ type: "error", message: "inline too large" });
        expect(submit).toHaveBeenCalledExactlyOnceWith(prompt, []);
        expect(clear).not.toHaveBeenCalled();
      } else {
        expect(events.at(-1)).toMatchObject({
          type: "result",
          result: { answerText: answer, answerRelationship: result.answerRelationship },
        });
        expect(submit).not.toHaveBeenCalled();
      }
    } finally {
      await server.close();
    }
  },
);
