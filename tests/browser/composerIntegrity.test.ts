import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { submitPrompt } from "../../src/browser/actions/promptComposer.js";
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from "../../src/browser/constants.js";

// A controlled renderer, not ChatGPT: execute generated focus, paste, integrity and
// send expressions. Model insertion of HTML hard breaks at the current paragraph.
function renderer(
  options: {
    textarea?: boolean;
    missingButton?: boolean;
    failCommit?: boolean;
    partial?: boolean;
  } = {},
) {
  let document: Record<string, unknown>;
  let editors: Element[] = [];
  const chips: Element[] = [];
  const chunks: { plain: string; html: string }[] = [];
  const sends: string[] = [];
  const textNode = (text: string) => ({ nodeType: 3, nodeName: "#text", nodeValue: text });
  class Event {
    type: string;
    clipboardData?: DataTransfer;
    constructor(type: string, init: { clipboardData?: DataTransfer } = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  class EventTarget {
    dispatchEvent(_event: Event) {
      return true;
    }
  }
  class Element extends EventTarget {
    nodeType = 1;
    nodeName = "DIV";
    childNodes: unknown[] = [];
    style: Record<string, string> = {};
    classList = { contains: () => false };
    isConnected = true;
    isContentEditable = true;
    parentElement: Element | null = null;
    value = "";
    attributes: Record<string, string> = {};
    get ownerDocument() {
      return document;
    }
    get innerText() {
      return this.value;
    }
    get textContent(): string {
      return this.value;
    }
    set textContent(value: string) {
      this.value = value;
      this.childNodes = [textNode(value)];
    }
    get outerHTML() {
      return `<p>${this.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
    }
    getBoundingClientRect() {
      return { width: 100, height: 30, left: 0, top: 0 };
    }
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }
    hasAttribute(name: string) {
      return name in this.attributes;
    }
    closest(selector: string): Element | null {
      if (selector === "form,[data-chatgpt-composer]") return root;
      return this === root || chips.includes(this) ? null : this;
    }
    querySelectorAll() {
      return chips;
    }
    contains(node: Element) {
      return node === this;
    }
    focus() {
      document.activeElement = this;
    }
    click() {
      sends.push("dom-click");
    }
    override dispatchEvent(event: Event) {
      if (event.type === "click" && this === button) sends.push("dom-click");
      if (event.type === "paste") {
        const plain = event.clipboardData!.getData("text/plain");
        const html = event.clipboardData!.getData("text/html");
        chunks.push({ plain, html });
        // Decode the generated paragraph, retaining each BR as a real DOM node.
        const body = html.replace(/^<p>/, "").replace(/<\/p>$/, "");
        const decode = (value: string) =>
          value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        body.split("<br>").forEach((part, index) => {
          if (index)
            this.childNodes.push({ nodeType: 1, nodeName: "BR", classList: this.classList });
          this.childNodes.push(textNode(decode(part)));
        });
        this.value += plain;
      }
      return true;
    }
  }
  class Textarea extends Element {
    override isContentEditable = false;
  }
  class DataTransfer {
    data = new Map<string, string>();
    setData(type: string, value: string) {
      this.data.set(type, value);
    }
    getData(type: string) {
      return this.data.get(type) ?? "";
    }
  }
  const root = new Element();
  const editor = options.textarea ? new Textarea() : new Element();
  editor.parentElement = root;
  editors = [editor];
  const button = new Element();
  document = {
    activeElement: editor,
    querySelectorAll: (selector: string) => {
      if ((INPUT_SELECTORS as readonly string[]).includes(selector)) return editors;
      if ((SEND_BUTTON_SELECTORS as readonly string[]).includes(selector))
        return options.missingButton ? [] : [button];
      if (selector.includes("Remove Pasted text")) return chips;
      return [];
    },
    querySelector: (selector: string) =>
      (document.querySelectorAll as (selector: string) => Element[])(selector)[0] ?? null,
    createElement: () => new Element(),
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    elementFromPoint: () => button,
  };
  const context = createContext({
    document,
    location: { href: "https://chatgpt.com/c/synthetic" },
    window: {
      innerWidth: 1000,
      innerHeight: 1000,
      getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
    },
    HTMLElement: Element,
    HTMLTextAreaElement: Textarea,
    EventTarget,
    Event,
    MouseEvent: Event,
    ClipboardEvent: Event,
    DataTransfer,
  });
  const runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("document.readyState"))
        return { result: { value: { ready: true, composer: true } } };
      if (expression.includes("turnsCount"))
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: options.failCommit ? 0 : 1,
              userMatched: !options.failCommit,
              hasNewTurn: !options.failCommit,
            },
          },
        };
      // These UI facilities are outside the synthetic composer contract.
      if (
        expression.includes("oracleCompletionAnnouncement") ||
        expression.includes("chat-list") ||
        expression.includes("rateLimit")
      )
        return { result: { value: false } };
      // Execute every composer integrity, focus, paste and send expression verbatim.
      if (
        expression.includes("__oracleComposerIntegrity_") ||
        expression.includes("ClipboardEvent('paste'") ||
        expression.includes("focused: true") ||
        expression.includes("button.scrollIntoView") ||
        expression.includes("elementFromPoint") ||
        expression.includes("editorText")
      ) {
        return { result: { value: runInContext(expression, context) } };
      }
      return { result: { value: false } };
    }),
  };
  const input = {
    insertText: vi.fn(async ({ text }: { text: string }) => {
      editor.textContent = options.partial ? text.slice(0, 3) : text;
    }),
    dispatchKeyEvent: vi.fn(async () => {
      sends.push("Enter");
    }),
    dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
      if (type !== "mouseMoved") sends.push(type);
    }),
  };
  const logger = Object.assign(vi.fn(), { verbose: false });
  return {
    runtime,
    input,
    editor,
    chunks,
    sends,
    context,
    replace(text: string) {
      editor.textContent = text;
    },
    replaceEditor() {
      editor.isConnected = false;
      const replacement = new Element();
      replacement.textContent = editor.value;
      replacement.parentElement = root;
      editors = [replacement];
    },
    addEditor() {
      editors.push(new Element());
    },
    convertToChip() {
      const chip = new Element();
      chip.attributes["aria-label"] = "Remove Pasted text";
      chips.push(chip);
    },
    submit(prompt: string, strictCapture = true) {
      return submitPrompt(
        { runtime: runtime as never, input: input as never, strictCapture, baselineTurns: 0 },
        prompt,
        logger,
      );
    },
  };
}

function syntheticPrompt(size: number) {
  // Force both boundary protections, and include literal HTML, whitespace and blank lines.
  const prefix = "a".repeat(3999) + "😀" + "b".repeat(3997) + "\r\n";
  const body = "marker<&>\r\n\rline\n\n😀tail ";
  return (
    prefix +
    body.repeat(Math.ceil((size - prefix.length) / body.length)).slice(0, size - prefix.length) +
    "\nEND"
  );
}

describe("strict generated composer path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function rejectWithoutSend(page: ReturnType<typeof renderer>, prompt: string) {
    const outcome = page.submit(prompt);
    const assertion = expect(outcome).rejects.toMatchObject({
      details: { code: "prompt-composer-integrity" },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(page.sends).toEqual([]);
    expect(page.input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(
      page.input.dispatchMouseEvent.mock.calls.some(([event]) => event.type === "mousePressed"),
    ).toBe(false);
    expect(
      Object.keys(page.context).some((key) => key.startsWith("__oracleComposerIntegrity_")),
    ).toBe(false);
  }

  test.each([27_244, 37_746])(
    "rejects delayed nonempty 10K replacement after exact %i paste",
    async (size) => {
      const page = renderer();
      const prompt = syntheticPrompt(size);
      setTimeout(() => page.replace(prompt.slice(0, 10_000)), 450);
      await rejectWithoutSend(page, prompt);
      expect(page.chunks.map((chunk) => chunk.plain).join("")).toBe(prompt.replace(/\r\n?/g, "\n"));
      expect(page.chunks.length).toBeGreaterThan(6);
    },
  );

  test.each([27_244, 37_746])(
    "accepts complete %i paste across CRLF and surrogate chunk boundaries",
    async (size) => {
      const page = renderer();
      const prompt = syntheticPrompt(size);
      const outcome = page.submit(prompt);
      await vi.runAllTimersAsync();
      await expect(outcome).resolves.toBe(1);
      expect(page.chunks[0].plain).toHaveLength(3999);
      expect(page.chunks[1].plain).toHaveLength(3999);
      expect(page.chunks[1].plain.endsWith("\r")).toBe(false);
      expect(page.chunks.map((chunk) => chunk.plain).join("")).toBe(prompt.replace(/\r\n?/g, "\n"));
      for (const { plain, html } of page.chunks) {
        expect(plain).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
        expect(html).toMatch(/^<p>/);
      }
      expect(page.sends).toEqual(["mousePressed", "mouseReleased"]);
      expect(page.input.insertText).not.toHaveBeenCalled();
      expect(page.input.dispatchKeyEvent).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])("rejects partial typed insertion, textarea=%s", async (textarea) => {
    await rejectWithoutSend(
      renderer({ textarea, partial: true }),
      textarea ? "one\ntwo" : "single line content",
    );
  });

  test.each(["replacement", "multiple", "chip"] as const)(
    "rejects delayed %s with no dispatch",
    async (mutation) => {
      const page = renderer();
      setTimeout(() => {
        if (mutation === "replacement") page.replaceEditor();
        if (mutation === "multiple") page.addEditor();
        if (mutation === "chip") page.convertToChip();
      }, 450);
      await rejectWithoutSend(page, syntheticPrompt(27_244));
    },
  );

  test("preserves ordinary dom-text partial-composer behavior", async () => {
    const page = renderer({ partial: true });
    const outcome = page.submit("single line content", false);
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toBe(1);
    expect(page.sends).toEqual(["mousePressed", "mouseReleased"]);
  });

  test.each([false, true])("accepts complete typed insertion, textarea=%s", async (textarea) => {
    const page = renderer({ textarea });
    const outcome = page.submit(textarea ? "one\r\ntwo" : "single line content");
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toBe(1);
    expect(page.sends).toEqual(["mousePressed", "mouseReleased"]);
    expect(page.input.insertText).toHaveBeenCalledTimes(1);
  });

  test("rejects multiple editors before insertion", async () => {
    const page = renderer();
    page.addEditor();
    await rejectWithoutSend(page, syntheticPrompt(27_244));
    expect(page.chunks).toEqual([]);
    expect(page.input.insertText).not.toHaveBeenCalled();
  });

  test.each(["partial", "replacement", "multiple", "chip"] as const)(
    "checks %s again after send-button settling",
    async (mutation) => {
      const page = renderer();
      setTimeout(() => {
        if (mutation === "partial") page.replace("partial but nonempty");
        if (mutation === "replacement") page.replaceEditor();
        if (mutation === "multiple") page.addEditor();
        if (mutation === "chip") page.convertToChip();
      }, 600);
      await rejectWithoutSend(page, syntheticPrompt(37_746));
    },
  );

  test("does not retry or send Enter after dispatch when commit is unconfirmed", async () => {
    const page = renderer({ failCommit: true });
    const assertion = expect(page.submit(syntheticPrompt(27_244))).rejects.toMatchObject({
      details: { code: "prompt-commit-timeout" },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(page.sends).toEqual(["mousePressed", "mouseReleased"]);
    expect(page.input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(page.chunks.length).toBe(7);
  });

  test("checks after mouse movement immediately before pressing send", async () => {
    const page = renderer();
    page.input.dispatchMouseEvent.mockImplementation(async ({ type }) => {
      if (type === "mouseMoved") page.replace("partial");
      else page.sends.push(type);
    });
    await rejectWithoutSend(page, syntheticPrompt(27_244));
  });

  test("checks immediately before Enter fallback", async () => {
    const page = renderer({ missingButton: true });
    const evaluate = page.runtime.evaluate.getMockImplementation()!;
    page.runtime.evaluate.mockImplementation(async (args) => {
      const result = await evaluate(args);
      if (args.expression.includes("button.scrollIntoView")) page.replace("partial");
      return result;
    });
    await rejectWithoutSend(page, syntheticPrompt(27_244));
  });
});
