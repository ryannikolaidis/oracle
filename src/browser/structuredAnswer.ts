import {
  buildAnswerRelationshipExpression,
  evaluateBoundAnswer,
  requireAnswerBinding,
} from "./answerBinding.js";
import { ASSISTANT_ROLE_SELECTOR } from "./constants.js";
import type { ChromeClient } from "./types.js";

/** Runs in the page. Unknown layouts fail closed instead of guessing which text is data. */
export function extractJsonCodeBody(root: Element, messageId?: string): string {
  const reject = (): never => {
    throw new Error(
      "Structured answer requires exactly one JSON code payload without mixed content or controls in the code body",
    );
  };
  // Select one answer surface, then account for every node outside it as well.
  // Never discard arbitrary siblings merely because a code body was found.
  const contentSelector = '[data-markdown-text-style="assistant-message"], .markdown';
  const candidates = [root, ...Array.from(root.querySelectorAll(contentSelector))].filter((node) =>
    node.matches(contentSelector),
  );
  if (candidates.length > 1) return reject();
  const content = candidates[0] ?? root;
  let headings = 0;
  const inspectEnvelope = (node: Node): void => {
    if (node.nodeType === 3) {
      if (node.textContent?.trim()) reject();
      return;
    }
    if (node.nodeType !== 1) return reject();
    const element = node as Element;
    for (const attribute of [
      "data-message-id",
      "data-chatgpt-selection-message-id",
      "data-chatgpt-search-message-ids",
    ]) {
      const value = element.getAttribute(attribute);
      if (messageId && value !== null && value.split(/\s+/).some((id) => id !== messageId))
        reject();
    }
    for (const attribute of ["data-message-author-role", "data-turn", "data-conversation-role"]) {
      const value = element.getAttribute(attribute);
      if (value !== null && value !== "assistant") reject();
    }
    if (element === content) return;
    // Recorded screen-reader identity heading, never a heading inside answer content.
    if (
      element.tagName === "H4" &&
      element.classList.contains("sr-only") &&
      element.getAttribute("data-conversation-role") === "assistant" &&
      element.getAttribute("tabindex") === "-1" &&
      !element.hasAttribute("role") &&
      !element.hasAttribute("contenteditable") &&
      element.children.length === 0 &&
      element.textContent?.trim() === "ChatGPT said:" &&
      ++headings === 1
    )
      return;
    if (
      !(element === root && element.tagName === "ARTICLE") &&
      !["DIV", "SPAN"].includes(element.tagName)
    )
      reject();
    if (
      element.hasAttribute("role") ||
      element.hasAttribute("tabindex") ||
      element.hasAttribute("contenteditable")
    )
      reject();
    for (const child of Array.from(element.childNodes)) inspectEnvelope(child);
  };
  inspectEnvelope(root);
  const blocks = Array.from(content.querySelectorAll("pre"));
  const codes = Array.from(content.querySelectorAll("code"));
  if (blocks.length !== 1 || codes.length !== 1) return reject();
  const pre = blocks[0]!;
  const code = codes[0]!;
  const languages = (code.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((token) => token.startsWith("language-"));
  const dataLanguage = code.getAttribute("data-language");
  if (
    !pre.contains(code) ||
    !(languages.includes("language-json") || dataLanguage === "json") ||
    languages.some((language) => language !== "language-json") ||
    (dataLanguage !== null && dataLanguage !== "json") ||
    [code, ...Array.from(code.querySelectorAll("*"))].some(
      (node) =>
        (node !== code && node.tagName !== "SPAN") ||
        node.hasAttribute("role") ||
        node.hasAttribute("tabindex") ||
        node.hasAttribute("contenteditable"),
    )
  )
    return reject();

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
    return (
      branch !== body &&
      children.indexOf(branch as ChildNode) >= 0 &&
      children.indexOf(branch as ChildNode) < children.indexOf(body as ChildNode)
    );
  };
  const inspect = (node: Node): void => {
    if (node === code) return;
    if (node.nodeType === 3) {
      if (
        node.textContent?.trim() &&
        !(isHeader(node) && node.textContent.trim().toLowerCase() === "json" && ++labels === 1)
      )
        reject();
      return;
    }
    if (node.nodeType !== 1) return reject();
    const element = node as Element;
    if (element.tagName === "BUTTON") {
      if (
        !isHeader(element) ||
        ++buttons !== 1 ||
        !/^(copy|copy code|copied|copied!)$/i.test(element.textContent?.trim() ?? "")
      )
        reject();
      return;
    }
    if (!["DIV", "SPAN", "PRE"].includes(element.tagName)) reject();
    for (const child of Array.from(element.childNodes)) inspect(child);
  };
  // ARTICLE is an identity envelope, not a code-body wrapper.
  if (content === root && root.tagName === "ARTICLE") {
    for (const child of Array.from(root.childNodes)) inspect(child);
  } else inspect(content);
  const text = code.textContent;
  if (typeof text !== "string" || !text.trim()) return reject();
  try {
    JSON.parse(text);
  } catch {
    return reject();
  }
  return text; // Never trim, normalize, deserialize/reserialize, or read the clipboard.
}

export function buildStructuredAnswerExpression(): string {
  return `(() => {
    const relationship = ${buildAnswerRelationshipExpression()};
    if (relationship.assistantIds.length !== 1) throw new Error('Structured answer has no sole assistant');
    const messageId = relationship.assistantIds[0];
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_ROLE_SELECTOR)}));
    const matches = nodes.filter(node => {
      const id = node.getAttribute('data-message-id') || node.getAttribute('data-chatgpt-selection-message-id') || node.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || node.getAttribute('data-content-search-unit-key') || node.getAttribute('data-chatgpt-search-unit-key') || node.closest('[data-turn-key]')?.getAttribute('data-turn-key');
      return id === messageId;
    });
    if (matches.length !== 1) throw new Error('Structured answer has no unique assistant root');
    const root = matches[0];
    try {
      const text = (${extractJsonCodeBody.toString()})(root, messageId);
      return { text, html: root.innerHTML, messageId };
    } catch (error) {
      return { text: '', messageId, structuredError: String(error?.message || error) };
    }
  })()`;
}

export async function readStructuredAnswer(runtime: ChromeClient["Runtime"]) {
  requireAnswerBinding(runtime);
  const response = await evaluateBoundAnswer(runtime, {
    expression: buildStructuredAnswerExpression(),
    returnByValue: true,
  });
  const snapshot = response.result?.value as
    | { text?: string; html?: string; messageId?: string; structuredError?: string }
    | undefined;
  if (snapshot?.structuredError) throw new Error(snapshot.structuredError);
  if (response.exceptionDetails || typeof snapshot?.text !== "string" || !snapshot.messageId) {
    throw new Error("No valid bound JSON code payload");
  }
  return snapshot;
}
