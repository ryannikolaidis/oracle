import type { ChromeClient } from "./types.js";

/** Install at the exact read that attests the user bubble, before yielding to the page. */
export function buildPromptObservationExpression(user = "user"): string {
  return `((user) => {
    const bubble = user.querySelector('[data-user-message-bubble="true"]') || user;
    const conversationId = location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1];
    if (!conversationId || typeof MutationObserver !== 'function') return undefined;
    const key = crypto.randomUUID();
    const registry = globalThis.__oraclePromptObservations ??= new Map();
    const observation = { invalidated: false, conversationId };
    const selector = ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])';
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const identityAttributes = ['data-message-id', 'data-chatgpt-selection-message-id', 'data-chatgpt-search-message-ids', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key', 'data-turn-key', 'data-message-author-role'];
        const roleAttribute = record.attributeName === 'data-message-author-role';
        const searchAttribute = ['data-content-search-unit-key', 'data-chatgpt-search-unit-key'].includes(record.attributeName);
        const wasUser = (roleAttribute && record.oldValue === 'user') ||
          (searchAttribute && typeof record.oldValue === 'string' && record.oldValue.endsWith(':user'));
        const foreignUserTransition = record.type === 'attributes' && record.target !== user &&
          (roleAttribute || searchAttribute) && (wasUser || record.target.matches?.(selector));
        if (foreignUserTransition || (record.type !== 'attributes' && (record.target === bubble || bubble.contains(record.target))) ||
            (record.type === 'attributes' && identityAttributes.includes(record.attributeName) && (record.target === user || record.target === user.closest('[data-turn-key]'))) ||
            Array.from(record.removedNodes).some(node => node === user || node.contains?.(user) || node === bubble || node.contains?.(bubble)) ||
            Array.from(record.addedNodes).some(node => node !== user && (node.matches?.(selector) || node.querySelector?.(selector)))) {
          observation.invalidated = true;
          observer.disconnect();
        }
      }
      if (!user.isConnected || location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] !== conversationId) observation.invalidated = true;
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
    observation.disconnect = () => observer.disconnect();
    registry.set(key, observation);
    return key;
  })(${user})`;
}

/** Completed captures no longer need continuity; incomplete runs retain it for reattach. */
export async function releasePromptObservation(
  runtime: ChromeClient["Runtime"],
  observationId: string | null | undefined,
): Promise<void> {
  if (!observationId) return;
  await runtime.evaluate({
    expression: `(() => {
      const registry = globalThis.__oraclePromptObservations;
      const key = ${JSON.stringify(observationId)};
      registry?.get(key)?.disconnect?.();
      registry?.delete(key);
    })()`,
    returnByValue: true,
  }).catch(() => undefined);
}
