/** Original, self-contained line icons; no icon font or network request required. */
export function element(tag, text, className = '', ownerDocument = globalThis.document) {
  const node = ownerDocument.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createActionButton(label, action, {
  className = 'secondary-button',
  ownerDocument = globalThis.document,
  onError = console.error
} = {}) {
  const button = element('button', label, className, ownerDocument);
  button.type = 'button';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      onError(error);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  };
  return button;
}

export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', ('icon ' + className).trim());
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '/viewer/icons.svg#' + name);
  svg.append(use);
  return svg;
}

export function decorateIcons(root = document) {
  for (const element of root.querySelectorAll('[data-icon]')) {
    element.prepend(icon(element.dataset.icon));
  }
  for (const button of root.querySelectorAll('button[data-close]')) {
    button.replaceChildren(icon('close'));
  }
}
