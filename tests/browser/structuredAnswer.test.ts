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
