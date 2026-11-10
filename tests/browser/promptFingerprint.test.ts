import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  browserPromptFingerprint,
  readSubmittedPromptFingerprint,
  readSubmittedPromptEvidence,
  readUserMessageIds,
} from "../../src/browser/promptFingerprint.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

test("captures a new message when earlier turns unmount during submission", async () => {
  const user = (text: string, id: string) => ({
    textContent: text,
    getAttribute: () => id,
    querySelector: () => null,
  });
  const oldUsers = [user("First", "old-1"), user("Continue", "old-2")];
  let users = oldUsers;
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", `return ${expression}`)({
          querySelectorAll: (selector: string) =>
            selector.includes('[data-message-author-role="user"]')
              ? users
              : users.map((message) => ({ matches: () => false, querySelector: () => message })),
        }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const previous = await readUserMessageIds(runtime);
  expect(previous).toEqual(["old-1", "old-2"]);
  expect(await readSubmittedPromptFingerprint(runtime, previous)).toBeUndefined();
  users = [oldUsers[1], user("Continue", "current-message")];
  expect(await readSubmittedPromptFingerprint(runtime, previous)).toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
  expect(await readSubmittedPromptFingerprint(runtime, undefined)).toBeUndefined();
});

test("uses current ChatGPT search-unit keys as committed user identities", async () => {
  let document = new FakeDocument([]);
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: { value: new Function("document", `return ${expression}`)(document) },
    }),
  } as unknown as ChromeClient["Runtime"];
  const previous = await readUserMessageIds(runtime);
  expect(previous).toEqual([]);
  document = new FakeDocument([
    new FakeElement("div", { "data-content-search-unit-key": "fallback-turn-0:0:user" }, [
      new FakeElement("div", { class: "whitespace-pre-wrap" }, [], "New prompt"),
    ]),
  ]);
  expect(await readSubmittedPromptFingerprint(runtime, previous)).toBe(
    browserPromptFingerprint("New prompt", "fallback-turn-0:0:user"),
  );
});

test("waits for pre-existing user message IDs to hydrate", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({ result: { value: ++calls === 1 ? [null] : ["old-message"] } }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readUserMessageIds(runtime, 1000)).toEqual(["old-message"]);
  expect(calls).toBe(2);
});

test("does not confuse an existing identical prompt with the next submission", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: {
        value: { text: "Continue", messageId: ++calls === 1 ? "old-message" : "current-message" },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptFingerprint(runtime, ["old-message"], 1000)).toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
  expect(calls).toBe(2);
});

test("fingerprints preserve case and meaningful indentation", () => {
  expect(browserPromptFingerprint("Foo", "current-message")).not.toBe(
    browserPromptFingerprint("foo", "current-message"),
  );
  expect(browserPromptFingerprint("if active:\n  run()\nfinish()", "current-message")).not.toBe(
    browserPromptFingerprint("if active:\n  run()\n  finish()", "current-message"),
  );
  expect(browserPromptFingerprint("one\r\ntwo", "current-message")).toBe(
    browserPromptFingerprint("one\ntwo", "current-message"),
  );
  expect(browserPromptFingerprint("Continue", "old-message")).not.toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
});

test("preserves committed identity when earlier conversation turns are unmounted", async () => {
  const user = {
    textContent: "Continue",
    getAttribute: () => "current-message",
    querySelector: () => null,
  };
  const current = { matches: () => false, querySelector: () => user };
  let turns = [
    ...Array.from({ length: 20 }, () => ({ matches: () => false, querySelector: () => null })),
    current,
  ];
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", `return ${expression}`)({ querySelectorAll: () => turns }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const before = await readSubmittedPromptFingerprint(runtime, []);
  turns = [current];
  expect(await readSubmittedPromptFingerprint(runtime, [])).toBe(before);
  expect(before).toBe(browserPromptFingerprint("Continue", "current-message"));
});

test("waits for stable message identity instead of fingerprinting text alone", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: { value: { text: "Continue", messageId: ++calls === 1 ? null : "current-message" } },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptFingerprint(runtime, [], 1000)).toBe(
    browserPromptFingerprint("Continue", "current-message"),
  );
  expect(calls).toBe(2);
});

test("captures the rendered committed user turn rather than Markdown source", async () => {
  const text = "Heading\nspec\nif active:\n  run()";
  const user = {
    textContent: text,
    getAttribute: () => "current-message",
    querySelector: () => null,
  };
  const turn = { matches: () => false, querySelector: () => user };
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function("document", `return ${expression}`)({ querySelectorAll: () => [turn] }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];

  await expect(readSubmittedPromptFingerprint(runtime, [])).resolves.toBe(
    browserPromptFingerprint(text, "current-message"),
  );
  await expect(
    readSubmittedPromptFingerprint(runtime, ["current-message"]),
  ).resolves.toBeUndefined();
  expect(browserPromptFingerprint(text, "current-message")).not.toBe(
    browserPromptFingerprint(
      "# Heading\n[spec](https://example.com)\n```python\nif active:\n  run()\n```",
      "current-message",
    ),
  );
});

test("waits for asynchronous user-turn mounting within the configured input timeout", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: {
        value: ++calls === 1 ? null : { text: "Mounted user prompt", messageId: "current-message" },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  await expect(readSubmittedPromptFingerprint(runtime, [], 1000)).resolves.toBe(
    browserPromptFingerprint("Mounted user prompt", "current-message"),
  );
  expect(calls).toBe(2);
});

test("retries a replaced execution context without treating a closed connection as transient", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => {
      if (++calls === 1) throw new Error("Protocol error: Execution context was destroyed");
      return { result: { value: { text: "Committed prompt", messageId: "current-message" } } };
    },
  } as unknown as ChromeClient["Runtime"];
  await expect(readSubmittedPromptFingerprint(runtime, [], 1000)).resolves.toBe(
    browserPromptFingerprint("Committed prompt", "current-message"),
  );
  expect(calls).toBe(2);
  calls = 0;
  runtime.evaluate = async () => {
    calls++;
    throw new Error("WebSocket is not open");
  };
  await expect(readSubmittedPromptFingerprint(runtime, [], 1000)).resolves.toBeUndefined();
  expect(calls).toBe(1);
});

function observedRuntime(text: unknown, messageId: unknown): ChromeClient["Runtime"] {
  return {
    evaluate: async () => ({ result: { value: { text, messageId } } }),
  } as unknown as ChromeClient["Runtime"];
}

test("digests the full observed bubble and distinguishes a matching truncated prefix", async () => {
  const fullText = "Same prefix ".repeat(100) + "critical final instruction";
  const bubble = new FakeElement("div", { "data-user-message-bubble": "true" }, [], fullText);
  const document = new FakeDocument([
    new FakeElement("div", { "data-message-author-role": "user", "data-message-id": "new" }, [
      bubble,
      new FakeElement("span", {}, [], "UI status outside the bubble"),
    ]),
  ]);
  let calls = 0;
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => {
      calls++;
      return { result: { value: new Function("document", `return ${expression}`)(document) } };
    },
  } as unknown as ChromeClient["Runtime"];
  const full = await readSubmittedPromptEvidence(runtime, ["old"]);
  expect(calls).toBe(1);
  expect(full).toEqual({
    fingerprint: browserPromptFingerprint(fullText, "new"),
    sha256: createHash("sha256").update(fullText).digest("hex"),
    length: Buffer.byteLength(fullText, "utf8"),
    messageId: "new",
  });
  const truncated = await readSubmittedPromptEvidence(
    observedRuntime(fullText.slice(0, 120), "new"),
    ["old"],
  );
  expect(truncated?.sha256).not.toBe(full?.sha256);
  expect(truncated?.length).toBe(120);
});

test("normalizes only CRLF and lone CR and measures UTF-8 bytes", async () => {
  const raw = "  Hé😀\r\n\tCase\rline  \n";
  const normalized = "  Hé😀\n\tCase\nline  \n";
  const evidence = await readSubmittedPromptEvidence(observedRuntime(raw, "new"), []);
  expect(evidence).toEqual({
    fingerprint: createHash("sha256").update(JSON.stringify(["new", normalized])).digest("hex"),
    sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
    length: Buffer.byteLength(normalized, "utf8"),
    messageId: "new",
  });
  for (const changed of [
    normalized.trim(),
    normalized.toLowerCase(),
    normalized.replace("\t", " "),
    normalized.normalize("NFD"),
  ]) {
    const other = await readSubmittedPromptEvidence(observedRuntime(changed, "new"), []);
    expect(other?.sha256).not.toBe(evidence?.sha256);
  }
  const anotherId = await readSubmittedPromptEvidence(observedRuntime(normalized, "another"), []);
  expect(anotherId?.sha256).toBe(evidence?.sha256);
  expect(anotherId?.fingerprint).not.toBe(evidence?.fingerprint);
});

test("waits for a fresh turn and takes identity and both digests from that same read", async () => {
  let calls = 0;
  const runtime = {
    evaluate: async () => ({
      result: {
        value: ++calls === 1
          ? { text: "stale text", messageId: "old" }
          : { text: "fresh text", messageId: "new" },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptEvidence(runtime, ["old"], 1000)).toEqual({
    fingerprint: browserPromptFingerprint("fresh text", "new"),
    sha256: createHash("sha256").update("fresh text").digest("hex"),
    length: 10,
    messageId: "new",
  });
  expect(calls).toBe(2);
});

test.each([
  [null, "new"],
  [undefined, "new"],
  [42, "new"],
  ["", "new"],
  [" \r\n\t", "new"],
  ["text", null],
  ["text", undefined],
  ["text", ""],
  ["text", "   "],
  ["text", "old"],
])("refuses incomplete or stale evidence (%j, %j)", async (text, id) => {
  expect(await readSubmittedPromptEvidence(observedRuntime(text, id), ["old"])).toBeUndefined();
});

test("refuses missing baseline, absent DOM turn and failed DOM reads", async () => {
  expect(await readSubmittedPromptEvidence(observedRuntime("text", "new"), undefined)).toBeUndefined();
  for (const value of [null, undefined, {}]) {
    const runtime = {
      evaluate: async () => ({ result: { value } }),
    } as unknown as ChromeClient["Runtime"];
    expect(await readSubmittedPromptEvidence(runtime, [])).toBeUndefined();
  }
  const runtime = {
    evaluate: async () => { throw new Error("WebSocket is not open"); },
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptEvidence(runtime, [])).toBeUndefined();
});
