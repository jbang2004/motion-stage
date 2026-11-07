// Minimal DOM fixture for pure viewer modules. No browser, WebGL or dependency.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.attributes = new Map();
    this.hidden = false;
    this.listeners = {};
    this.style = {values: {}, setProperty: (name, value) => { this.style.values[name] = String(value); }};
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.text = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
      toggle: (name, enabled) => {
        const wanted = enabled ?? !this.classList.contains(name);
        const names = this.className.split(/\s+/).filter(value => value && value !== name);
        if (wanted) names.push(name);
        this.className = names.join(' ');
        return wanted;
      }
    };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type, event = {}) { for (const listener of this.listeners[type] || []) listener({target: this, preventDefault() {}, ...event}); }
  scrollTo() {}
  scrollIntoView() {}
  focus() { this.ownerDocument.activeElement = this; }
  removeAttribute(name) { this.attributes.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? node.classList.contains(selector.slice(1)) :
      selector === 'dialog[open]' ? node.tagName === 'DIALOG' && node.open : node.tagName.toLowerCase() === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

export function createDocument() {
  const elements = new Map();
  const document = {
    createElement: tag => new Element(tag, document),
    createElementNS: (_namespace, tag) => new Element(tag, document),
    listeners: {},
    addEventListener(type, listener) { (document.listeners[type] ||= []).push(listener); },
    getElementById: id => elements.get(id),
    querySelector: selector => document.body.querySelector(selector),
    add(tag, id, parent = document.body) {
      const node = document.createElement(tag);
      node.id = id;
      elements.set(id, node);
      parent.append(node);
      return node;
    }
  };
  document.body = document.createElement('body');
  return document;
}

export function createCatalogDocument() {
  const document = createDocument();
  for (const id of ['openModelCatalog', 'navCatalog', 'refreshCatalog', 'catalogChooseFolder', 'catalogMore', 'catalogCharacters', 'catalogFiles']) document.add('button', id);
  document.add('dialog', 'modelCatalogDialog');
  document.add('input', 'modelSearch');
  for (const id of ['catalogStatus', 'modelList', 'modelCount', 'sidebarModelCount']) document.add('div', id);
  return document;
}

export function tree(node) {
  return {tag: node.tagName.toLowerCase(), text: node.text, className: node.className,
    ...(node.type ? {type: node.type} : {}), children: node.children.map(tree)};
}
