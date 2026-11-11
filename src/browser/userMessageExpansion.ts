import {
  buildUserContentBubblesExpression,
  buildUserMessageIdExpression,
} from "./conversationTurns.js";

/** Expand only the recorded user-bubble control; its label is never prompt evidence. */
export function buildUserMessageExpansionExpression(expected: string): string {
  return `(async () => {
    // Recorded in tests/fixtures/chatgpt-dom-2026-09/streaming.html.
    const buttons = Array.from(bubble.querySelectorAll('button'));
    const control = buttons[0];
    if (buttons.length !== 1 || control.getAttribute('type') !== 'button' ||
        control.getAttribute('aria-expanded') !== 'false' ||
        control.getAttribute('data-thread-find-skip') !== 'true' ||
        control.textContent !== 'Show more' || control.hasAttribute('disabled') ||
        control.getAttribute('aria-disabled') === 'true' ||
        control.closest('[data-user-message-bubble="true"]') !== bubble ||
        typeof control.click !== 'function') return 'text-mismatch';
    const rect = control.getBoundingClientRect();
    if (!rect.width || !rect.height) return 'text-mismatch';
    const navigation = globalThis.navigation;
    if (typeof MutationObserver !== 'function' || !navigation?.addEventListener ||
        !navigation?.removeEventListener || typeof location?.href !== 'string' ||
        !location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/)) return 'continuity-unavailable';
    const selector = ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])';
    const competingSelector = selector + ', [data-user-message-bubble="true"]';
    const originalUsers = Array.from(document.querySelectorAll(selector));
    const identities = originalUsers.map(node => ${buildUserMessageIdExpression("node")});
    const turn = user.closest('[data-turn-key]');
    const turnKey = turn?.getAttribute('data-turn-key');
    const href = location.href;
    let invalidated = false;
    const identityAttributes = ['data-message-id', 'data-chatgpt-selection-message-id',
      'data-chatgpt-search-message-ids', 'data-content-search-unit-key',
      'data-chatgpt-search-unit-key', 'data-turn-key', 'data-message-author-role',
      'data-user-message-bubble'];
    const inspect = records => {
      for (const record of records) {
        if ((record.type === 'attributes' && identityAttributes.includes(record.attributeName)) ||
            Array.from(record.removedNodes || []).some(node =>
              node === user || node.contains?.(user) || node === bubble || node.contains?.(bubble)) ||
            Array.from(record.addedNodes || []).some(node =>
              node.matches?.(competingSelector) || node.querySelector?.(competingSelector))) invalidated = true;
      }
    };
    const observer = new MutationObserver(inspect);
    const onNavigate = () => { invalidated = true; };
    const stable = () => {
      inspect(observer.takeRecords());
      const users = Array.from(document.querySelectorAll(selector));
      const bubbles = ${buildUserContentBubblesExpression()};
      return !invalidated && location.href === href && user.isConnected && bubble.isConnected &&
        user.closest('[data-turn-key]') === turn && turn?.getAttribute('data-turn-key') === turnKey &&
        ${buildUserMessageIdExpression()} === messageId &&
        users.length === originalUsers.length && users.every((node, index) =>
          node === originalUsers[index] && ${buildUserMessageIdExpression("node")} === identities[index]) &&
        bubbles.length === 1 && bubbles[0] === bubble;
    };
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    navigation.addEventListener('navigate', onNavigate);
    let handedOff = false;
    const disconnect = () => {
      observer.disconnect();
      navigation.removeEventListener('navigate', onNavigate);
    };
    try {
      if (!stable() || !control.isConnected || !bubble.contains(control)) return 'continuity-unavailable';
      control.click();
      const deadline = performance.now() + 1000;
      for (;;) {
        if (!stable()) return 'continuity-unavailable';
        // Only the caller's subsequent full DOM read can establish binding.
        if (typeof bubble.textContent === 'string' &&
            bubble.textContent.replace(/\\r\\n?/g, '\\n') === ${JSON.stringify(expected)}) {
          handedOff = true;
          return { finish: () => { try { return stable(); } finally { disconnect(); } } };
        }
        if (performance.now() >= deadline) return 'text-mismatch';
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } finally {
      if (!handedOff) disconnect();
    }
  })()`;
}
