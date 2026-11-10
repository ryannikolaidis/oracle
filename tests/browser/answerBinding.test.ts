import {
  buildAssistantExtractorForTest,
  readAssistantSnapshot,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  finalizeBoundAssistantAnswer,
  verifyBoundAssistantReturn,
} from "../../src/browser/actions/assistantResponse.js";
import { expect, test, vi } from "vitest";
import type { ChromeClient } from "../../src/browser/types.js";
import {
  answerDigest,
  bindSubmittedAnswer,
  evaluateBoundAnswer,
  recordBoundAnswer,
  recheckBoundAnswer,
  restoreAnswerBinding,
} from "../../src/browser/answerBinding.js";
import {
  browserPromptFingerprint,
  readBoundSubmittedPromptEvidence,
  readSubmittedPromptEvidence,
} from "../../src/browser/promptFingerprint.js";
import {
  buildPromptObservationExpression,
  releasePromptObservation,
} from "../../src/browser/promptObservation.js";
import { FakeDocument, FakeElement } from "./domFixture.js";
import { readStructuredAnswer } from "../../src/browser/structuredAnswer.js";

const prompt = "  Hé😀\r\n\tReview this exact source  ";
const normalized = prompt.replace(/\r\n?/g, "\n");
const receipt = {
  fingerprint: browserPromptFingerprint(prompt, "user-original"),
  sha256: answerDigest(normalized),
  length: Buffer.byteLength(normalized, "utf8"),
  messageId: "user-original",
  conversationId: "conversation-original",
  observationId: "observation-original",
};
const assistant = (id = "answer-original") =>
  new FakeElement(
    "div",
    {
      "data-message-author-role": "assistant",
      "data-message-id": id,
    },
    [],
    "The bound answer",
  );
const user = (text = prompt, id = "user-original") =>
  new FakeElement(
    "div",
    {
      "data-message-author-role": "user",
      "data-message-id": id,
    },
    [new FakeElement("div", { "data-user-message-bubble": "true" }, [], text)],
  );

function page(initial: FakeElement[] = [user(), assistant()]) {
  const document = new FakeDocument(initial);
  const location = { href: "https://chatgpt.com/c/conversation-original" };
  const observation = { invalidated: false, conversationId: receipt.conversationId };
  const registry = new Map([[receipt.observationId, observation]]);
  const global = { __oraclePromptObservations: registry };
  let during: (() => void) | undefined;
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: await new Function(
          "document",
          "location",
          "globalThis",
          "during",
          "HTMLElement",
          "window",
          `return ${expression}`,
        )(document, location, global, () => during?.(), FakeElement, {
          getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  bindSubmittedAnswer(runtime, receipt);
  return {
    runtime,
    document,
    location,
    observation,
    registry,
    setDuring: (fn: () => void) => {
      during = fn;
    },
  };
}
const selection = {
  expression: '({ text: "The bound answer", messageId: "answer-original" })',
  returnByValue: true,
};

test("accepts only the observed user and the identified following assistant, preserving UTF-8 normalization", async () => {
  const { runtime } = page();
  const result = await evaluateBoundAnswer(runtime, selection);
  expect(result.result.value).toEqual({ text: "The bound answer", messageId: "answer-original" });
});

test("allows an observer to start before the assistant mounts", async () => {
  const p = page([user()]);
  p.setDuring(() => p.document.body.append(assistant()));
  expect(
    (
      await evaluateBoundAnswer(p.runtime, {
        expression:
          '(async () => { during(); return { text: "The bound answer", messageId: "answer-original" }; })()',
      })
    ).result.value.messageId,
  ).toBe("answer-original");
});

test.each([
  ["edited user", () => [user("edited instruction"), assistant()]],
  ["same text with replaced identity", () => [user(prompt, "replacement"), assistant()]],
  ["missing user", () => [assistant()]],
  [
    "intervening user and answer",
    () => [
      user(),
      assistant(),
      user("revise the review", "intervening"),
      assistant("later-answer"),
    ],
  ],
  [
    "intervening unanswered user",
    () => [user(), assistant(), user("new instruction", "intervening")],
  ],
  ["duplicate user identity", () => [user(), user(), assistant()]],
  ["ambiguous assistant siblings", () => [user(), assistant(), assistant("other-answer")]],
])(
  "rejects %s even when a candidate answer retains the requested schema",
  async (_label, nodes) => {
    const p = page((nodes as () => FakeElement[])());
    await expect(evaluateBoundAnswer(p.runtime, selection)).rejects.toThrow(/binding rejected/);
  },
);

test.each(["https://chatgpt.com/c/different", "https://chatgpt.com/"])(
  "rejects missing or changed conversation %s",
  async (href) => {
    const p = page();
    p.location.href = href;
    await expect(evaluateBoundAnswer(p.runtime, selection)).rejects.toThrow(/binding rejected/);
  },
);

test("rejects selection of an old assistant even if its text is identical", async () => {
  const p = page([assistant("old-answer"), user(), assistant()]);
  await expect(
    evaluateBoundAnswer(p.runtime, {
      expression: '({ text: "The bound answer", messageId: "old-answer" })',
    }),
  ).rejects.toThrow(/unrelated assistant/);
});

test("rejects identity-free layout fallback and an unrelated copy target", async () => {
  const p = page();
  await expect(
    evaluateBoundAnswer(p.runtime, { expression: '({ text: "plausible answer" })' }),
  ).rejects.toThrow();
  const q = page();
  await expect(
    evaluateBoundAnswer(
      q.runtime,
      { expression: '({ success: true, markdown: "copied" })' },
      "unrelated",
    ),
  ).rejects.toThrow();
});

test("rejects a plain string recovery result without assistant identity", async () => {
  const p = page();
  await expect(
    evaluateBoundAnswer(p.runtime, { expression: '"plausible answer without provenance"' }),
  ).rejects.toThrow(/binding rejected/);
});

test("rechecks user text after asynchronous selection and permanently refuses swallowed failures", async () => {
  const p = page();
  p.setDuring(() => {
    p.observation.invalidated = true;
  });
  await expect(
    evaluateBoundAnswer(p.runtime, {
      expression:
        '(async () => { during(); return { text: "answer", messageId: "answer-original" }; })()',
    }),
  ).rejects.toThrow(/observation lost or invalidated/);
  p.observation.invalidated = false;
  await expect(evaluateBoundAnswer(p.runtime, selection)).rejects.toThrow(/invalidated/);
});

test("refuses lost observation on reload instead of minting new continuity during recovery", async () => {
  const p = page();
  p.registry.clear();
  await expect(evaluateBoundAnswer(p.runtime, selection)).rejects.toThrow(
    /observation lost or invalidated/,
  );
  expect(() =>
    restoreAnswerBinding(p.runtime, { submittedPromptHash: receipt.fingerprint }),
  ).toThrow(/no verifiable/);
});

test("persists exact output hashes and rejects a changed final answer or assistant", () => {
  const p = page();
  const snapshot = { messageId: "answer-original", text: "answer", html: "<p>answer</p>" };
  const evidence = recordBoundAnswer(p.runtime, snapshot, "answer", "**answer**");
  expect(evidence).toMatchObject({
    version: 1,
    relationship: "sole-assistant-after-user",
    userMessageId: receipt.messageId,
    conversationId: receipt.conversationId,
    userSha256: receipt.sha256,
    userLength: receipt.length,
    assistantMessageId: "answer-original",
    answerTextSha256: answerDigest("answer"),
    answerMarkdownSha256: answerDigest("**answer**"),
  });
  expect(recheckBoundAnswer(p.runtime, snapshot, "answer", "**answer**")).toEqual(evidence);
  for (const changed of [
    { ...snapshot, text: "later answer" },
    { ...snapshot, messageId: "later" },
    null,
  ]) {
    expect(() => recheckBoundAnswer(p.runtime, changed, "answer", "**answer**")).toThrow(/changed/);
  }
  expect(() => recheckBoundAnswer(p.runtime, snapshot, "answer", "later markdown")).toThrow(
    /changed/,
  );
});

test("non-session DOM snapshot utilities keep their old interface without producing relationship evidence", async () => {
  const runtime = {
    evaluate: async () => ({ result: { value: "legacy candidate" } }),
  } as unknown as ChromeClient["Runtime"];
  expect((await evaluateBoundAnswer(runtime, { expression: "1" })).result.value).toBe(
    "legacy candidate",
  );
  expect(() => recordBoundAnswer(runtime, { messageId: "id" }, "text", "text")).toThrow(
    /Cannot establish/,
  );
});

test("installs continuity observation atomically with the observed prompt read", async () => {
  const document = new FakeDocument([user()]);
  const registry: Record<string, unknown> = {};
  const observers: Array<(records: unknown[]) => void> = [];
  class Observer {
    constructor(callback: (records: unknown[]) => void) {
      observers.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: {
        value: new Function(
          "document",
          "location",
          "globalThis",
          "MutationObserver",
          "crypto",
          `return ${expression}`,
        )(document, { href: "https://chatgpt.com/c/conversation-original" }, registry, Observer, {
          randomUUID: () => "observation-original",
        }),
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  const ordinary = await readSubmittedPromptEvidence(runtime, []);
  expect(ordinary?.sha256).toBe(receipt.sha256);
  expect(ordinary?.observationId).toBeUndefined();
  expect(observers).toHaveLength(0);
  expect(registry.__oraclePromptObservations).toBeUndefined();
  expect(await readBoundSubmittedPromptEvidence(runtime, [], prompt)).toMatchObject(receipt);
  expect(observers).toHaveLength(1);
});

test.each(["edit", "remove", "intervening"])(
  "latches %s even if the DOM is subsequently restored",
  (mode) => {
    const observed = user();
    const document = new FakeDocument([observed]);
    const registry: { __oraclePromptObservations?: Map<string, { invalidated: boolean }> } = {};
    let callback: (records: unknown[]) => void = () => {};
    class Observer {
      constructor(fn: typeof callback) {
        callback = fn;
      }
      observe() {}
      disconnect() {}
    }
    const expression = buildPromptObservationExpression("observed");
    new Function(
      "document",
      "location",
      "globalThis",
      "MutationObserver",
      "crypto",
      "observed",
      `return ${expression}`,
    )(
      document,
      { href: "https://chatgpt.com/c/conversation-original" },
      registry,
      Observer,
      { randomUUID: () => "token" },
      observed,
    );
    const bubble = observed.querySelector('[data-user-message-bubble="true"]')!;
    callback([
      {
        target: mode === "edit" ? bubble : document.body,
        type: "childList",
        addedNodes: mode === "intervening" ? [user("revision", "later")] : [],
        removedNodes: mode === "remove" ? [observed] : [],
      },
    ]);
    expect(registry.__oraclePromptObservations?.get("token")?.invalidated).toBe(true);
  },
);

function protocolRuntime(candidate: unknown, changedAfter = false) {
  const read = {
    conversationId: receipt.conversationId,
    userMessageId: receipt.messageId,
    userIds: [receipt.messageId],
    userText: prompt,
    assistantIds: ["answer-original"],
    roles: ["assistant"],
  };
  const runtime = {
    evaluate: async () => ({
      result: {
        type: "object",
        value: {
          before: read,
          after: changedAfter ? { ...read, userText: "edited during capture" } : read,
          observationValid: true,
          value: candidate,
        },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  bindSubmittedAnswer(runtime, receipt);
  return runtime;
}

test("snapshot and copy public surfaces enforce binding even without a conversation/index argument", async () => {
  await expect(
    readAssistantSnapshot(protocolRuntime({ text: "later", messageId: "later" })),
  ).rejects.toThrow(/unrelated assistant/);
  await expect(
    captureAssistantMarkdown(
      protocolRuntime({ success: true, markdown: "later" }, true),
      { messageId: "answer-original" },
      () => {},
    ),
  ).rejects.toThrow(/binding rejected/);
});

test("final capture and successful-return gate reject post-capture edits rather than a longer recovery candidate", async () => {
  const snapshot = {
    text: "Bound final answer",
    html: "<p>Bound final answer</p>",
    messageId: "answer-original",
  };
  let changed = false;
  const read = {
    conversationId: receipt.conversationId,
    userMessageId: receipt.messageId,
    userIds: [receipt.messageId],
    userText: prompt,
    assistantIds: ["answer-original"],
    roles: ["assistant"],
  };
  const runtime = {
    evaluate: async () => ({
      result: {
        type: "object",
        value: {
          before: read,
          after: read,
          observationValid: true,
          value: changed ? { ...snapshot, text: "Different answer" } : snapshot,
        },
      },
    }),
  } as unknown as ChromeClient["Runtime"];
  bindSubmittedAnswer(runtime, receipt);
  const result = await finalizeBoundAssistantAnswer(runtime, () => {});
  expect(result.text).toBe(snapshot.text);
  expect(result.markdown).toBe(snapshot.text);
  expect(result.answerRelationship.assistantMessageId).toBe(snapshot.messageId);
  changed = true;
  await expect(verifyBoundAssistantReturn(runtime, result.text, result.markdown)).rejects.toThrow(
    /changed/,
  );
});

test("bound capture ignores competing clipboard bytes with an unchanged assistant DOM", async () => {
  const snapshot = {
    text: "  The intended answer\nGo\n  keep indentation\n",
    html: "<p>The intended answer</p><pre>Go\n  keep indentation</pre>",
    messageId: "answer-original",
  };
  const read = {
    conversationId: receipt.conversationId,
    userMessageId: receipt.messageId,
    userIds: [receipt.messageId],
    userText: prompt,
    assistantIds: [snapshot.messageId],
    roles: ["assistant"],
  };
  let copyAttempts = 0;
  let clipboard = "An unrelated earlier answer";
  const runtime = {
    evaluate: async ({ expression }: { expression: string }) => {
      // Another controller can replace the clipboard during every capture read.
      clipboard = "Unrelated code block copied concurrently";
      const copying =
        expression.includes("navigator.clipboard") || expression.includes("const BUTTON_SELECTOR");
      if (copying) copyAttempts++;
      return {
        result: {
          value: {
            before: read,
            after: read,
            observationValid: true,
            value: copying ? { success: true, markdown: clipboard } : snapshot,
          },
        },
      };
    },
  } as unknown as ChromeClient["Runtime"];
  bindSubmittedAnswer(runtime, receipt);
  expect(await captureAssistantMarkdown(runtime, snapshot, () => {})).toBe(snapshot.text);
  const result = await finalizeBoundAssistantAnswer(runtime, () => {});
  expect(result.markdown).toBe(snapshot.text);
  expect(result.markdown).not.toBe(clipboard);
  expect(copyAttempts).toBe(0);
  expect(result.answerRelationship.answerMarkdownSha256).toBe(answerDigest(snapshot.text));
  await expect(verifyBoundAssistantReturn(runtime, result.text, result.markdown)).resolves.toEqual(
    result.answerRelationship,
  );
});

test("image-only completion labels and saved-file summaries are not assistant output", async () => {
  const snapshot = {
    text: "Generated image.",
    contentText: "",
    html: '<img src="/backend-api/estuary/content?id=file_image">',
    messageId: "answer-original",
  };
  const runtime = protocolRuntime(snapshot);
  const result = await finalizeBoundAssistantAnswer(runtime, () => {});
  expect(result.text).toBe("");
  expect(result.markdown).toBe("");
  expect(result.answerRelationship.answerTextSha256).toBe(answerDigest(""));
  expect(result.answerRelationship.answerMarkdownSha256).toBe(answerDigest(""));
  await expect(verifyBoundAssistantReturn(runtime, result.text, result.markdown)).resolves.toEqual(
    result.answerRelationship,
  );
  await expect(
    verifyBoundAssistantReturn(
      runtime,
      result.text,
      "\n\n*Generated 1 image(s). Saved to: /scratch/image.png*",
    ),
  ).rejects.toThrow(/changed/);
});

test.each([
  ["data-message-author-role", "assistant", "user"],
  ["data-content-search-unit-key", "turn:assistant", "turn:user"],
  ["data-chatgpt-search-unit-key", "turn:assistant", "turn:user"],
])(
  "latches batched appearance and reversion through %s before the next guarded read",
  async (attribute, original, transient) => {
    const observed = user();
    const other = assistant();
    const p = page([observed, other]);
    let callback: (records: unknown[]) => void = () => {};
    let options: unknown;
    class Observer {
      constructor(fn: typeof callback) {
        callback = fn;
      }
      observe(_target: unknown, config: unknown) {
        options = config;
      }
      disconnect() {}
    }
    new Function(
      "document",
      "location",
      "globalThis",
      "MutationObserver",
      "crypto",
      "observed",
      `return ${buildPromptObservationExpression("observed")}`,
    )(
      p.document,
      p.location,
      { __oraclePromptObservations: p.registry },
      Observer,
      { randomUUID: () => receipt.observationId },
      observed,
    );
    expect(options).toMatchObject({ attributes: true, attributeOldValue: true });
    other.setAttribute(attribute, transient);
    other.setAttribute(attribute, original);
    // MutationObserver delivers both records after the DOM has already reverted.
    callback(
      [original, transient].map((oldValue) => ({
        type: "attributes",
        target: other,
        attributeName: attribute,
        oldValue,
        addedNodes: [],
        removedNodes: [],
      })),
    );
    await expect(evaluateBoundAnswer(p.runtime, selection)).rejects.toThrow(
      /observation lost or invalidated/,
    );
  },
);

test("image extractor keeps synthetic completion text separate from bound assistant content", () => {
  const image = Object.assign(new FakeElement("img"), {
    src: "https://chatgpt.com/backend-api/estuary/content?id=file_image",
  });
  const message = new FakeElement(
    "div",
    {
      "data-message-author-role": "assistant",
      "data-message-id": "answer-original",
    },
    [image],
  );
  const document = new FakeDocument([message]);
  const snapshot = new Function(
    "document",
    "HTMLElement",
    `${buildAssistantExtractorForTest("capture")}; return capture();`,
  )(document, FakeElement);
  expect(snapshot).toMatchObject({
    text: "Generated image.",
    contentText: "",
    messageId: "answer-original",
  });
});

function jsonAssistant(text: string, id = "answer-original") {
  const code = new FakeElement("code", { class: "language-json" }, [], text);
  const pre = new FakeElement("pre", {}, [code]);
  const message = new FakeElement(
    "div",
    {
      "data-message-author-role": "assistant",
      "data-message-id": id,
    },
    [new FakeElement("div", { class: "markdown" }, [pre])],
  );
  return { message, pre, code };
}

test("structured finalization hashes exact returned code bytes and never evaluates clipboard capture", async () => {
  const text = ' {"review":"Hé😀 [link](https://example.com) `code`\\n```ts\\nx\\n```"}\n';
  const answer = jsonAssistant(text);
  const p = page([jsonAssistant('{"old":true}', "old-answer").message, user(), answer.message]);
  const evaluate = p.runtime.evaluate.bind(p.runtime);
  const expressions: string[] = [];
  p.runtime.evaluate = async (params) => {
    expressions.push(params.expression);
    return evaluate(params);
  };
  const result = await finalizeBoundAssistantAnswer(p.runtime, () => {}, "json-code");
  expect(result.text).toBe(text);
  expect(result.markdown).toBe(text);
  expect(result.answerRelationship).toMatchObject({
    answerCapture: "json-code",
    assistantMessageId: "answer-original",
    answerTextSha256: answerDigest(text),
    answerMarkdownSha256: answerDigest(text),
  });
  await expect(verifyBoundAssistantReturn(p.runtime, text, text, "json-code")).resolves.toEqual(
    result.answerRelationship,
  );
  expect(
    expressions.every(
      (expression) =>
        !expression.includes("navigator.clipboard") && !expression.includes("writeText"),
    ),
  ).toBe(true);
  await expect(
    verifyBoundAssistantReturn(p.runtime, text.trim(), text.trim(), "json-code"),
  ).rejects.toThrow(/changed/);
  answer.code.remove();
  answer.pre.append(new FakeElement("code", { class: "language-json" }, [], '{"changed":true}'));
  await expect(verifyBoundAssistantReturn(p.runtime, text, text, "json-code")).rejects.toThrow(
    /changed/,
  );
});

test.each([
  "edited user",
  "lost observation",
  "intervening user",
  "second assistant",
  "mixed layout",
])("structured return refuses %s even when JSON remains valid", async (failure) => {
  const text = '{"review":"valid JSON"}';
  const answer = jsonAssistant(text);
  const p = page([user(), answer.message]);
  const result = await finalizeBoundAssistantAnswer(p.runtime, () => {}, "json-code");
  if (failure === "edited user") {
    p.document.body.children[0]!.remove();
    p.document.body.children.unshift(user("edited"));
  } else if (failure === "lost observation") p.registry.clear();
  else if (failure === "intervening user") p.document.body.append(user("new", "later-user"));
  else if (failure === "second assistant")
    p.document.body.append(jsonAssistant(text, "second-answer").message);
  else answer.message.append(new FakeElement("div", {}, [], "extra prose"));
  await expect(
    verifyBoundAssistantReturn(p.runtime, result.text, result.markdown, "json-code"),
  ).rejects.toThrow();
});

test("structured reader refuses unbound utilities and duplicate matching assistant roots", async () => {
  const runtime = {
    evaluate: async () => {
      throw new Error("must not read DOM");
    },
  } as unknown as ChromeClient["Runtime"];
  await expect(readStructuredAnswer(runtime)).rejects.toThrow(/Cannot establish/);
  const p = page([user(), jsonAssistant("{}").message, jsonAssistant("{}").message]);
  await expect(readStructuredAnswer(p.runtime)).rejects.toThrow();
});

test("structured return revalidates layout while allowing accepted code-header text changes", async () => {
  const text = ' {"ok":true}\n';
  const answer = jsonAssistant(text);
  const header = new FakeElement("div", {}, [new FakeElement("span", {}, [], "json")]);
  let button = new FakeElement("button", {}, [], "Copy code");
  header.append(button);
  answer.pre.children.unshift(header);
  header.parentElement = answer.pre;
  // Exercise the HTML comparison as well as the extraction path in the fake DOM.
  Object.defineProperty(answer.message, "innerHTML", {
    get: () => `<pre>json<button>${button.textContent}</button><code>${text}</code></pre>`,
  });
  const p = page([user(), answer.message]);
  const result = await finalizeBoundAssistantAnswer(p.runtime, () => {}, "json-code");
  for (const label of ["Copied", "Copied!", "Copy"]) {
    button.remove();
    button = new FakeElement("button", {}, [], label);
    header.append(button);
    await expect(verifyBoundAssistantReturn(p.runtime, text, text, "json-code")).resolves.toEqual(
      result.answerRelationship,
    );
  }
  button.remove();
  button = new FakeElement("button", {}, [], "Run code");
  header.append(button);
  await expect(verifyBoundAssistantReturn(p.runtime, text, text, "json-code")).rejects.toThrow(
    /Structured answer/,
  );
});

test.each(["message-id", "turn-key"])(
  "binds JSON capture to an ARTICLE assistant using %s",
  async (identity) => {
    const answer = jsonAssistant('{"ok":true}');
    const message = new FakeElement(
      "article",
      {
        "data-turn": "assistant",
        [identity === "message-id" ? "data-message-id" : "data-turn-key"]: "answer-original",
      },
      [...answer.message.children],
    );
    const observed = user();
    if (identity === "turn-key") observed.setAttribute("data-turn-key", receipt.messageId);
    const p = page([observed, message]);
    const result = await finalizeBoundAssistantAnswer(p.runtime, () => {}, "json-code");
    expect(result.text).toBe('{"ok":true}');
    expect(result.answerRelationship.assistantMessageId).toBe("answer-original");
  },
);

test.each([
  { identity: "own", recover: false },
  { identity: "ancestor", recover: false },
  { identity: "own", recover: true },
  { identity: "ancestor", recover: true },
])(
  "strict turn-key $identity identity survives waiting and capture (recovery: $recover)",
  async ({ identity, recover }) => {
    vi.useFakeTimers();
    try {
      const text = ' {"review":"Hé😀", "ok":true}\n';
      const answer = jsonAssistant(text);
      const message = new FakeElement(
        "article",
        {
          "data-turn": "assistant",
          ...(identity === "own" ? { "data-turn-key": "answer-original" } : {}),
        },
        [...answer.message.children],
      );
      const observed = user();
      observed.setAttribute("data-turn-key", receipt.messageId);
      // Completion controls live outside the answer body, in its enclosing turn.
      const exchange = new FakeElement("div", { "data-turn-key": "answer-original" }, [
        message,
        new FakeElement("button", { "data-testid": "copy-turn-action-button" }),
      ]);
      const p = page([observed, exchange]);
      if (recover)
        restoreAnswerBinding(p.runtime, {
          submittedPromptHash: receipt.fingerprint,
          submittedPromptSha256: receipt.sha256,
          submittedPromptLength: receipt.length,
          submittedPromptMessageId: receipt.messageId,
          submittedPromptConversationId: receipt.conversationId,
          submittedPromptObservationId: receipt.observationId,
        });
      const evaluate = p.runtime.evaluate.bind(p.runtime);
      let observerFailed = false;
      p.runtime.evaluate = async (params) => {
        if (recover && !observerFailed && params.expression.includes("const SELECTORS =")) {
          observerFailed = true;
          throw new Error("observer evaluation interrupted");
        }
        return evaluate(params);
      };
      const logs: string[] = [];
      const waiting = waitForAssistantResponse(
        p.runtime,
        20_000,
        (line) => logs.push(line),
        1,
        receipt.conversationId,
      );
      // Observe rejection immediately, then assert after advancing the fake clock.
      const waited = Promise.allSettled([waiting]);
      await vi.advanceTimersByTimeAsync(20_000);
      const [outcome] = await waited;
      if (outcome.status === "rejected") throw outcome.reason;
      const response = outcome.value;
      expect(response).toMatchObject({
        text: text.trim(),
        meta: { messageId: "answer-original" },
      });
      expect(observerFailed).toBe(recover);
      if (recover)
        expect(logs).toContain("Recovered and confirmed assistant response via polling fallback");
      expect(await captureAssistantMarkdown(p.runtime, response.meta, () => {})).toBe(text);
      const result = await finalizeBoundAssistantAnswer(p.runtime, () => {}, "json-code");
      expect(result.text).toBe(text);
      expect(result.markdown).toBe(text);
      expect(result.answerRelationship).toMatchObject({
        assistantMessageId: "answer-original",
        answerTextSha256: answerDigest(text),
        answerMarkdownSha256: answerDigest(text),
        answerCapture: "json-code",
      });
      await expect(verifyBoundAssistantReturn(p.runtime, text, text, "json-code")).resolves.toEqual(
        result.answerRelationship,
      );
      // Recovery never recreates continuity after the original observation is lost.
      p.registry.clear();
      await expect(readAssistantSnapshot(p.runtime)).rejects.toThrow(
        /observation lost or invalidated/,
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);

test("releases only the completed observation and refuses subsequent bound reads", async () => {
  const p = page();
  let disconnected = 0;
  class Observer {
    observe() {}
    disconnect() {
      disconnected += 1;
    }
  }
  const observed = p.document.querySelector('[data-message-author-role="user"]');
  new Function(
    "document",
    "location",
    "globalThis",
    "MutationObserver",
    "crypto",
    "observed",
    `return ${buildPromptObservationExpression("observed")}`,
  )(
    p.document,
    p.location,
    { __oraclePromptObservations: p.registry },
    Observer,
    { randomUUID: () => receipt.observationId },
    observed,
  );
  const other = { invalidated: false, conversationId: "other" };
  p.registry.set("other", other);
  await expect(evaluateBoundAnswer(p.runtime, selection)).resolves.toBeDefined();
  expect(disconnected).toBe(0);
  await releasePromptObservation(p.runtime, receipt.observationId);
  expect(disconnected).toBe(1);
  expect(p.registry.has(receipt.observationId)).toBe(false);
  expect(p.registry.get("other")).toBe(other);
  await releasePromptObservation(p.runtime, receipt.observationId);
  expect(disconnected).toBe(1);
  await expect(evaluateBoundAnswer(p.runtime, selection)).rejects.toThrow(
    /observation lost or invalidated/,
  );
});
