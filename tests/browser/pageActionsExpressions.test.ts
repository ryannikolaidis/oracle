import { describe, expect, test } from "vitest";
import { FakeDocument, FakeElement } from "./domFixture.js";
import {
  buildAssistantExtractorForTest,
  buildAssistantSnapshotExpressionForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
  buildUserTurnAttachmentExpressionForTest,
  isRetryAssistantUiErrorText,
} from "../../src/browser/pageActions.ts";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../../src/browser/constants.ts";

describe("browser automation expressions", () => {
  test("classifies only a failed assistant turn with a visible Retry control", () => {
    expect(isRetryAssistantUiErrorText("Something went wrong.", true)).toBe(true);
    expect(isRetryAssistantUiErrorText("Something went wrong.", false)).toBe(false);
    expect(isRetryAssistantUiErrorText("Retry the calculation with another input.", true)).toBe(
      false,
    );
  });

  test("assistant extractor references constants", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(JSON.stringify(ASSISTANT_ROLE_SELECTOR));
  });

  test("assistant extractor treats image-only ChatGPT turns as responses", () => {
    const expression = buildAssistantExtractorForTest("capture");
    expect(expression).toContain("/backend-api/estuary/content?id=file_");
    expect(expression).toContain("Generated image.");
    expect(expression).toContain("stopped thinking edit");
    expect(expression).toContain("thought for");
  });

  test("assistant extractor indexes top-level turns instead of nested role nodes", () => {
    const nestedUser = new FakeElement(
      "div",
      { "data-message-author-role": "user" },
      [],
      "old prompt",
    );
    const nestedAssistant = new FakeElement(
      "div",
      { "data-message-author-role": "assistant" },
      [],
      "old answer",
    );
    const userTurn = new FakeElement("article", { "data-testid": "conversation-turn-1" }, [
      nestedUser,
    ]);
    const assistantTurn = new FakeElement(
      "article",
      { "data-testid": "conversation-turn-2", "data-turn-key": "assistant-exchange" },
      [nestedAssistant],
    );
    const document = new FakeDocument([userTurn, assistantTurn]);
    expect(document.querySelectorAll(CONVERSATION_TURN_CONTAINER_SELECTOR)).toEqual([
      userTurn,
      assistantTurn,
    ]);
    expect(document.querySelectorAll(CONVERSATION_TURN_SELECTOR)).toEqual([
      userTurn,
      nestedUser,
      assistantTurn,
      nestedAssistant,
    ]);
    const expression = buildAssistantExtractorForTest("capture");
    const result = Function(
      "document",
      "HTMLElement",
      `${expression}; return capture();`,
    )(document, FakeElement);

    expect(result).toMatchObject({
      text: "old answer",
      turnIndex: 1,
      messageId: "assistant-exchange",
      turnId: "assistant-exchange",
    });
  });

  test("conversation debug expression references conversation selector", () => {
    const expression = buildConversationDebugExpressionForTest();
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
  });

  test("assistant snapshot expression guards against conversation drift", () => {
    const expression = buildAssistantSnapshotExpressionForTest(4, "conv-123");
    expect(expression).toContain('const EXPECTED_CONVERSATION_ID = "conv-123"');
    expect(expression).toContain("currentConversationId !== EXPECTED_CONVERSATION_ID");
    expect(expression).toContain("return null;");
  });

  test("markdown fallback filters user turns and respects assistant indicators", () => {
    const expression = buildMarkdownFallbackExtractorForTest("2");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
    expect(expression).toContain("role !== 'user'");
    expect(expression).toContain("copy-turn-action-button");
    expect(expression).toContain(CONVERSATION_TURN_SELECTOR);
    expect(expression).toContain("turn.contains?.(node)");
  });

  test("markdown fallback does not self-reference MIN_TURN_INDEX literal", () => {
    const expression = buildMarkdownFallbackExtractorForTest("MIN_TURN_INDEX");
    expect(expression).toContain("MIN_TURN_INDEX");
    expect(expression).not.toContain("const MIN_TURN_INDEX = (MIN_TURN_INDEX");
    expect(expression).toContain("const __minTurn");
  });

  test("copy expression scopes to assistant turn buttons", () => {
    const expression = buildCopyExpressionForTest({});
    expect(expression).toContain(JSON.stringify(CONVERSATION_TURN_SELECTOR));
    expect(expression).toContain(ASSISTANT_ROLE_SELECTOR);
    expect(expression).toContain("isAssistantTurn");
    expect(expression).toContain("copy-turn-action-button");
  });

  test("user-turn attachment expression requires non-empty prompt text for prefix fallback", () => {
    const expression = buildUserTurnAttachmentExpressionForTest({
      expectedPromptPrefix: "expected prompt text",
    });
    expect(expression).toContain("const textPrefix = text.slice");
    expect(expression).toContain("text.length > 0");
    expect(expression).toContain("textPrefix.length > 0");
  });
});
