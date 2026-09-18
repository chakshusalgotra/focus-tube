(function () {
  'use strict';

  const model = window.NotebookModel;
  const Quill = window.Quill;
  const Delta = Quill.import('delta');
  const { Attributor, Scope } = Quill.import('parchment');
  const History = Quill.import('modules/history');

  class AnchorAttribute extends Attributor {
    add(node, value) {
      return model.hasTime(Number(value)) && super.add(node, String(value));
    }
    value(node) {
      const value = super.value(node);
      return value === '' ? undefined : value;
    }
  }

  class NoteHistory extends History {
    undo() {
      this.restoring = true;
      try { super.undo(); } finally { this.restoring = false; }
    }
    redo() {
      this.restoring = true;
      try { super.redo(); } finally { this.restoring = false; }
    }
  }

  Quill.register(new Attributor('blockId', 'data-note-id', { scope: Scope.BLOCK_ATTRIBUTE }), true);
  Quill.register(new AnchorAttribute('anchorSeconds', 'data-note-seconds', { scope: Scope.BLOCK_ATTRIBUTE }), true);
  Quill.register('modules/history', NoteHistory, true);

  function editorDelta(value) {
    return new Delta(value.ops.map(operation => {
      if (operation.attributes?.anchorSeconds === undefined) return operation;
      return { ...operation, attributes: { ...operation.attributes, anchorSeconds: String(operation.attributes.anchorSeconds) } };
    }));
  }

  function inlineContent(operations) {
    const fragment = document.createDocumentFragment();
    for (const operation of operations) {
      const attributes = operation.attributes || {};
      let node = document.createTextNode(operation.insert);
      for (const [key, tag] of [['code', 'code'], ['italic', 'em'], ['bold', 'strong'], ['link', 'a']]) {
        if (!attributes[key]) continue;
        const wrapper = document.createElement(tag);
        if (key === 'link') {
          const url = model.safeLink(attributes.link);
          if (!url) continue;
          wrapper.href = url;
          wrapper.target = '_blank';
          wrapper.rel = 'noopener noreferrer';
        }
        wrapper.append(node);
        node = wrapper;
      }
      fragment.append(node);
    }
    return fragment;
  }

  function render(container, value, { videoId, onSeek, portable = false } = {}) {
    container.replaceChildren();
    const checked = model.validate(value);
    if (!checked) return;
    let list = null;
    let listKind = null;
    let codeGroup = null;
    for (const block of model.lines(checked)) {
      const format = block.attributes;
      const isCode = !!format['code-block'];
      const tag = format.header ? `h${format.header}` : format.list ? 'li' : isCode ? 'span' : 'p';
      const element = document.createElement(tag);
      element.className = 'note-block';
      if (format.indent) element.style.marginInlineStart = `${format.indent * 1.25}rem`;
      element.append(inlineContent(block.ops));
      if (!block.text) element.append(document.createElement('br'));
      const url = model.hasTime(format.anchorSeconds) ? model.sourceUrl(videoId, format.anchorSeconds) : null;
      if (url && portable) {
        const link = document.createElement('a');
        link.href = url;
        if (!isCode && !element.querySelector('a')) {
          link.className = 'note-source-text';
          link.append(...element.childNodes);
          element.append(link);
        } else {
          link.className = 'note-source-link';
          link.textContent = 'Source';
          element.append(document.createTextNode(' '), link);
        }
      } else if (url && onSeek) {
        element.classList.add('note-anchored');
        element.tabIndex = 0;
        element.setAttribute('role', 'link');
        element.setAttribute('aria-label', `${block.text}. Open source video`);
        const activate = event => {
          if (event.target.closest('a') || window.getSelection()?.toString()) return;
          if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          onSeek(format.anchorSeconds);
        };
        element.addEventListener('click', activate);
        element.addEventListener('keydown', activate);
      }
      if (format.list) {
        codeGroup = null;
        if (!list || listKind !== format.list) {
          list = document.createElement(format.list === 'ordered' ? 'ol' : 'ul');
          listKind = format.list;
          container.append(list);
        }
        list.append(element);
      } else if (isCode) {
        list = null;
        listKind = null;
        if (!codeGroup) { codeGroup = document.createElement('pre'); codeGroup.className = 'note-code-group'; container.append(codeGroup); }
        codeGroup.append(element);
      } else {
        list = null;
        listKind = null;
        codeGroup = null;
        container.append(element);
      }
    }
  }

  class Editor {
    constructor(container, { getTime = () => null, onChange = () => {}, onCompositionEnd = () => {} } = {}) {
      this.getTime = getTime;
      this.onChange = onChange;
      this.composing = false;
      this.changing = false;
      this.clock = null;
      this.container = container;
      const toolbar = document.createElement('div');
      toolbar.className = 'note-toolbar';
      toolbar.innerHTML = '<span class="ql-formats"><select class="ql-header" aria-label="Paragraph style"><option value="" selected>Normal</option><option value="2">Heading 2</option><option value="3">Heading 3</option></select></span><span class="ql-formats"><button class="ql-bold" aria-label="Bold" title="Bold"></button><button class="ql-italic" aria-label="Italic" title="Italic"></button><button class="ql-code" aria-label="Inline code" title="Inline code"></button></span><span class="ql-formats"><button class="ql-list" value="ordered" aria-label="Numbered list" title="Numbered list"></button><button class="ql-list" value="bullet" aria-label="Bullet list" title="Bullet list"></button></span><span class="ql-formats"><button class="ql-link" aria-label="Link" title="Link"></button><button class="ql-code-block" aria-label="Code block" title="Code block"></button></span>';
      const surface = document.createElement('div');
      container.replaceChildren(toolbar, surface);
      this.quill = new Quill(surface, {
        theme: 'snow',
        formats: ['header', 'bold', 'italic', 'code', 'list', 'indent', 'link', 'code-block', 'blockId', 'anchorSeconds'],
        modules: { toolbar, history: { delay: 1000, maxStack: 100, userOnly: false } },
      });
      const headingSelect = toolbar.querySelector('select.ql-header');
      let headingValue = headingSelect.value;
      this.quill.on('editor-change', () => {
        if (headingSelect.selectedIndex < 0) headingSelect.value = headingValue;
        else headingValue = headingSelect.value;
      });
      this.quill.root.setAttribute('aria-label', 'Video notes');
      this.quill.root.setAttribute('role', 'textbox');
      this.quill.root.setAttribute('aria-multiline', 'true');
      this.quill.root.addEventListener('beforeinput', () => {
        if (!this.composing) this.clock = this.getTime();
      });
      this.quill.root.addEventListener('compositionstart', () => {
        this.composing = true;
        this.clock = this.getTime();
      });
      this.quill.root.addEventListener('compositionend', () => {
        this.composing = false;
        queueMicrotask(() => { this.quill.update(); onCompositionEnd(); });
      });
      this.quill.root.addEventListener('paste', () => { this.clock = this.getTime(); }, true);
      this.quill.clipboard.addMatcher(Node.ELEMENT_NODE, (_node, delta) => new Delta(delta.ops.filter(operation => typeof operation.insert === 'string').map(operation => {
        const attributes = { ...operation.attributes };
        delete attributes.blockId;
        delete attributes.anchorSeconds;
        if (attributes.link && !model.safeLink(attributes.link)) delete attributes.link;
        return { insert: operation.insert, attributes };
      })));
      this.quill.on('text-change', (change, oldDelta, source) => {
        if (this.changing || source === 'silent') return;
        if (!this.quill.history.restoring) {
          const next = model.anchorChanges(oldDelta, this.quill.getContents(), change, this.clock ?? this.getTime(), () => crypto.randomUUID());
          const patch = this.quill.getContents().diff(editorDelta(next));
          this.changing = true;
          try { if (patch.ops.length) this.quill.updateContents(patch, 'api'); } finally { this.changing = false; }
        }
        this.onChange(this.snapshot());
      });
    }

    snapshot() {
      return model.fromLines(model.lines(this.quill.getContents()));
    }

    load(value) {
      this.changing = true;
      try {
        this.quill.setContents(editorDelta(model.validate(value) || model.empty()), 'api');
        this.quill.history.clear();
        this.clock = null;
      } finally {
        this.changing = false;
      }
    }

    enable(enabled) {
      this.quill.enable(enabled);
      this.container.querySelectorAll('.ql-toolbar button, .ql-toolbar select').forEach(control => { control.disabled = !enabled; });
    }
  }

  window.NotebookEditor = { Editor, render };
})();