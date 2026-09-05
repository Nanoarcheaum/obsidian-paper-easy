export const requestUrl = options => globalThis.__requestUrl(options);
export class App {}
export class Editor {}
export class FileSystemAdapter {}
export class Plugin {
  constructor(app) { this.app = app; this.events = []; this.commands = []; this.disposers = []; this.manifest = { dir: '.obsidian/plugins/test' }; }
  loadData() { return Promise.resolve({}); }
  saveData() { return Promise.resolve(); }
  registerView(type, factory) { (this.views ??= {})[type] = factory; }
  addRibbonIcon() {}
  addCommand(command) { this.commands.push(command); }
  registerEvent(event) { this.events.push(event); }
  addSettingTab() {}
  registerDomEvent(target, event, callback, options) { target.addEventListener(event, callback, options); this.disposers.push(() => target.removeEventListener(event, callback, options)); }
}
export class ItemView { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.containerEl = document.createElement('div'); this.containerEl.append(document.createElement('div')); this.contentEl = this.containerEl.createDiv(); } }
export class Modal {
  constructor(app) { this.app = app; this.modalEl = document.createElement('div'); this.titleEl = this.modalEl.createEl('h2'); this.contentEl = this.modalEl.createDiv(); }
  open() { document.body.append(this.modalEl); this.onOpen?.(); }
  close() { this.onClose?.(); this.modalEl.remove(); }
}
export class Notice { constructor(text) { (globalThis.__notices ??= []).push(text); } hide() {} }
export class Menu { addItem(callback) { const item = { setTitle() { return item; }, setIcon() { return item; }, onClick() { return item; } }; callback(item); } addSeparator() {} showAtMouseEvent() {} }
export class PluginSettingTab {}
export class Setting {}
export class SuggestModal extends Modal { setPlaceholder() {} setInstructions() {} }
export class TFile {}
export class TFolder {}
export class WorkspaceLeaf {}
export class MarkdownView {}
export const normalizePath = path => path.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
export const setIcon = (element, name) => { element.dataset.icon = name; };
export const parseYaml = text => ({ paper: text.match(/^paper: "(.*)"$/m)?.[1] });

if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.createEl = function(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element); return element;
  };
  HTMLElement.prototype.createDiv = function(options) { return this.createEl('div', options); };
  HTMLElement.prototype.createSpan = function(options) { return this.createEl('span', options); };
  HTMLElement.prototype.addClass = function(name) { this.classList.add(name); };
  HTMLElement.prototype.removeClass = function(name) { this.classList.remove(name); };
  HTMLElement.prototype.hasClass = function(name) { return this.classList.contains(name); };
  HTMLElement.prototype.toggleClass = function(name, value) { this.classList.toggle(name, value); };
  HTMLElement.prototype.setAttr = HTMLElement.prototype.setAttribute;
  HTMLElement.prototype.setText = function(text) { this.textContent = text; };
  HTMLElement.prototype.empty = function() { this.replaceChildren(); };
  HTMLElement.prototype.hide = function() { this.style.display = 'none'; };
  HTMLElement.prototype.show = function() { this.style.display = ''; };
}
