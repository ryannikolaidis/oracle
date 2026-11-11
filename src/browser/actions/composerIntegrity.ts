import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from "../constants.js";

// DOM hard breaks carry text that innerText may add layout whitespace around.
export const COMPOSER_TEXT_READER = `const readText = node => {
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\\n';
  const children = Array.from(node.childNodes || []);
  return children.map((child, index) => {
    const previous = children[index - 1];
    const block = value => /^(P|DIV|PRE|LI)$/.test(value?.nodeName || '');
    return (index > 0 && (block(child) || block(previous)) ? '\\n' : '') + readText(child);
  }).join('');
};`;

export function buildBeginComposerIntegrity(key: string, prompt: string): string {
  return `(() => {
    const key = ${JSON.stringify(key)};
    const candidates = () => [...new Set(${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))))].filter(node => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    const editors = candidates();
    if (editors.length !== 1) return false;
    const editor = editors[0];
    const url = location.href;
    const doc = document;
    const composerRoot = () => {
      const form = editor.closest('form,[data-chatgpt-composer]');
      if (form) return form;
      for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement) {
        if (${JSON.stringify(SEND_BUTTON_SELECTORS)}.some(selector => node.querySelector(selector))) return node;
      }
      return editor.parentElement;
    };
    const root = composerRoot();
    if (!root) return false;
    const chips = () => Array.from(root.querySelectorAll('[aria-label*="Remove" i],[data-testid*="file-chip"],[data-testid*="attachment-chip"],input[type="file"]')).filter(node => {
      if (node.closest('textarea,[contenteditable="true"]')) return false;
      const label = node.getAttribute('aria-label') ?? '';
      return /^remove (?:pasted text|file|attachment|image|photo)(?: |$)/i.test(label) ||
        /(?:file|attachment)-chip/.test(node.getAttribute('data-testid') ?? '') ||
        Boolean(node.files?.length);
    });
    // Inline strict capture has no uploaded payload to attest.
    if (chips().length) return false;
    ${COMPOSER_TEXT_READER}
    const normalize = value => value.replace(/\\r\\n?/g, '\\n');
    const expected = normalize(${JSON.stringify(prompt)});
    globalThis[key] = {
      editor,
      check: (content = true) => {
        const current = candidates();
        if (document !== doc || location.href !== url || !editor.isConnected ||
            current.length !== 1 || current[0] !== editor ||
            composerRoot() !== root || chips().length) return false;
        if (!content) return true;
        const text = editor instanceof HTMLTextAreaElement ? editor.value : readText(editor);
        return normalize(text) === expected;
      },
    };
    return true;
  })()`;
}

export function buildCheckComposerIntegrity(key: string, content = true): string {
  return `(globalThis[${JSON.stringify(key)}]?.check(${content}) === true)`;
}
