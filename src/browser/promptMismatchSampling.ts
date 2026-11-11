import { buildUserMessageIdExpression } from "./conversationTurns.js";

/** Failure-only reads in the initial evaluation's closure. No binding observer or registry. */
export function buildMismatchSamplingExpression(maxTextLength: number): string {
  return `(async () => {
    const started = mismatchStarted;
    const turn = mismatchTurn;
    const href = mismatchHref;
    const navigation = globalThis.navigation;
    if (typeof text !== 'string' || !conversationId || !messageId || !turn || diagnostic.bubbleCount > 1 ||
        typeof MutationObserver !== 'function' || !navigation?.addEventListener ||
        !navigation?.removeEventListener || !user.isConnected || !bubble.isConnected) return undefined;
    const selector = ':is([data-message-author-role="user"], [data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"])';
    let invalid = false;
    let wake;
    const invalidate = () => { invalid = true; wake?.(); };
    const identities = ['data-message-id', 'data-chatgpt-selection-message-id', 'data-chatgpt-search-message-ids', 'data-content-search-unit-key', 'data-chatgpt-search-unit-key', 'data-turn-key', 'data-message-author-role', 'data-user-message-bubble'];
    const inspect = records => {
      for (const record of records) {
        // Conservative: even an identity change restored before a read loses correlation.
        if (record.type === 'attributes' && identities.includes(record.attributeName)) invalidate();
        for (const node of [...record.removedNodes, ...record.addedNodes]) {
          if (node === user || node.contains?.(user) || node === bubble || node.contains?.(bubble) ||
              node.matches?.(selector) || node.querySelector?.(selector)) invalidate();
        }
      }
    };
    const observer = new MutationObserver(inspect);
    const correlated = () => {
      inspect(observer.takeRecords());
      if (invalid || location.href !== href || !user.isConnected || !bubble.isConnected ||
          user.closest('[data-turn-key]') !== turn ||
          (user.querySelector('[data-user-message-bubble="true"]') || user) !== bubble ||
          user.querySelectorAll('[data-user-message-bubble="true"]').length > 1 ||
          ${buildUserMessageIdExpression()} !== messageId) return false;
      const users = Array.from(document.querySelectorAll(selector)).filter(node => {
        const owner = node.parentElement?.closest(selector);
        return !owner || owner.closest('[data-turn-key]') !== node.closest('[data-turn-key]');
      });
      const fresh = [];
      for (const node of users) {
        const id = ${buildUserMessageIdExpression("node")};
        if (typeof id !== 'string' || !id.trim()) return false;
        if (!previous.includes(id)) fresh.push(node);
      }
      return fresh.length === 1 && fresh[0] === user;
    };
    const samples = [];
    try {
      navigation.addEventListener('navigate', invalidate);
      navigation.addEventListener('currententrychange', invalidate);
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      if (!correlated()) return undefined;
      for (const offset of [250, 1000]) {
        do { await new Promise(resolve => {
          const timer = setTimeout(() => { wake = undefined; resolve(); }, Math.max(0, Math.ceil(offset - (performance.now() - started))));
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
        }); } while (!invalid && performance.now() - started < offset);
        if (!correlated()) return undefined;
        const value = bubble.textContent;
        const elapsedMs = performance.now() - started;
        if (!correlated() || typeof value !== 'string' || value.length > ${maxTextLength} ||
            elapsedMs < offset || elapsedMs > 1500) return undefined;
        samples.push({ elapsedMs, text: value });
      }
      return samples;
    } catch { return undefined; }
    finally {
      observer.disconnect();
      navigation.removeEventListener('navigate', invalidate);
      navigation.removeEventListener('currententrychange', invalidate);
    }
  })()`;
}
