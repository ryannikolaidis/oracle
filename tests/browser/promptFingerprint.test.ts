import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import {
  browserPromptFingerprint,
  readBoundSubmittedPromptEvidence,
  readSubmittedPromptFingerprint,
  readSubmittedPromptEvidence,
  readUserMessageIds,
  type PromptAssociationFailure,
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

function strictDomRuntime(initial: FakeElement[], sampling = false) {
  let document = new FakeDocument(initial);
  let calls = 0;
  let observations = 0;
  const navigationListeners = new Set<() => void>();
  const navigation = {
    addEventListener: (_event: string, listener: () => void) => navigationListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) =>
      navigationListeners.delete(listener),
  };
  const registry: {
    __oraclePromptObservations?: Map<string, { invalidated: boolean }>;
    navigation?: typeof navigation;
  } = sampling ? { navigation } : {};
  let disconnected = 0;
  const queuedRecords: unknown[] = [];
  let callback: (records: unknown[]) => void = () => {};
  class Observer {
    constructor(fn: typeof callback) {
      callback = fn;
      observations++;
    }
    observe() {}
    takeRecords() {
      return queuedRecords.splice(0);
    }
    disconnect() {
      disconnected++;
    }
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
    get disconnected() {
      return disconnected;
    },
    get navigationListeners() {
      return navigationListeners.size;
    },
    navigate: () => {
      for (const listener of navigationListeners) listener();
    },
    queueMutations: (records: unknown[]) => queuedRecords.push(...records),
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

test.each(["missing", "extra", "duplicate", "empty extra", "nested extra"])(
  "strict association refuses %s user content before starting an observation",
  async (scenario) => {
    const prompt = "Exact requested prompt";
    const user = committedUser(prompt, "new-user");
    if (scenario === "missing") {
      user.children[0]!.remove();
      user.append(new FakeElement("div", {}, [], prompt));
    } else {
      const extra = new FakeElement(
        "div",
        { "data-user-message-bubble": "true" },
        [],
        scenario === "duplicate" ? prompt : scenario === "empty extra" ? "" : "Extra instruction",
      );
      user.append(
        scenario === "nested extra"
          ? new FakeElement("div", { "data-message-author-role": "user" }, [extra])
          : extra,
      );
    }
    const page = strictDomRuntime([user]);
    const failures: PromptAssociationFailure[] = [];
    expect(
      await readBoundSubmittedPromptEvidence(page.runtime, [], prompt, 1000, (failure) =>
        failures.push(failure),
      ),
    ).toBeUndefined();
    expect(page.calls).toBe(1);
    expect(page.observations).toBe(0);
    expect(failures).toEqual([
      expect.objectContaining({
        outcome: "rejected",
        reason: "non-unique-user-content",
        bubbleCount: scenario === "missing" ? 0 : 2,
      }),
    ]);
  },
);

test.each([0, 2])(
  "legacy prompt evidence retains its behavior with %i content bubbles",
  async (count) => {
    const user = new FakeElement(
      "div",
      { "data-message-author-role": "user", "data-message-id": "legacy-user" },
      count === 0
        ? []
        : [
            new FakeElement("div", { "data-user-message-bubble": "true" }, [], "Legacy prompt"),
            new FakeElement("div", { "data-user-message-bubble": "true" }, [], "Extra instruction"),
          ],
      count === 0 ? "Legacy prompt" : "",
    );
    const page = strictDomRuntime([user]);
    expect(await readSubmittedPromptEvidence(page.runtime, [])).toMatchObject({
      fingerprint: browserPromptFingerprint("Legacy prompt", "legacy-user"),
      messageId: "legacy-user",
      length: Buffer.byteLength("Legacy prompt", "utf8"),
    });
    expect(page.observations).toBe(0);
  },
);

// Read the recorded user subtree, including both nested role wrappers and the
// bubble's controls. Keep its enclosing turn identity from the same fixture.
function recordedUserTurn(
  fixture: "completed" | "streaming" | "expanded" = "completed",
  content = "SYNTHETIC_CONTENT",
) {
  const html = readFileSync(
    new URL(`../fixtures/chatgpt-dom-2026-09/${fixture}.html`, import.meta.url),
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
    return new FakeElement(
      name,
      attributes,
      children,
      text === "SYNTHETIC_CONTENT" ? content : text,
    );
  };
  const user = parse();
  const inner = user.querySelector('[data-content-search-unit-key$=":user"]')!;
  const bubble = user.querySelector('[data-user-message-bubble="true"]')!;
  expect(user.getAttribute("data-chatgpt-search-unit-key")).toBe("fallback-turn-0:0:user");
  expect(inner.getAttribute("data-content-search-unit-key")).toBe("fallback-turn-0:0:user");
  if (fixture === "completed") expect(bubble.textContent).toBe("Reply with exactly: OK");
  return {
    turn: new FakeElement("div", { "data-turn-key": turnId }, [user]),
    user,
    inner,
    bubble,
    messageId: user.getAttribute("data-chatgpt-search-message-ids")!,
  };
}

function collapsedRecordedUser() {
  const recorded = recordedUserTurn("streaming");
  const control = recorded.bubble.querySelector("button")!;
  expect(control.textContent).toBe("Show more");
  expect(control.getAttribute("aria-expanded")).toBe("false");
  expect(control.getAttribute("data-thread-find-skip")).toBe("true");
  const tail = "Hé😀\tfinal instruction  \n";
  const prompt =
    "synthetic line\n".repeat(4455) +
    "x".repeat(62401 - 4455 * 14 - Buffer.byteLength(tail, "utf8")) +
    tail;
  const preview = prompt.slice(0, 10240) + "…";
  const replaceContent = (...nodes: FakeElement[]) => {
    for (const child of [...recorded.bubble.children]) child.remove();
    for (const child of nodes) recorded.bubble.append(child);
  };
  replaceContent(new FakeElement("div", {}, [], preview), control);
  const expand = () => {
    // Keep the expanded control in the bubble, as in the live user message.
    const expanded = recordedUserTurn("expanded", prompt);
    replaceContent(...expanded.bubble.children);
  };
  const click = vi.fn(expand);
  Object.assign(control, { click });
  const page = strictDomRuntime([recorded.turn], true);
  return { ...recorded, control, prompt, preview, expand, click, page, replaceContent };
}

test("expands the recorded user control and binds all bytes beyond the 10240-character preview", async () => {
  const fixture = collapsedRecordedUser();
  fixture.click.mockImplementation(() => {
    // React need not commit the expanded content in the click handler itself.
    queueMicrotask(fixture.expand);
  });
  const evidence = await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], fixture.prompt);
  expect(fixture.click).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(fixture.prompt, "utf8")).toBe(62401);
  expect(fixture.bubble.textContent).toBe(fixture.prompt + "Show less");
  expect(evidence).toMatchObject({
    messageId: fixture.messageId,
    sha256: createHash("sha256").update(fixture.prompt).digest("hex"),
    length: Buffer.byteLength(fixture.prompt, "utf8"),
  });
  bindSubmittedAnswer(fixture.page.runtime, evidence!);
  await expect(
    evaluateBoundAnswer(fixture.page.runtime, { expression: "null" }),
  ).resolves.toMatchObject({ result: { value: null } });
  fixture.replaceContent(new FakeElement("div", {}, [], fixture.preview));
  await expect(evaluateBoundAnswer(fixture.page.runtime, { expression: "null" })).rejects.toThrow();
});

test("already expanded content binds without clicking and legacy capture never expands", async () => {
  const fixture = collapsedRecordedUser();
  const legacy = await readSubmittedPromptEvidence(fixture.page.runtime, []);
  expect(legacy?.sha256).not.toBe(createHash("sha256").update(fixture.prompt).digest("hex"));
  expect(fixture.click).not.toHaveBeenCalled();
  fixture.expand();
  expect(
    await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], fixture.prompt),
  ).toMatchObject({ length: Buffer.byteLength(fixture.prompt, "utf8") });
  expect(fixture.click).not.toHaveBeenCalled();
});

test("expands only the fresh user's control when an older collapsed user is present", async () => {
  const old = collapsedRecordedUser();
  old.user.setAttribute("data-chatgpt-search-message-ids", "old-user");
  old.turn.setAttribute("data-turn-key", "old-turn");
  const fresh = collapsedRecordedUser();
  fresh.page.replace([old.turn, fresh.turn]);
  expect(
    await readBoundSubmittedPromptEvidence(fresh.page.runtime, ["old-user"], fresh.prompt),
  ).toMatchObject({ messageId: fresh.messageId });
  expect(fresh.click).toHaveBeenCalledTimes(1);
  expect(old.click).not.toHaveBeenCalled();
});

test("keeps the expansion guard active across the promise handoff", async () => {
  const fixture = collapsedRecordedUser();
  fixture.click.mockImplementation(() => {
    fixture.expand();
    queueMicrotask(() => fixture.page.navigate());
  });
  expect(
    await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], fixture.prompt),
  ).toBeUndefined();
  expect(fixture.page.navigationListeners).toBe(0);
});

test.each([
  "misleading label",
  "misleading aria label",
  "wrong role",
  "extra button",
  "extra role control",
  "extra expanded control",
  "wrong state",
  "missing state",
  "wrong type",
  "disabled",
  "aria disabled",
  "wrong owner",
])("expanded content rejects %s even when the raw text is requested", async (scenario) => {
  const fixture = collapsedRecordedUser();
  fixture.expand();
  const control = fixture.bubble.querySelector("button")!;
  if (scenario === "misleading label")
    control.append(new FakeElement("span", {}, [], " unrelated"));
  if (scenario === "misleading aria label") control.setAttribute("aria-label", "Delete message");
  if (scenario === "wrong role") control.setAttribute("role", "link");
  if (scenario === "extra button") fixture.bubble.append(new FakeElement("button", {}, [], ""));
  if (scenario === "extra role control")
    fixture.bubble.append(new FakeElement("span", { role: "button" }, [], ""));
  if (scenario === "extra expanded control")
    fixture.bubble.append(new FakeElement("div", { "aria-expanded": "true" }, [], ""));
  if (scenario === "wrong state") control.setAttribute("aria-expanded", "false");
  if (scenario === "missing state") control.setAttribute("aria-expanded", "");
  if (scenario === "wrong type") control.setAttribute("type", "submit");
  if (scenario === "disabled") control.setAttribute("disabled", "");
  if (scenario === "aria disabled") control.setAttribute("aria-disabled", "true");
  if (scenario === "wrong owner") {
    control.remove();
    fixture.bubble.append(
      new FakeElement("div", { "data-user-message-bubble": "true" }, [control]),
    );
  }
  for (const expected of [fixture.prompt, fixture.bubble.textContent]) {
    expect(
      await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], expected),
    ).toBeUndefined();
  }
  expect(fixture.click).not.toHaveBeenCalled();
});

test("expanded content preserves literal control labels, Unicode, whitespace and the complete tail", async () => {
  const fixture = collapsedRecordedUser();
  fixture.expand();
  const control = fixture.bubble.querySelector("button")!;
  const prompt = "  Show less\r\nShow more Hé😀\tfinal  \n";
  fixture.replaceContent(new FakeElement("div", {}, [], prompt), control);
  expect(await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], prompt)).toMatchObject({
    sha256: createHash("sha256").update(prompt.replace(/\r\n?/g, "\n")).digest("hex"),
    fingerprint: browserPromptFingerprint(prompt, fixture.messageId),
  });
  expect(
    await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], prompt.trim()),
  ).toBeUndefined();
  expect(
    await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], prompt + "Show less"),
  ).toBeUndefined();
  const legacy = await readSubmittedPromptEvidence(fixture.page.runtime, []);
  expect(legacy?.fingerprint).toBe(
    browserPromptFingerprint(prompt + "Show less", fixture.messageId),
  );
});

test.each([
  "two users",
  "two controls",
  "misleading label",
  "unsupported control",
  "missing control",
  "disabled control",
])("refuses collapsed content with %s without clicking", async (scenario) => {
  const fixture = collapsedRecordedUser();
  if (scenario === "two users") {
    fixture.page.replace([fixture.turn, committedUser(fixture.prompt, "competing")]);
  } else if (scenario === "two controls") {
    fixture.bubble.append(new FakeElement("button", {}, [], "Show more"));
  } else if (scenario === "misleading label") {
    fixture.control.append(new FakeElement("span", {}, [], " unrelated action"));
  } else if (scenario === "unsupported control") {
    fixture.control.setAttribute("data-thread-find-skip", "false");
  } else if (scenario === "disabled control") {
    fixture.control.setAttribute("disabled", "");
  } else {
    fixture.control.remove();
  }
  expect(
    await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], fixture.prompt),
  ).toBeUndefined();
  expect(fixture.click).not.toHaveBeenCalled();
});

test.each([
  "lost user",
  "lost bubble",
  "identity",
  "transient identity",
  "navigation",
  "competing user",
  "extra bubble",
])("expansion fails closed on %s even when full text becomes available", async (scenario) => {
  const fixture = collapsedRecordedUser();
  fixture.click.mockImplementation(() => {
    fixture.expand();
    if (scenario === "lost user") fixture.user.remove();
    if (scenario === "lost bubble") fixture.bubble.remove();
    if (scenario === "identity" || scenario === "transient identity") {
      fixture.user.setAttribute("data-chatgpt-search-message-ids", "replacement");
      if (scenario === "transient identity") {
        fixture.user.setAttribute("data-chatgpt-search-message-ids", fixture.messageId);
        fixture.page.queueMutations([
          {
            type: "attributes",
            target: fixture.user,
            attributeName: "data-chatgpt-search-message-ids",
            addedNodes: [],
            removedNodes: [],
          },
        ]);
      }
    }
    if (scenario === "navigation") fixture.page.navigate();
    if (scenario === "competing user") fixture.turn.append(committedUser(fixture.prompt, "other"));
    if (scenario === "extra bubble")
      fixture.user.append(
        new FakeElement("div", { "data-user-message-bubble": "true" }, [], fixture.prompt),
      );
  });
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(fixture.page.runtime, [], fixture.prompt, 0, report),
  ).toBeUndefined();
  expect(report.mock.calls[0]![0].reason).toBe("continuity-unavailable");
  expect(fixture.click).toHaveBeenCalledTimes(1);
  expect(fixture.page.navigationListeners).toBe(0);
});

test.each(["unchanged preview", "incorrect tail"])(
  "a clicked control with %s never establishes full binding",
  async (scenario) => {
    vi.useFakeTimers();
    try {
      const fixture = collapsedRecordedUser();
      fixture.click.mockImplementation(() => {
        if (scenario === "incorrect tail")
          fixture.replaceContent(new FakeElement("div", {}, [], fixture.prompt.slice(0, -1) + "x"));
      });
      const report = vi.fn();
      const pending = readBoundSubmittedPromptEvidence(
        fixture.page.runtime,
        [],
        fixture.prompt,
        0,
        report,
      );
      await vi.runAllTimersAsync();
      expect(await pending).toBeUndefined();
      expect(fixture.click).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]![0].reason).toBe("text-mismatch");
      expect(fixture.page.navigationListeners).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

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
  // Start with assistant content, not a user bubble hidden by an assistant role.
  // A second user bubble would make nested association ambiguous before mutation.
  const other = new FakeElement(
    "div",
    {
      "data-message-author-role": "assistant",
      ...(scenario === "unidentified sibling transition"
        ? {}
        : { "data-message-id": recorded.messageId }),
    },
    [],
    "other",
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
  const page = strictDomRuntime([recorded.turn, ...(other.parentElement ? [] : [other])]);
  expect(recorded.user.querySelectorAll('[data-user-message-bubble="true"]')).toEqual([
    recorded.bubble,
  ]);
  const evidence = await readBoundSubmittedPromptEvidence(
    page.runtime,
    [],
    recorded.bubble.textContent,
  );
  expect(evidence).toBeDefined();
  expect(page.observations).toBe(1);
  expect(page.invalidated).toBe(false);
  bindSubmittedAnswer(page.runtime, evidence!);
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
  await expect(evaluateBoundAnswer(page.runtime, { expression: "null" })).rejects.toThrow(
    /observation lost or invalidated/,
  );
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
    expect(report.mock.calls[0][0]).not.toHaveProperty("scopes");
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
        ? { outcome: "rejected", reason: "context-unavailable", attempts: 1 }
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

test("mismatch scopes distinguish the selected bubble, canonical user and enclosing turn", async () => {
  const expected = "private Hé😀\nfull";
  const user = committedUser("private", "new");
  const bubble = user.children[0];
  user.append(new FakeElement("span", { "data-message-author-role": "user" }, [], " Hé😀\nfull"));
  const turn = new FakeElement("article", { "data-turn-key": "turn" }, [
    user,
    new FakeElement("button", {}, [], "control"),
  ]);
  Object.defineProperty(bubble, "innerText", { get: () => expected.replace(/\n/g, "\r\n") });
  const page = strictDomRuntime([turn]);
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], expected, 1000, report),
  ).toBeUndefined();
  const failure = report.mock.calls[0][0];
  expect(failure).toMatchObject({ rawCandidates: 2, canonicalCandidates: 1, freshCandidates: 1 });
  expect(Buffer.byteLength(JSON.stringify(failure), "utf8")).toBeLessThanOrEqual(4096);
  expect(failure.scopes.bubble).toMatchObject({
    textContent: { equalsExpected: false, containedByExpected: true, containsExpected: false },
    innerText: { equalsExpected: true, length: Buffer.byteLength(expected, "utf8") },
    readersEqual: false,
    userCount: 0,
    bubbleCount: 1,
    containsUser: false,
    containsBubble: true,
    ownedByUser: true,
  });
  expect(failure.scopes.user).toMatchObject({
    textContent: {
      equalsExpected: true,
      sha256: createHash("sha256").update(expected).digest("hex"),
    },
    readersEqual: true,
    userCount: 2,
    bubbleCount: 1,
    containsUser: true,
    containsBubble: true,
    ownedByUser: true,
  });
  expect(failure.scopes.turn).toMatchObject({
    textContent: { equalsExpected: false, containsExpected: true, containedByExpected: false },
    userCount: 2,
    ownedByUser: false,
  });
  expect(failure).not.toHaveProperty("messageId");
  expect(JSON.stringify(failure)).not.toMatch(/private|control|https:|turn-key/);
  expect(page.calls).toBe(1);
  expect(page.observations).toBe(0);
});

test("scope readings omit oversized values without truncating or losing a bounded reader", async () => {
  const user = committedUser("short", "new");
  Object.defineProperty(user.children[0], "innerText", { get: () => "é".repeat(65_536) });
  Object.defineProperty(user, "textContent", { get: () => "x".repeat(65_537) });
  Object.defineProperty(user, "innerText", { get: () => "y".repeat(65_537) });
  const page = strictDomRuntime([user]);
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], "expected", 0, report),
  ).toBeUndefined();
  const scopes = report.mock.calls[0][0].scopes;
  expect(scopes.bubble.innerText.length).toBe(131_072);
  expect(scopes.bubble.oversizedReadCount).toBe(0);
  expect(scopes.user.oversizedReadCount).toBe(2);
  expect(scopes.user).not.toHaveProperty("textContent");
  expect(scopes.user).not.toHaveProperty("innerText");
  expect(scopes.user).not.toHaveProperty("readersEqual");
  expect(scopes).not.toHaveProperty("turn");
  expect(JSON.stringify(scopes).length).toBeLessThan(2000);
});

test("scope getter failures retain no exception strings and cannot change mismatch rejection", async () => {
  const user = committedUser("private", "new");
  Object.defineProperty(user.children[0], "innerText", {
    get: () => {
      throw new Error("https://private.example/credential");
    },
  });
  const page = strictDomRuntime([user]);
  const report = vi.fn();
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], "expected", 1000, report),
  ).toBeUndefined();
  expect(report.mock.calls[0][0].scopes.bubble.unavailableReadCount).toBe(1);
  expect(report.mock.calls[0][0].scopes.bubble).not.toHaveProperty("innerText");
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/private|credential|https:/);
  expect(page.calls).toBe(1);
  expect(page.observations).toBe(0);
});

test("exact success never reads alternate scopes or retains their evidence", async () => {
  const user = committedUser("exact", "new");
  const alternateRead = vi.fn(() => {
    throw new Error("alternate must not be read");
  });
  Object.defineProperty(user, "textContent", { get: alternateRead });
  Object.defineProperty(user.children[0], "innerText", { get: alternateRead });
  const page = strictDomRuntime([user]);
  const report = vi.fn();
  const evidence = await readBoundSubmittedPromptEvidence(page.runtime, [], "exact", 0, report);
  expect(evidence).toMatchObject({ messageId: "new", length: 5 });
  expect(evidence).not.toHaveProperty("scopes");
  expect(alternateRead).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

test("scope metadata allowlist rejects injected evidence, private fields, invalid counts and oversized strings", async () => {
  const report = vi.fn();
  const runtime = {
    evaluate: async () => ({
      result: {
        value: {
          associationRejected: true,
          diagnostic: {
            reason: "text-mismatch",
            freshCandidates: 1,
            missingIdentities: 0,
            scopes: {
              bubble: {
                textContent: "short",
                innerText: "x".repeat(65_537),
                sha256: "private",
                length: 123,
                equalsExpected: true,
                messageId: "private",
                observationId: "private",
                conversationId: "private",
                rawDOM: "private",
                url: "private",
                exception: "private",
                userCount: Infinity,
                bubbleCount: -1,
                oversizedReadCount: 1e12,
                unavailableReadCount: 1.9,
                containsUser: "private",
                containsBubble: true,
                ownedByUser: false,
              },
              unknown: { textContent: "private" },
            },
          },
        },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  expect(
    await readBoundSubmittedPromptEvidence(runtime, [], "expected", 0, report),
  ).toBeUndefined();
  expect(report.mock.calls[0][0].scopes).toEqual({
    bubble: {
      textContent: {
        length: 5,
        sha256: createHash("sha256").update("short").digest("hex"),
        equalsExpected: false,
        containsExpected: false,
        containedByExpected: false,
      },
      oversizedReadCount: 2,
      unavailableReadCount: 1,
      containsBubble: true,
      ownedByUser: false,
    },
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

for (const completes of [false, true]) {
  test(`mismatch samples remain failure-only when later text is ${completes ? "complete" : "partial"}`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const user = committedUser("short", "private-message-id");
      const bubble = user.children[0];
      let text = "short";
      Object.defineProperty(bubble, "textContent", { get: () => text });
      const page = strictDomRuntime(
        [new FakeElement("article", { "data-turn-key": "private-turn" }, [user])],
        true,
      );
      const report = vi.fn();
      const pending = readBoundSubmittedPromptEvidence(
        page.runtime,
        [],
        "complete Hé😀\r\nprompt",
        0,
        report,
      );
      await vi.advanceTimersByTimeAsync(250);
      if (completes) text = "complete Hé😀\nprompt";
      await vi.advanceTimersByTimeAsync(750);
      expect(await pending).toBeUndefined();
      expect(page.calls).toBe(1);
      expect(page.invalidated).toBeUndefined();
      expect(page.disconnected).toBe(1);
      expect(page.navigationListeners).toBe(0);
      const failure = report.mock.calls[0][0];
      expect(failure.reason).toBe("text-mismatch");
      expect(failure.observationAvailable).toBe(false);
      expect(failure.mismatchSamples).toEqual([
        {
          elapsedMs: 250,
          length: 5,
          sha256: createHash("sha256").update("short").digest("hex"),
          equalsExpected: false,
        },
        {
          elapsedMs: 1000,
          length: Buffer.byteLength(text),
          sha256: createHash("sha256").update(text).digest("hex"),
          equalsExpected: completes,
        },
      ]);
      const saved = JSON.stringify(failure);
      for (const secret of [
        "short",
        "complete",
        "private-message-id",
        "private-turn",
        "https://chatgpt.com",
        "prompt",
      ]) {
        expect(saved).not.toContain(secret);
      }
    } finally {
      vi.useRealTimers();
    }
  });
}

test.each([
  "identity-restored",
  "competitor-removed",
  "missing-identity",
  "detach-reinsert",
  "bubble-replaced",
  "navigation-return",
])("mismatch sampling discards every sample after a correlation race: %s", async (race) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const user = committedUser("short", "new");
    const turn = new FakeElement("article", { "data-turn-key": "turn" }, [user]);
    const page = strictDomRuntime([turn], true);
    const report = vi.fn();
    const pending = readBoundSubmittedPromptEvidence(page.runtime, [], "expected", 5000, report);
    await vi.advanceTimersByTimeAsync(250);
    if (race === "navigation-return") page.navigate();
    else if (race === "identity-restored") {
      // The final DOM already has the original ID; the mutation must still invalidate it.
      page.mutate([
        {
          type: "attributes",
          target: user,
          attributeName: "data-message-id",
          removedNodes: [],
          addedNodes: [],
        },
      ]);
    } else {
      const node =
        race === "detach-reinsert"
          ? user
          : race === "bubble-replaced"
            ? user.children[0]
            : committedUser("other", race === "missing-identity" ? undefined : "competitor");
      page.mutate([{ type: "childList", target: turn, removedNodes: [node], addedNodes: [node] }]);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBeUndefined();
    expect(report.mock.calls[0][0]).not.toHaveProperty("mismatchSamples");
    expect(page.calls).toBe(1);
    expect(page.disconnected).toBe(1);
    expect(page.navigationListeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("mismatch sampling is omitted without navigation continuity or a canonical turn", async () => {
  const report = vi.fn();
  const page = strictDomRuntime([committedUser("short", "new")], true);
  expect(
    await readBoundSubmittedPromptEvidence(page.runtime, [], "expected", 0, report),
  ).toBeUndefined();
  expect(report.mock.calls[0][0]).not.toHaveProperty("mismatchSamples");
  expect(page.observations).toBe(0);
});

test.each(["missing", "competing"])(
  "identity rejection schedules no diagnostic waits: %s",
  async (kind) => {
    vi.useFakeTimers();
    try {
      const users = [committedUser("short", kind === "missing" ? undefined : "new")];
      if (kind === "competing") users.push(committedUser("short", "other"));
      const page = strictDomRuntime(users, true);
      const report = vi.fn();
      expect(
        await readBoundSubmittedPromptEvidence(page.runtime, [], "expected", 1000, report),
      ).toBeUndefined();
      expect(report.mock.calls[0][0]).not.toHaveProperty("mismatchSamples");
      expect(page.observations).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(
  [
    [{ elapsedMs: 250, text: "private" }],
    [
      { elapsedMs: 250, text: "private" },
      { elapsedMs: 1000, text: "x".repeat(65_537) },
    ],
    [
      { elapsedMs: -1, text: "private" },
      { elapsedMs: 1000, text: "private" },
    ],
    [
      { elapsedMs: 250, text: "private" },
      { elapsedMs: 1501, text: "private" },
    ],
    [
      { elapsedMs: 250, text: "private" },
      { elapsedMs: NaN, text: "private" },
    ],
  ].map((mismatchSamples) => ({ mismatchSamples })),
)("malformed temporal diagnostics are omitted as a unit: %#", async ({ mismatchSamples }) => {
  const runtime = {
    evaluate: async () => ({
      result: {
        value: {
          associationRejected: true,
          diagnostic: {
            reason: "text-mismatch",
            freshCandidates: 1,
            missingIdentities: 0,
            mismatchSamples,
          },
        },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const report = vi.fn();
  await readBoundSubmittedPromptEvidence(runtime, [], "expected", 0, report);
  expect(report.mock.calls[0][0]).not.toHaveProperty("mismatchSamples");
  expect(JSON.stringify(report.mock.calls)).not.toContain("private");
});

test("temporal metadata copies only bounded measurements and computes its own hashes", async () => {
  const runtime = {
    evaluate: async () => ({
      result: {
        value: {
          associationRejected: true,
          diagnostic: {
            reason: "text-mismatch",
            freshCandidates: 1,
            missingIdentities: 0,
            mismatchSamples: [250, 1000].map((elapsedMs) => ({
              elapsedMs,
              text: "Hé😀\r\n",
              sha256: "secret",
              messageId: "secret",
              dom: "secret",
              equalsExpected: false,
            })),
          },
        },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const report = vi.fn();
  await readBoundSubmittedPromptEvidence(runtime, [], "Hé😀\n", 0, report);
  expect(report.mock.calls[0][0].mismatchSamples).toEqual(
    [250, 1000].map((elapsedMs) => ({
      elapsedMs,
      length: Buffer.byteLength("Hé😀\n"),
      sha256: createHash("sha256").update("Hé😀\n").digest("hex"),
      equalsExpected: true,
    })),
  );
  expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
});

test("strict context loss never retries an evaluation that may already be sampling a mismatch", async () => {
  const report = vi.fn();
  const evaluate = vi
    .fn()
    .mockRejectedValueOnce(new Error("Execution context was destroyed: secret"))
    .mockResolvedValue({
      result: {
        value: {
          text: "expected",
          messageId: "new",
          conversationId: "conversation",
          observationId: "observation",
        },
      },
    });
  expect(
    await readBoundSubmittedPromptEvidence(
      { evaluate } as unknown as ChromeClient["Runtime"],
      [],
      "expected",
      5000,
      report,
    ),
  ).toBeUndefined();
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(evaluate.mock.calls[0][0]).toMatchObject({ awaitPromise: true });
  expect(report.mock.calls[0][0]).toMatchObject({
    outcome: "rejected",
    reason: "context-unavailable",
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
});

test.each(["oversized", "throwing", "queued-identity"])(
  "unsafe later sample removes the whole sequence: %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const user = committedUser("short", "new");
      const bubble = user.children[0];
      const page = strictDomRuntime(
        [new FakeElement("article", { "data-turn-key": "turn" }, [user])],
        true,
      );
      const report = vi.fn();
      const pending = readBoundSubmittedPromptEvidence(page.runtime, [], "expected", 0, report);
      await vi.advanceTimersByTimeAsync(250);
      Object.defineProperty(bubble, "textContent", {
        get: () => {
          if (scenario === "throwing") throw new Error("secret");
          if (scenario === "queued-identity")
            page.queueMutations([
              {
                type: "attributes",
                target: user,
                attributeName: "data-message-id",
                removedNodes: [],
                addedNodes: [],
              },
            ]);
          return scenario === "oversized" ? "x".repeat(65_537) : "expected";
        },
      });
      await vi.advanceTimersByTimeAsync(750);
      expect(await pending).toBeUndefined();
      expect(report.mock.calls[0][0].reason).toBe("text-mismatch");
      expect(report.mock.calls[0][0]).not.toHaveProperty("mismatchSamples");
      expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
      expect(page.disconnected).toBe(1);
      expect(page.navigationListeners).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
