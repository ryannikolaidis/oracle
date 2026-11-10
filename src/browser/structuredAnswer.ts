import { buildAnswerRelationshipExpression, evaluateBoundAnswer, requireAnswerBinding } from "./answerBinding.js";
import { ASSISTANT_ROLE_SELECTOR } from "./constants.js";
import type { ChromeClient } from "./types.js";

/** Runs in the page. Unknown layouts fail closed instead of guessing which text is data. */
export function extractJsonCodeBody(root: Element): string {
  const reject = (): never => { throw new Error("Structured answer requires exactly one JSON code payload without mixed content or controls in the code body"); };
  const blocks = Array.from(root.querySelectorAll("pre"));
  const codes = Array.from(root.querySelectorAll("code"));
  if (blocks.length !== 1 || codes.length !== 1) return reject();
  const pre = blocks[0]!;
  const code = codes[0]!;
  const languages = (code.getAttribute("class") ?? "").split(/\s+/).filter(token => token.startsWith("language-"));
  const dataLanguage = code.getAttribute("data-language");
  if (!pre.contains(code) ||
      !(languages.includes("language-json") || dataLanguage === "json") ||
      languages.some(language => language !== "language-json") ||
      (dataLanguage !== null && dataLanguage !== "json") ||
      [code, ...Array.from(code.querySelectorAll("*"))].some(node =>
        (node !== code && node.tagName !== "SPAN") ||
        node.hasAttribute("role") || node.hasAttribute("tabindex") || node.hasAttribute("contenteditable"))) return reject();

  // Only whitespace, structural wrappers and known code-block chrome may surround the body.
  // A label is accepted only inside this pre; prose that happens to say "json" is not a label.
  let labels = 0;
  let buttons = 0;
  const isHeader = (node: Node): boolean => {
    let branch = node;
    while (branch.parentNode && branch.parentNode !== pre) branch = branch.parentNode;
    let body: Node = code;
    while (body.parentNode && body.parentNode !== pre) body = body.parentNode;
    const children = Array.from(pre.childNodes);
    return branch !== body && children.indexOf(branch as ChildNode) >= 0 &&
      children.indexOf(branch as ChildNode) < children.indexOf(body as ChildNode);
  };
  const inspect = (node: Node): void => {
    if (node === code) return;
    if (node.nodeType === 3) {
      if (node.textContent?.trim() &&
          !(isHeader(node) && node.textContent.trim().toLowerCase() === "json" && ++labels === 1)) reject();
      return;
    }
    if (node.nodeType !== 1) return reject();
    const element = node as Element;
    if (element.tagName === "BUTTON") {
      if (!isHeader(element) || ++buttons !== 1 || !/^(copy|copy code|copied|copied!)$/i.test(element.textContent?.trim() ?? "")) reject();
      return;
    }
    if (!["DIV", "SPAN", "PRE"].includes(element.tagName)) reject();
    for (const child of Array.from(element.childNodes)) inspect(child);
  };
  inspect(root);
  const text = code.textContent;
  if (typeof text !== "string" || !text.trim()) return reject();
  try { JSON.parse(text); } catch { return reject(); }
  return text; // Never trim, normalize, deserialize/reserialize, or read the clipboard.
}

export function buildStructuredAnswerExpression(): string {
  return `(() => {
    const relationship = ${buildAnswerRelationshipExpression()};
    if (relationship.assistantIds.length !== 1) throw new Error('Structured answer has no sole assistant');
    const messageId = relationship.assistantIds[0];
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_ROLE_SELECTOR)}));
    const matches = nodes.filter(node => {
      const id = node.getAttribute('data-message-id') || node.getAttribute('data-chatgpt-selection-message-id') || node.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || node.getAttribute('data-content-search-unit-key') || node.getAttribute('data-chatgpt-search-unit-key');
      return id === messageId;
    });
    if (matches.length !== 1) throw new Error('Structured answer has no unique assistant root');
    const root = matches[0];
    try {
      const text = (${extractJsonCodeBody.toString()})(root);
      return { text, html: root.innerHTML, messageId };
    } catch (error) {
      return { text: '', messageId, structuredError: String(error?.message || error) };
    }
  })()`;
}

export async function readStructuredAnswer(runtime: ChromeClient["Runtime"]) {
  requireAnswerBinding(runtime);
  const response = await evaluateBoundAnswer(runtime, {
    expression: buildStructuredAnswerExpression(), returnByValue: true,
  });
  const snapshot = response.result?.value as { text?: string; html?: string; messageId?: string; structuredError?: string } | undefined;
  if (snapshot?.structuredError) throw new Error(snapshot.structuredError);
  if (response.exceptionDetails || typeof snapshot?.text !== "string" || !snapshot.messageId) {
    throw new Error("No valid bound JSON code payload");
  }
  return snapshot;
}
