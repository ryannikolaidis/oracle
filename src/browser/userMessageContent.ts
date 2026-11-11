/** Read exact user content, excluding only one verified expanded-preview control. */
export function buildUserMessageContentExpression(bubbleExpression = "bubble"): string {
  return `((bubble) => {
    if (!bubble) return null;
    const controls = Array.from(bubble.querySelectorAll('button, [role="button"], [aria-expanded]'));
    if (!controls.length) return bubble.textContent;
    const control = controls[0];
    if (controls.length !== 1 || control.tagName !== 'BUTTON' ||
        control.getAttribute('type') !== 'button' ||
        control.getAttribute('aria-expanded') !== 'true' ||
        control.textContent !== 'Show less' ||
        (control.hasAttribute('aria-label') && control.getAttribute('aria-label') !== 'Show less') ||
        (control.hasAttribute('role') && control.getAttribute('role') !== 'button') ||
        control.hasAttribute('disabled') ||
        control.getAttribute('aria-disabled') === 'true' ||
        control.closest('[data-user-message-bubble="true"]') !== bubble) return null;
    // Traverse text nodes without trimming, suffix removal or mutating the live DOM.
    const read = node => node === control ? '' : node.nodeType === 3 ? node.textContent :
      Array.from(node.childNodes).map(read).join('');
    return read(bubble);
  })(${bubbleExpression})`;
}
