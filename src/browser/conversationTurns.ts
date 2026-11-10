import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "./constants.js";

/** An exchange can contain progress messages before its final assistant message. */
export function buildLastAssistantMessageExpression(turnExpression = "turn"): string {
  return `(() => {
    const root = ${turnExpression};
    if (!root) return null;
    const selector = ${JSON.stringify(ASSISTANT_ROLE_SELECTOR)};
    const messages = Array.from(root.querySelectorAll(selector)).filter(node => {
      const owner = node.parentElement?.closest(selector);
      return !owner || owner === root;
    });
    return messages.at(-1) ?? root.querySelector(selector) ?? (root.matches?.(selector) ? root : null);
  })()`;
}

/** Build a browser-context expression that returns one DOM node per conversation turn. */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const root = ${rootExpression};
    const containers = Array.from(root.querySelectorAll(${containerSelector})).filter(
      node => !node.parentElement?.closest(${containerSelector}),
    );
    return containers.length > 0
      ? containers
      : Array.from(root.querySelectorAll(${fallbackSelector}));
  })()`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}

/** Use the same user identity for submission, selection and recovery. */
export function buildUserMessageIdExpression(node = "user"): string {
  return `(${node}?.getAttribute('data-message-id') || ${node}?.getAttribute('data-chatgpt-selection-message-id') || ${node}?.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || ${node}?.closest('[data-turn-key]')?.getAttribute('data-turn-key') || ${node}?.getAttribute('data-content-search-unit-key') || ${node}?.getAttribute('data-chatgpt-search-unit-key'))`;
}

/** Preserve assistant identity precedence across capture, binding and recovery. */
export function buildAssistantMessageIdExpression(node = "node"): string {
  return `(${node}?.getAttribute('data-message-id') || ${node}?.getAttribute('data-chatgpt-selection-message-id') || ${node}?.getAttribute('data-chatgpt-search-message-ids')?.split(' ')[0] || ${node}?.getAttribute('data-content-search-unit-key') || ${node}?.getAttribute('data-chatgpt-search-unit-key') || ${node}?.closest('[data-turn-key]')?.getAttribute('data-turn-key'))`;
}
