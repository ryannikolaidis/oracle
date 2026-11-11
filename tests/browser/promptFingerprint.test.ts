import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import {
  browserPromptFingerprint,
  readBoundSubmittedPromptEvidence,
  readSubmittedPromptFingerprint,
  readSubmittedPromptEvidence,
  readUserMessageIds,
} from "../../src/browser/promptFingerprint.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { bindSubmittedAnswer, evaluateBoundAnswer } from "../../src/browser/answerBinding.js";
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
    fingerprint: createHash("sha256")
      .update(JSON.stringify(["new", normalized]))
      .digest("hex"),
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
        value:
          ++calls === 1
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
  expect(
    await readSubmittedPromptEvidence(observedRuntime("text", "new"), undefined),
  ).toBeUndefined();
  for (const value of [null, undefined, {}]) {
    const runtime = {
      evaluate: async () => ({ result: { value } }),
    } as unknown as ChromeClient["Runtime"];
    expect(await readSubmittedPromptEvidence(runtime, [])).toBeUndefined();
  }
  const runtime = {
    evaluate: async () => {
      throw new Error("WebSocket is not open");
    },
  } as unknown as ChromeClient["Runtime"];
  expect(await readSubmittedPromptEvidence(runtime, [])).toBeUndefined();
});

test("session receipt polling waits for conversation and observation identity in the same read", async () => {
  const reads = [
    { text: "fresh", messageId: "new" },
    { text: "fresh", messageId: "new", conversationId: "conversation" },
    { text: "fresh", messageId: "new", conversationId: " ", observationId: "observation" },
    {
      text: "fresh",
      messageId: "new",
      conversationId: "conversation",
      observationId: "observation",
    },
  ];
  let calls = 0;
  const runtime = {
    evaluate: async () => ({ result: { value: reads[calls++] } }),
  } as unknown as ChromeClient["Runtime"];
  expect(await readBoundSubmittedPromptEvidence(runtime, [], "fresh", 1000)).toMatchObject({
    messageId: "new",
    conversationId: "conversation",
    observationId: "observation",
    sha256: createHash("sha256").update("fresh").digest("hex"),
  });
  expect(calls).toBe(4);
});

test("session receipt polling expires without accepting incomplete continuity while fingerprints remain compatible", async () => {
  const runtime = observedRuntime("fresh", "new");
  expect(await readBoundSubmittedPromptEvidence(runtime, [], "fresh", 0)).toBeUndefined();
  expect(await readSubmittedPromptFingerprint(runtime, [], 0)).toBe(
    browserPromptFingerprint("fresh", "new"),
  );
});

function strictDomRuntime(initial: FakeElement[]) {
  let document = new FakeDocument(initial);
  let calls = 0;
  let observations = 0;
  const registry: { __oraclePromptObservations?: Map<string, { invalidated: boolean }> } = {};
  let callback: (records: unknown[]) => void = () => {};
  class Observer {
    constructor(fn: typeof callback) {
      callback = fn;
      observations++;
    }
    observe() {}
    disconnect() {}
  }
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => {
      calls++;
      return {
        result: {
          value: await new Function(
            "document",
            "location",
            "globalThis",
            "MutationObserver",
            "crypto",
            `return ${expression}`,
          )(document, { href: "https://chatgpt.com/c/conversation" }, registry, Observer, {
            randomUUID: () => "observation",
          }),
        },
      };
    },
  } as unknown as ChromeClient["Runtime"];
  return {
    runtime,
    get calls() {
      return calls;
    },
    get observations() {
      return observations;
    },
    get invalidated() {
      return registry.__oraclePromptObservations?.get("observation")?.invalidated;
    },
    mutate: (records: unknown[]) => callback(records),
    replace: (elements: FakeElement[]) => {
      document = new FakeDocument(elements);
    },
  };
}

function committedUser(text: string, id?: string) {
  return new FakeElement(
    "div",
    {
      "data-message-author-role": "user",
      ...(id ? { "data-message-id": id } : {}),
    },
    [new FakeElement("div", { "data-user-message-bubble": "true" }, [], text)],
  );
}

// Read the recorded user subtree, including both nested role wrappers and the
// bubble's controls. Keep its enclosing turn identity from the same fixture.
function recordedUserTurn() {
  const html = readFileSync(
    new URL("../fixtures/chatgpt-dom-2026-09/completed.html", import.meta.url),
    "utf8",
  );
  const start = html.indexOf('<div class="group/user-message flex flex-col items-end gap-2"');
  expect(start).toBeGreaterThan(0);
  const turnId = Array.from(html.slice(0, start).matchAll(/data-turn-key="([^"]+)"/g)).at(-1)![1]!;
  const tokens = html.slice(start).match(/<[^>]+>|[^<]+/g)!;
  let cursor = 0;
  const parse = (): FakeElement => {
    const opening = tokens[cursor++]!;
    const name = opening.match(/^<([a-z0-9]+)/i)![1]!;
    const attributes = Object.fromEntries(
      Array.from(opening.matchAll(/([\w-]+)="([^"]*)"/g), (match) => [match[1]!, match[2]!]),
    );
    const children: FakeElement[] = [];
    let text = "";
    while (cursor < tokens.length && !tokens[cursor]!.startsWith("</")) {
      if (tokens[cursor]!.startsWith("<")) children.push(parse());
      else text += tokens[cursor++];
    }
    cursor++;
    return new FakeElement(name, attributes, children, text);
  };
  const user = parse();
  const inner = user.querySelector('[data-content-search-unit-key$=":user"]')!;
  const bubble = user.querySelector('[data-user-message-bubble="true"]')!;
  expect(user.getAttribute("data-chatgpt-search-unit-key")).toBe("fallback-turn-0:0:user");
  expect(inner.getAttribute("data-content-search-unit-key")).toBe("fallback-turn-0:0:user");
  expect(bubble.textContent).toBe("Reply with exactly: OK");
  return {
    turn: new FakeElement("div", { "data-turn-key": turnId }, [user]),
    user,
    inner,
    bubble,
    messageId: user.getAttribute("data-chatgpt-search-message-ids")!,
  };
}

test("strict association accepts one recorded user message with nested role wrappers", async () => {
  const recorded = recordedUserTurn();
  const page = strictDomRuntime([recorded.turn]);
  const prompt = recorded.bubble.textContent;
  expect(await readBoundSubmittedPromptEvidence(page.runtime, [], prompt)).toEqual({
    fingerprint: browserPromptFingerprint(prompt, recorded.messageId),
    sha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
    length: Buffer.byteLength(prompt, "utf8"),
    messageId: recorded.messageId,
    conversationId: "conversation",
    observationId: "observation",
  });
  expect(page.calls).toBe(1);
  expect(page.observations).toBe(1);
});

test.each([
  ["data-message-author-role", "user"],
  ["data-content-search-unit-key", "hydrated:user"],
  ["data-chatgpt-search-unit-key", "hydrated:user"],
])("continuity accepts recorded nested wrapper hydration through %s", async (attribute, value) => {
  const recorded = recordedUserTurn();
  const page = strictDomRuntime([recorded.turn]);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], recorded.bubble.textContent),
  ).toBeDefined();
  for (const next of [value, value]) {
    const oldValue = recorded.inner.getAttribute(attribute);
    recorded.inner.setAttribute(attribute, next);
    page.mutate([
      {
        type: "attributes",
        target: recorded.inner,
        attributeName: attribute,
        oldValue,
        addedNodes: [],
        removedNodes: [],
      },
    ]);
    expect(page.invalidated).toBe(false);
  }
});

test.each([
  "data-message-author-role",
  "data-content-search-unit-key",
  "data-chatgpt-search-unit-key",
])("continuity accepts insertion of same-turn wrappers through %s", async (attribute) => {
  const recorded = recordedUserTurn();
  const page = strictDomRuntime([recorded.turn]);
  const prompt = recorded.bubble.textContent;
  const evidence = await readBoundSubmittedPromptEvidence(page.runtime, [], prompt);
  expect(evidence).toBeDefined();
  bindSubmittedAnswer(page.runtime, evidence!);
  const wrapper = new FakeElement("div", {
    [attribute]: attribute === "data-message-author-role" ? "user" : "hydrated:user",
  });
  // Include multiple matching descendants beneath a non-role inserted root.
  const inserted = new FakeElement("div", {}, [
    wrapper,
    new FakeElement("div", { "data-message-author-role": "user" }),
  ]);
  recorded.user.append(inserted);
  page.mutate([
    { type: "childList", target: recorded.user, addedNodes: [inserted], removedNodes: [] },
  ]);
  expect(page.invalidated).toBe(false);
  expect(recorded.bubble.textContent).toBe(prompt);
  await expect(evaluateBoundAnswer(page.runtime, { expression: "null" })).resolves.toMatchObject({
    result: { value: null },
  });
  expect(page.observations).toBe(1);
});

test.each([
  "sibling",
  "relocated sibling",
  "nested distinct turn",
  "mixed nested subtree",
  "bubble mutation",
])("continuity rejects added user wrappers outside canonical ownership: %s", async (scenario) => {
  const recorded = recordedUserTurn();
  const page = strictDomRuntime([recorded.turn]);
  const evidence = await readBoundSubmittedPromptEvidence(
    page.runtime,
    [],
    recorded.bubble.textContent,
  );
  expect(evidence).toBeDefined();
  bindSubmittedAnswer(page.runtime, evidence!);
  const other = committedUser(recorded.bubble.textContent, recorded.messageId);
  let inserted = other;
  const target =
    scenario === "sibling" || scenario === "relocated sibling"
      ? recorded.turn
      : scenario === "bubble mutation"
        ? recorded.bubble
        : recorded.user;
  if (scenario === "nested distinct turn" || scenario === "mixed nested subtree") {
    inserted = new FakeElement("div", { "data-turn-key": "other-turn" }, [other]);
    if (scenario === "mixed nested subtree")
      inserted = new FakeElement("div", { "data-message-author-role": "user" }, [inserted]);
  }
  target.append(inserted);
  // Observer delivery sees the final tree. A competing insertion must still
  // fail if the new user node moved into the canonical subtree before delivery.
  if (scenario === "relocated sibling") {
    inserted.remove();
    recorded.user.append(inserted);
  }
  page.mutate([{ type: "childList", target, addedNodes: [inserted], removedNodes: [] }]);
  expect(page.invalidated).toBe(true);
  await expect(evaluateBoundAnswer(page.runtime, { expression: "null" })).rejects.toThrow(
    /observation lost or invalidated/,
  );
});

test.each([
  "canonical identity",
  "enclosing turn identity",
  "nested turn identity",
  "nested distinct turn",
  "unrelated role transition",
  "equal-identity sibling transition",
  "unidentified sibling transition",
  "new user turn",
])("continuity rejects competing or identity mutations: %s", async (scenario) => {
  const recorded = recordedUserTurn();
  const other = committedUser(
    "other",
    scenario === "unidentified sibling transition" ? undefined : recorded.messageId,
  );
  // A distinct nested turn must remain distinct even with equal message IDs.
  if (scenario === "nested distinct turn") {
    recorded.user.append(new FakeElement("div", { "data-turn-key": "other-turn" }, [other]));
  } else if (
    scenario === "equal-identity sibling transition" ||
    scenario === "unidentified sibling transition"
  ) {
    recorded.turn.append(other);
  }
  // Only the observed user is present at association. The other node becomes
  // user-role later, including transitions reverted before observer delivery.
  other.setAttribute("data-message-author-role", "assistant");
  const page = strictDomRuntime([recorded.turn, ...(other.parentElement ? [] : [other])]);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], recorded.bubble.textContent),
  ).toBeDefined();
  let target = other;
  let attribute = "data-message-author-role";
  if (scenario === "canonical identity") {
    target = recorded.user;
    attribute = "data-chatgpt-search-message-ids";
  } else if (scenario === "enclosing turn identity") {
    target = recorded.turn;
    attribute = "data-turn-key";
  } else if (scenario === "nested turn identity") {
    target = recorded.inner;
    attribute = "data-turn-key";
  }
  const oldValue = target.getAttribute(attribute);
  const transient = attribute === "data-message-author-role" ? "user" : "replacement";
  target.setAttribute(attribute, transient);
  target.setAttribute(attribute, oldValue ?? "");
  page.mutate(
    scenario === "new user turn"
      ? [
          {
            type: "childList",
            target: recorded.turn,
            addedNodes: [committedUser("other", "new-user")],
            removedNodes: [],
          },
        ]
      : [oldValue, transient].map((value) => ({
          type: "attributes",
          target,
          attributeName: attribute,
          oldValue: value,
          addedNodes: [],
          removedNodes: [],
        })),
  );
  expect(page.invalidated).toBe(true);
});

test.each([
  "different identity",
  "equal identity",
  "same enclosing turn",
  "nested distinct turn",
  "missing identity",
])(
  "strict association rejects a recorded message plus a distinct fresh message: %s",
  async (scenario) => {
    const recorded = recordedUserTurn();
    const other = recordedUserTurn();
    let elements = [recorded.turn, other.turn];
    if (scenario === "different identity") {
      other.user.setAttribute("data-chatgpt-search-message-ids", "different-user");
      other.turn.setAttribute("data-turn-key", "different-turn");
    } else if (scenario === "same enclosing turn") {
      recorded.turn.append(other.user);
      elements = [recorded.turn];
    } else if (scenario === "nested distinct turn") {
      recorded.user.append(other.turn);
      elements = [recorded.turn];
    } else if (scenario === "missing identity") {
      elements = [recorded.turn, committedUser(recorded.bubble.textContent)];
    }
    const page = strictDomRuntime(elements);
    expect(
      await readBoundSubmittedPromptEvidence(page.runtime, [], recorded.bubble.textContent, 1000),
    ).toBeUndefined();
    expect(page.calls).toBe(1);
    expect(page.observations).toBe(0);
  },
);

test("strict association refuses a recorded nested message without any usable identity", async () => {
  const recorded = recordedUserTurn();
  recorded.turn.setAttribute("data-turn-key", "");
  for (const node of [recorded.user, recorded.inner]) {
    node.setAttribute("data-message-author-role", "user");
    node.setAttribute("data-chatgpt-search-message-ids", "");
    node.setAttribute("data-chatgpt-search-unit-key", "");
    node.setAttribute("data-content-search-unit-key", "");
  }
  const page = strictDomRuntime([recorded.turn]);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], recorded.bubble.textContent, 1000),
  ).toBeUndefined();
  expect(page.calls).toBe(1);
  expect(page.observations).toBe(0);
});

test.each(["Reply with exactly: ok", "Reply with exactly: OK ", "Reply with exactly: OK\n"])(
  "strict association refuses an altered prompt against the recorded nested message: %j",
  async (submitted) => {
    const page = strictDomRuntime([recordedUserTurn().turn]);
    expect(
      await readBoundSubmittedPromptEvidence(page.runtime, [], submitted, 1000),
    ).toBeUndefined();
    expect(page.calls).toBe(1);
    expect(page.observations).toBe(0);
  },
);

test("strict association matches the full submission with line-ending normalization only", async () => {
  const submitted = "  Hé😀\r\n\tCase\rline  \n";
  const observed = "  Hé😀\n\tCase\nline  \n";
  const page = strictDomRuntime([committedUser(observed, "old"), committedUser(observed, "new")]);
  const evidence = await readBoundSubmittedPromptEvidence(page.runtime, ["old"], submitted);
  expect(evidence).toEqual({
    fingerprint: browserPromptFingerprint(observed, "new"),
    sha256: createHash("sha256").update(observed, "utf8").digest("hex"),
    length: Buffer.byteLength(observed, "utf8"),
    messageId: "new",
    conversationId: "conversation",
    observationId: "observation",
  });
  expect(page.observations).toBe(1);
});

test.each([
  "  Hé😀\n\tCase\nline  \n".trim(),
  "  hé😀\n\tcase\nline  \n",
  "  Hé😀\n Case\nline  \n",
  "  Hé😀\n\tCase\nline  \n".normalize("NFD"),
  "  Hé😀\n\tCase\nline  ",
  "  Hé😀\n\tCase\nline  \nextra",
])("strict association refuses changed submission bytes: %j", async (observed) => {
  const page = strictDomRuntime([committedUser(observed, "new")]);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], "  Hé😀\r\n\tCase\rline  \n", 1000),
  ).toBeUndefined();
  expect(page.calls).toBe(1);
  expect(page.observations).toBe(0);
});

test.each([
  [committedUser("Oracle prompt A", "a"), committedUser("Concurrent prompt B", "b")],
  [committedUser("Concurrent prompt B", "b"), committedUser("Oracle prompt A", "a")],
  [committedUser("Oracle prompt A", "a"), committedUser("Oracle prompt A", "b")],
  [committedUser("Oracle prompt A", "a"), committedUser("Oracle prompt A", "a")],
  [committedUser("Oracle prompt A", "a"), committedUser("Concurrent prompt B")],
])(
  "strict association rejects competing fresh user nodes without polling away ambiguity: %#",
  async (...users) => {
    const page = strictDomRuntime(users);
    const report = vi.fn();
    const evaluate = page.runtime.evaluate.bind(page.runtime);
    page.runtime.evaluate = (async (params: { expression: string }) => {
      const result = await evaluate(params);
      // Even if the competing turn disappears before the next poll, this read is fatal.
      page.replace([committedUser("Oracle prompt A", "a")]);
      return result;
    }) as typeof page.runtime.evaluate;
    expect(
      await readBoundSubmittedPromptEvidence(page.runtime, [], "Oracle prompt A", 1000, report),
    ).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ outcome: "rejected", attempts: 1 });
    expect(page.calls).toBe(1);
    expect(page.observations).toBe(0);
  },
);

test("strict association rejects a single unrelated fresh turn and a missing baseline", async () => {
  const page = strictDomRuntime([committedUser("Concurrent prompt B", "b")]);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], "Oracle prompt A", 1000),
  ).toBeUndefined();
  expect(page.calls).toBe(1);
  expect(page.observations).toBe(0);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, undefined, "Oracle prompt A"),
  ).toBeUndefined();
  expect(page.calls).toBe(1);
});

test("strict association still waits when no fresh user turn has mounted", async () => {
  const report = vi.fn();
  const page = strictDomRuntime([committedUser("old prompt", "old")]);
  const evaluate = page.runtime.evaluate.bind(page.runtime);
  page.runtime.evaluate = (async (params: { expression: string }) => {
    const result = await evaluate(params);
    page.replace([committedUser("submitted prompt", "new")]);
    return result;
  }) as typeof page.runtime.evaluate;
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, ["old"], "submitted prompt", 1000, report),
  ).toMatchObject({ messageId: "new", observationId: "observation" });
  expect(report).not.toHaveBeenCalled();
  expect(page.calls).toBe(2);
  expect(page.observations).toBe(1);
});

test("association failure records unavailable baseline without evaluating the page", async () => {
  const page = strictDomRuntime([]);
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, undefined, "private prompt", 1000, report),
  ).toBeUndefined();
  expect(page.calls).toBe(0);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    outcome: "rejected",
    reason: "baseline-unavailable",
    attempts: 0,
    baselineAvailable: false,
    expectedLength: 14,
    expectedSha256: createHash("sha256").update("private prompt").digest("hex"),
  });
});

test.each([
  { users: [], reason: "no-fresh-user", outcome: "timeout", raw: 0, fresh: 0, missing: 0 },
  {
    users: [committedUser("private prompt", "a"), committedUser("private prompt", "b")],
    reason: "multiple-fresh-users",
    outcome: "rejected",
    raw: 2,
    fresh: 2,
    missing: 0,
  },
  {
    users: [committedUser("private prompt")],
    reason: "missing-identity",
    outcome: "rejected",
    raw: 1,
    fresh: 0,
    missing: 1,
  },
])(
  "association diagnostics distinguish $reason without exposing candidate content",
  async ({ users, reason, outcome, raw, fresh, missing }) => {
    const page = strictDomRuntime(users);
    const report = vi.fn();
    expect(
      await readBoundSubmittedPromptEvidence(page.runtime, [], "private prompt", 0, report),
    ).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      version: 1,
      reason,
      outcome,
      attempts: 1,
      baselineAvailable: true,
      rawCandidates: raw,
      canonicalCandidates: raw,
      freshCandidates: fresh,
      missingIdentities: missing,
    });
    expect(report.mock.calls[0][0].observedSha256).toBeUndefined();
    expect(JSON.stringify(report.mock.calls)).not.toContain("private prompt");
  },
);

test.each([
  "  Hé😀\n\n\tCase\nline  ",
  "  Hé😀\n\tCase\nline  \n",
  "  Hé😀\n\n Case\nline  \n",
  "  Hé😀\n\n\tCase\nline  \n".normalize("NFD"),
])(
  "mismatch diagnostics hash exact observed bytes without accepting them: %#",
  async (observed) => {
    const submitted = "  Hé😀\r\n\r\n\tCase\rline  \n";
    const page = strictDomRuntime([committedUser(observed, "new")]);
    const report = vi.fn();
    expect(
      await readBoundSubmittedPromptEvidence(page.runtime, [], submitted, 1000, report),
    ).toBeUndefined();
    expect(page.calls).toBe(1);
    expect(page.observations).toBe(0);
    expect(report).toHaveBeenCalledTimes(1);
    const failure = report.mock.calls[0][0];
    expect(failure).toMatchObject({
      version: 1,
      outcome: "rejected",
      reason: "text-mismatch",
      attempts: 1,
      freshCandidates: 1,
      bubbleCount: 1,
      brCount: 0,
      blockCount: 0,
      conversationAvailable: true,
      observationAvailable: false,
      expectedLength: Buffer.byteLength(submitted.replace(/\r\n?/g, "\n"), "utf8"),
      observedLength: Buffer.byteLength(observed, "utf8"),
      observedSha256: createHash("sha256").update(observed, "utf8").digest("hex"),
    });
    expect(JSON.stringify(failure)).not.toContain("Case");
    expect(failure).not.toHaveProperty("text");
    expect(failure).not.toHaveProperty("messageId");
  },
);

test("successful exact multiline association emits no failure telemetry", async () => {
  const observed = "  Hé😀\n\n\tCase\nline  \n";
  const page = strictDomRuntime([committedUser(observed, "new")]);
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(
      page.runtime,
      [],
      observed.replace(/\n/g, "\r\n"),
      0,
      report,
    ),
  ).toMatchObject({
    sha256: createHash("sha256").update(observed, "utf8").digest("hex"),
    length: Buffer.byteLength(observed, "utf8"),
  });
  expect(report).not.toHaveBeenCalled();
});

test("BR and block diagnostics describe rejected shape without inventing newline semantics", async () => {
  const user = new FakeElement(
    "div",
    { "data-message-author-role": "user", "data-message-id": "new" },
    [
      new FakeElement("div", { "data-user-message-bubble": "true" }, [
        new FakeElement("p", {}, [new FakeElement("br")], "first"),
        new FakeElement("p", {}, [], "second"),
      ]),
    ],
  );
  const page = strictDomRuntime([user]);
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], "first\nsecond", 0, report),
  ).toBeUndefined();
  expect(report.mock.calls[0][0]).toMatchObject({
    reason: "text-mismatch",
    bubbleCount: 1,
    brCount: 1,
    blockCount: 2,
  });
  expect(page.observations).toBe(0);
});

test("timeout reports missing continuity separately from text mismatch", async () => {
  const runtime = {
    evaluate: async () => ({
      result: {
        value: { text: "private prompt", messageId: "new", conversationId: "conversation" },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(runtime, [], "private prompt", 0, report),
  ).toBeUndefined();
  expect(report.mock.calls[0][0]).toMatchObject({
    outcome: "timeout",
    reason: "continuity-unavailable",
    conversationAvailable: true,
    observationAvailable: false,
  });
});

test.each(["protocol-exception", "transport-error", "context-unavailable"])(
  "association diagnostics exclude arbitrary exception data: %s",
  async (scenario) => {
    const report = vi.fn();
    const runtime = {
      evaluate: async () => {
        if (scenario === "transport-error") throw new Error("private credential text");
        if (scenario === "context-unavailable")
          throw new Error("Execution context was destroyed: private credential text");
        return {
          result: { value: "private credential text" },
          exceptionDetails: { text: "private credential text" },
        };
      },
    } as unknown as ChromeClient["Runtime"];
    expect(
      await readBoundSubmittedPromptEvidence(runtime, [], "private prompt", 0, report),
    ).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject(
      scenario === "context-unavailable"
        ? { outcome: "timeout", reason: "context-unavailable", attempts: 1 }
        : { outcome: "evaluation-error", reason: "evaluation-error", attempts: 1 },
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("private");
  },
);

test("association diagnostics copy only bounded allowlisted fields", async () => {
  const report = vi.fn();
  const runtime = {
    evaluate: async () => ({
      result: {
        value: {
          associationRejected: true,
          diagnostic: {
            reason: "multiple-fresh-users",
            rawCandidates: 1e12,
            freshCandidates: Infinity,
            missingIdentities: -1,
            canonicalCandidates: 2.75,
            brCount: "private",
            rawDOM: "private",
            conversationAvailable: "private",
            exception: "private",
          },
        },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(
    await readBoundSubmittedPromptEvidence(runtime, [], "private prompt", 1000, report),
  ).toBeUndefined();
  expect(report.mock.calls[0][0]).toEqual({
    version: 1,
    outcome: "rejected",
    reason: "multiple-fresh-users",
    attempts: 1,
    baselineAvailable: true,
    rawCandidates: 1_000_000,
    canonicalCandidates: 2,
    expectedLength: 14,
    expectedSha256: createHash("sha256").update("private prompt").digest("hex"),
  });
});
