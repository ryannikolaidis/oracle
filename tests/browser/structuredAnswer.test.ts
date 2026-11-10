import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { extractJsonCodeBody } from "../../src/browser/structuredAnswer.js";
import { FakeElement } from "./domFixture.js";

const literal = '  {"review":"FINDINGS: 0\\n\\nHé😀 [source](https://example.com/a?q=1&b=2) `inline`\\n```ts\\nconst x = \\\"quoted\\\";\\n```","ok":true}\n';
const code = (text = literal, language = "language-json", children: FakeElement[] = []) =>
  new FakeElement("code", { class: language }, children, text);
const block = (body = code()) => new FakeElement("pre", {}, [
  new FakeElement("div", {}, [new FakeElement("span", {}, [], "json"), new FakeElement("button", {}, [], "Copy code")]),
  new FakeElement("div", {}, [body]),
]);
const root = (...nodes: FakeElement[]) => new FakeElement("div", {}, nodes);
const extract = (node: FakeElement) => extractJsonCodeBody(node as unknown as Element);

test("returns exact JSON code text without header/buttons, preserving Markdown, escapes and Unicode", () => {
  const answer = extract(root(block()));
  expect(answer).toBe(literal);
  expect(JSON.parse(answer).review).toContain("[source](https://example.com/a?q=1&b=2) `inline`");
  expect(JSON.parse(answer).review).toContain('```ts\nconst x = "quoted";\n```');
});

test("supports syntax-highlight spans and data-language JSON without reserializing", () => {
  const body = new FakeElement("code", { "data-language": "json" }, [new FakeElement("span", {}, [], literal)]);
  expect(extract(root(new FakeElement("pre", {}, [body])))).toBe(literal);
});

test("never reads rendered innerText from the code body or surrounding UI", () => {
  const body = code();
  const message = root(block(body));
  for (const node of [message, body]) {
    Object.defineProperty(node, "innerText", { get: () => { throw new Error("rendered text is not payload"); } });
  }
  expect(extract(message)).toBe(literal);
});

test.each([
  ["raw rendered JSON", () => new FakeElement("div", {}, [], literal)],
  ["unlabelled code", () => root(block(code(literal, "")))],
  ["different language", () => root(block(code(literal, "language-js")))],
  ["conflicting language classes", () => root(block(code(literal, "language-json language-python")))],
  ["conflicting data language", () => root(block(new FakeElement("code", { class: "language-json", "data-language": "python" }, [], literal)))],
  ["invalid JSON", () => root(block(code('{"review":')))],
  ["empty payload", () => root(block(code("  \n")))],
  ["two JSON payloads", () => root(block(), block())],
  ["JSON and another code block", () => root(block(), block(code("echo hi", "language-sh")))],
  ["introductory prose", () => root(new FakeElement("div", {}, [], "Here is the JSON:"), block())],
  ["trailing prose", () => root(block(), new FakeElement("div", {}, [], "Done"))],
  ["rendered link", () => root(block(), new FakeElement("a", { href: "https://example.com" }, [], "source"))],
  ["image mixed with JSON", () => root(block(), new FakeElement("img"))],
  ["inline code mixed with JSON", () => root(block(), code("extra", ""))],
  ["control in code", () => root(block(code(literal, "language-json", [new FakeElement("button", {}, [], "Copy code")])) )],
  ["span acting as a control in valid JSON", () => root(block(code("", "language-json", [new FakeElement("span", { role: "button" }, [], literal)])))],
  ["rendered anchor in code", () => root(block(code(literal, "language-json", [new FakeElement("a", {}, [], "source")])) )],
  ["unknown header text", () => root(new FakeElement("pre", {}, [new FakeElement("div", {}, [], "Output"), code()]))],
  ["label after payload", () => root(new FakeElement("pre", {}, [code(), new FakeElement("span", {}, [], "json")]))],
  ["duplicate language labels", () => root(new FakeElement("pre", {}, [new FakeElement("div", {}, [new FakeElement("span", {}, [], "json"), new FakeElement("span", {}, [], "json")]), code()]))],
])("rejects %s without attempting to clean or repair the answer", (_label, make) => {
  expect(() => extract((make as () => FakeElement)())).toThrow(/Structured answer/);
});

// Preserve the recorded identity/accessibility envelope, replacing only its answer.
function recordedAnswer(tag = "div") {
  const html = readFileSync(new URL("../fixtures/chatgpt-dom-2026-09/completed.html", import.meta.url), "utf8");
  const start = html.indexOf('<div data-content-search-unit-key="fallback-turn-0:2:assistant"');
  const end = html.indexOf('<div class="mt-1.5 flex turn-action-controls', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const tokens = html.slice(start, end).match(/<[^>]+>|[^<]+/g)!;
  let cursor = 0;
  const parse = (): FakeElement => {
    const opening = tokens[cursor++]!;
    const name = opening.match(/^<([a-z0-9]+)/i)![1]!;
    const attributes = Object.fromEntries(Array.from(opening.matchAll(/([\w-]+)="([^"]*)"/g), match => [match[1]!, match[2]!]));
    const children: FakeElement[] = [];
    let text = "";
    while (cursor < tokens.length && !tokens[cursor]!.startsWith("</")) {
      if (tokens[cursor]!.startsWith("<")) children.push(parse());
      else text += tokens[cursor++];
    }
    cursor++;
    return new FakeElement(name, attributes, children, text);
  };
  const envelope = parse();
  const content = envelope.querySelector('[data-markdown-text-style="assistant-message"]')!;
  expect(envelope.querySelector("h4")?.textContent).toBe("ChatGPT said:");
  expect(content.textContent).toBe("OK");
  for (const child of [...content.children]) child.remove();
  content.append(block());
  if (tag === "article") return new FakeElement(tag, {
    "data-message-author-role": "assistant", "data-message-id": "22222222-2222-4222-8222-222222222222",
  }, [...envelope.children]);
  return envelope;
}

test.each(["div", "article"])("accepts exact JSON inside the recorded %s identity envelope", tag => {
  expect(extractJsonCodeBody(recordedAnswer(tag) as unknown as Element,
    "22222222-2222-4222-8222-222222222222")).toBe(literal);
});

test.each([
  ["prose outside content", (message: FakeElement) => message.append(new FakeElement("div", {}, [], "extra"))],
  ["second answer surface", (message: FakeElement) => message.append(new FakeElement("div", { class: "markdown" }, [block()]))],
  ["nested answer surface", (message: FakeElement) => message.querySelector('[data-markdown-text-style="assistant-message"]')!.append(new FakeElement("div", { class: "markdown" }, []))],
  ["code outside content", (message: FakeElement) => message.append(block())],
  ["visible identity heading", (message: FakeElement) => message.querySelector("h4")!.setAttribute("class", "")],
  ["interactive identity heading", (message: FakeElement) => message.querySelector("h4")!.setAttribute("tabindex", "0")],
  ["heading control role", (message: FakeElement) => message.querySelector("h4")!.setAttribute("role", "button")],
  ["wrong heading role", (message: FakeElement) => message.querySelector("h4")!.setAttribute("data-conversation-role", "user")],
  ["conflicting nested identity", (message: FakeElement) => message.querySelector('[data-chatgpt-selection-message-id]')!.setAttribute("data-chatgpt-selection-message-id", "other")],
  ["second payload inside content", (message: FakeElement) => message.querySelector('[data-markdown-text-style="assistant-message"]')!.append(block())],
  ["prose inside content", (message: FakeElement) => message.querySelector('[data-markdown-text-style="assistant-message"]')!.append(new FakeElement("p", {}, [], "extra"))],
])("rejects recorded wrapper with %s", (_label, mutate) => {
  const message = recordedAnswer();
  (mutate as (message: FakeElement) => void)(message);
  expect(() => extractJsonCodeBody(message as unknown as Element,
    "22222222-2222-4222-8222-222222222222")).toThrow(/Structured answer/);
});
