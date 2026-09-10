(function () {
  'use strict';

  const model = window.NotebookModel;
  const find = selector => document.querySelector(selector);
  const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  class Notebooks {
    constructor(options) {
      this.options = options;
      this.generation = 0;
      this.binding = 0;
      this.view = 0;
      this.states = new Map();
      this.loaded = new Map();
      this.requests = new Set();
      this.notesRevision = 0;
      this.active = null;
      this.reviewCourse = null;
      this.mode = 'read';
      try {
        this.tabId = sessionStorage.getItem('ft_notes_tab') || crypto.randomUUID();
        sessionStorage.setItem('ft_notes_tab', this.tabId);
      } catch { this.tabId = crypto.randomUUID(); }
      this.editor = new NotebookEditor.Editor(find('#noteEditor'), {
        getTime: () => this.active ? options.getTime(this.active.courseId, this.active.videoId) : null,
        onChange: value => this.change(value),
        onCompositionEnd: () => {
          const pending = this.pendingBinding;
          this.pendingBinding = null;
          if (pending) pending();
        },
      });
      find('#noteReadMode').addEventListener('click', () => this.setMode('read'));
      find('#noteEditMode').addEventListener('click', () => this.setMode('edit'));
      find('#noteRetry').addEventListener('click', () => { if (this.active) this.save(this.active); else this.retryBinding?.(); });
      find('#noteKeepDraft').addEventListener('click', () => this.resolveConflict(true));
      find('#noteUseSaved').addEventListener('click', () => this.resolveConflict(false));
      find('#notebookVideoSelect').addEventListener('change', event => this.selectVideo(event.target.value));
      find('#notebookMarkdown').addEventListener('click', () => this.exportMarkdown().catch(error => this.report(error)));
      find('#notebookPrintBtn').addEventListener('click', () => this.print().catch(error => this.report(error)));
      find('#notebookDelete').addEventListener('click', () => this.removeNotebook().catch(error => this.report(error)));
      find('#notebookReload').addEventListener('click', () => this.show(this.reviewCourse));
      window.addEventListener('pagehide', () => this.states.forEach(state => { if (state.dirty) this.keepDraft(state); }));
      window.addEventListener('beforeunload', event => {
        if ([...this.states.values()].some(state => state.dirty)) { event.preventDefault(); event.returnValue = ''; }
      });
      window.addEventListener('afterprint', () => document.body.classList.remove('notebook-printing'));
      this.editor.enable(false);
      this.setMode(this.mode);
    }

    report(error) {
      if (error.name === 'AbortError') return;
      this.options.showError(error.message);
      if (!find('#notebooksView').classList.contains('hidden')) {
        find('#notebookNotice').textContent = error.message;
        find('#notebookNotice').classList.remove('hidden');
        find('#notebookReload').classList.remove('hidden');
      }
    }

    async request(url, options = {}) {
      const generation = this.generation;
      const controller = new AbortController();
      this.requests.add(controller);
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...options.headers } });
        const body = await response.json();
        if (generation !== this.generation) throw new DOMException('Session changed', 'AbortError');
        if (!response.ok) throw Object.assign(new Error(body.error || 'Could not load notes.'), { status: response.status, body });
        if (Number.isSafeInteger(body.notesRevision)) this.notesRevision = Math.max(this.notesRevision, body.notesRevision);
        return body;
      } catch (error) {
        if (controller.signal.aborted && generation === this.generation) throw new Error('Notes request timed out. Try again.');
        throw error;
      } finally { clearTimeout(timer); this.requests.delete(controller); }
    }

    key(courseId, videoId) { return courseId + '/' + videoId; }

    draftKey(state) { return `ft_note_draft:${state.owner}:${state.courseId}:${state.videoId}:${this.tabId}`; }

    keepDraft(state) {
      try {
        localStorage.setItem(this.draftKey(state), JSON.stringify({ revision: state.revision, document: state.document, updatedAt: Date.now() }));
        state.storageError = false;
      } catch { state.storageError = true; }
    }

    clearDraft(state) {
      try { localStorage.removeItem(this.draftKey(state)); } catch { state.storageError = true; }
    }

    stateFor(courseId, videoId, record) {
      const key = this.key(courseId, videoId);
      let state = this.states.get(key);
      if (state) {
        if (record && !state.dirty && !state.inFlight) Object.assign(state, record);
        return state;
      }
      const course = this.options.getCourses()[courseId];
      const video = course?.videos.find(item => item.id === videoId);
      state = {
        courseId, videoId, owner: this.options.getUser().id,
        courseTitle: course?.title || record?.courseTitle || 'Notebook', videoTitle: video?.title || record?.videoTitle || 'Video notes',
        document: null, revision: 0, sequence: 0, dirty: false, error: '', conflict: null,
        ...record,
      };
      state.document = model.validate(state.document);
      this.states.set(key, state);
      try {
        const draft = JSON.parse(localStorage.getItem(this.draftKey(state)) || 'null');
        if (draft && Number.isSafeInteger(draft.revision)) {
          const document = model.validate(draft.document);
          if (!same(document, state.document)) {
            if (draft.revision !== state.revision) state.conflict = { record: { ...state } };
            state.document = document;
            state.dirty = true;
            state.recovered = true;
          } else this.clearDraft(state);
        }
      } catch { state.error = 'A local draft could not be read. The saved version is shown.'; }
      return state;
    }

    async loadCourse(courseId, force = false) {
      if (!force && this.loaded.has(courseId)) return this.loaded.get(courseId);
      const pending = this.request('/api/notebooks/' + encodeURIComponent(courseId)).then(result => {
        for (const record of result.records) this.stateFor(courseId, record.videoId, record);
        return result;
      }).catch(error => { this.loaded.delete(courseId); throw error; });
      this.loaded.set(courseId, pending);
      return pending;
    }

    change(value) {
      const state = this.active;
      if (!state || state.owner !== this.options.getUser()?.id) return;
      let checked;
      try { checked = model.validate(value); } catch (error) {
        this.editor.load(state.document);
        this.options.showError(error.message);
        return;
      }
      if (same(checked, state.document)) return;
      state.document = checked;
      state.sequence++;
      state.dirty = true;
      state.error = '';
      this.keepDraft(state);
      clearTimeout(state.timer);
      state.timer = setTimeout(() => this.save(state), 800);
      this.status();
    }

    async save(state) {
      clearTimeout(state.timer);
      if (state.inFlight) return state.inFlight;
      if (!state.dirty) return true;
      if (state.conflict || state.owner !== this.options.getUser()?.id) return false;
      const generation = this.generation;
      state.error = '';
      state.saving = true;
      state.inFlight = (async () => {
        do {
          const sequence = state.sequence;
          const document = state.document;
          try {
            if (!state.revision && !(await this.options.ensureCourseSaved())) throw new Error('Could not save the course. Your note remains a draft.');
            if (generation !== this.generation) return false;
            let result;
            try {
              result = await this.request(`/api/notebooks/${encodeURIComponent(state.courseId)}/videos/${state.videoId}`, {
                method: 'PUT', body: JSON.stringify({ document, revision: state.revision }),
              });
            } catch (error) {
              if (error.status !== 409) throw error;
              this.notesRevision = Math.max(this.notesRevision, error.body.notesRevision || 0);
              if (same(error.body.record?.document || null, document)) result = error.body;
              else { state.conflict = error.body; return false; }
            }
            state.revision = result.record?.revision || 0;
            state.updatedAt = result.record?.updatedAt;
            state.recovered = false;
            state.dirty = state.sequence !== sequence;
            if (state.dirty) this.keepDraft(state);
            else this.clearDraft(state);
          } catch (error) {
            if (error.name !== 'AbortError') state.error = error.message;
            return false;
          }
        } while (state.dirty && generation === this.generation);
        return generation === this.generation;
      })().finally(() => {
        state.inFlight = null;
        state.saving = false;
        if (generation === this.generation) this.status();
      });
      this.status();
      return state.inFlight;
    }

    async flush() {
      this.editor.quill.update();
      if (this.editor.composing) return false;
      const saved = await Promise.all([...this.states.values()].map(state => this.save(state)));
      return saved.every(Boolean) && ![...this.states.values()].some(state => state.dirty);
    }

    status() {
      const state = this.active;
      const text = !state ? 'Loading notes...' : state.conflict ? 'Conflicting edit' : state.error || (state.saving ? 'Saving...' : state.dirty ? state.storageError ? 'Unsaved; local recovery unavailable' : state.recovered ? 'Recovered draft' : 'Unsaved' : state.revision ? 'Saved' : 'No notes yet');
      find('#noteStatus').textContent = text;
      find('#noteStatus').classList.toggle('note-save-error', !!(state?.error || state?.conflict || state?.storageError));
      find('#noteRetry').classList.toggle('hidden', !state?.error && !state?.recovered);
      find('#noteConflict').classList.toggle('hidden', !state?.conflict);
    }

    resolveConflict(keepLocal) {
      const state = this.active;
      if (!state?.conflict) return;
      const saved = state.conflict.record;
      state.revision = saved?.revision || 0;
      state.conflict = null;
      state.error = '';
      if (keepLocal) { this.keepDraft(state); this.save(state); }
      else {
        state.document = model.validate(saved?.document || null);
        state.dirty = false;
        state.recovered = false;
        this.clearDraft(state);
        this.editor.load(state.document);
        this.setMode(this.mode);
      }
      this.status();
    }

    setMode(mode) {
      this.mode = mode;
      find('#noteEditor').classList.toggle('hidden', mode !== 'edit');
      find('#noteRead').classList.toggle('hidden', mode !== 'read' || !this.active?.document);
      find('#noteEmpty').classList.toggle('hidden', mode !== 'read' || !!this.active?.document);
      for (const choice of ['read', 'edit']) {
        const button = find(choice === 'read' ? '#noteReadMode' : '#noteEditMode');
        button.classList.toggle('active', mode === choice);
        button.setAttribute('aria-pressed', String(mode === choice));
      }
      if (mode === 'read' && this.active) {
        const state = this.active;
        NotebookEditor.render(find('#noteRead'), state.document, { videoId: state.videoId, onSeek: seconds => this.options.onJump(state.courseId, state.videoId, seconds) });
      }
    }

    async bind(courseId, videoId, host, mode) {
      if (mode) this.setMode(mode);
      if (this.editor.composing) { this.pendingBinding = () => this.bind(courseId, videoId, host); return; }
      if (this.active?.courseId === courseId && this.active.videoId === videoId && find('#notesWidget').parentElement === host) return this.setMode(this.mode);
      if (this.active) this.save(this.active);
      this.active = null;
      const binding = ++this.binding;
      this.retryBinding = () => this.bind(courseId, videoId, host);
      host.append(find('#notesWidget'));
      find('#notesWidget').classList.remove('hidden');
      this.editor.load(null);
      this.editor.enable(false);
      find('#noteRead').replaceChildren();
      find('#noteVideoTitle').textContent = 'Video notes';
      this.setMode(this.mode);
      this.status();
      try {
        await this.loadCourse(courseId);
        if (binding !== this.binding || !this.options.getUser()) return;
        this.active = this.stateFor(courseId, videoId);
        this.editor.load(this.active.document);
        this.editor.enable(true);
        find('#noteVideoTitle').textContent = this.active.videoTitle;
        this.setMode(this.mode);
        this.status();
        if (this.active.dirty && !this.active.conflict) this.save(this.active);
      } catch (error) {
        if (binding !== this.binding) return;
        find('#noteStatus').textContent = error.message;
        find('#noteRetry').textContent = 'Retry';
        find('#noteRetry').classList.remove('hidden');
        this.report(error);
      }
    }

    showVideo(courseId, videoId) {
      find('#courseNotebookLink').href = '#notebook=' + encodeURIComponent(courseId);
      return this.bind(courseId, videoId, find('#courseNotesHost'));
    }

    records(courseId) {
      const course = this.options.getCourses()[courseId];
      const order = new Map((course?.videos || []).map((video, index) => [video.id, index]));
      return [...this.states.values()].filter(state => state.courseId === courseId && state.document)
        .sort((first, second) => (order.get(first.videoId) ?? Infinity) - (order.get(second.videoId) ?? Infinity) || first.videoTitle.localeCompare(second.videoTitle));
    }

    title(courseId) {
      return this.options.getCourses()[courseId]?.title || this.records(courseId)[0]?.courseTitle || 'Notebook';
    }

    async show(courseId = null, videoId = '') {
      const view = ++this.view;
      this.reviewCourse = courseId;
      find('#notebooksView').classList.remove('hidden');
      find('#notebookNotice').classList.add('hidden');
      find('#notebookReload').classList.add('hidden');
      find('#notebookTitle').textContent = 'Notebooks';
      find('#notebookMeta').textContent = 'Loading...';
      find('#notebookIndex').replaceChildren();
      find('#notebookDocuments').replaceChildren();
      find('#notebookDetail').classList.add('hidden');
      find('#notebookActions').classList.toggle('hidden', !courseId);
      try {
        if (!courseId) {
          const result = await this.request('/api/notebooks');
          if (view !== this.view) return;
          const entries = new Map(result.notebooks.map(notebook => [notebook.courseId, notebook]));
          for (const course of Object.values(this.options.getCourses())) {
            if (!entries.has(course.id)) entries.set(course.id, { courseId: course.id, title: course.title, count: 0 });
          }
          find('#notebookMeta').textContent = `${entries.size} course notebook${entries.size === 1 ? '' : 's'}`;
          for (const entry of entries.values()) {
            const link = node('a', 'notebook-row');
            link.href = '#notebook=' + encodeURIComponent(entry.courseId);
            const imageVideo = this.options.getCourses()[entry.courseId]?.videos[0]?.id;
            if (imageVideo) {
              const image = node('img', 'notebook-cover');
              image.src = `https://i.ytimg.com/vi/${imageVideo}/mqdefault.jpg`;
              image.alt = '';
              image.loading = 'lazy';
              link.append(image);
            }
            const summary = node('div', 'notebook-row-main');
            summary.append(node('h2', '', entry.title), node('p', 'muted', `${entry.count} video note${entry.count === 1 ? '' : 's'}${entry.archived ? ' / Archived course' : ''}`));
            link.append(summary);
            find('#notebookIndex').append(link);
          }
          if (!entries.size) find('#notebookIndex').append(node('p', 'empty-state', 'No notebooks yet.'));
          return;
        }
        await this.loadCourse(courseId, true);
        if (view !== this.view) return;
        find('#notebookTitle').textContent = this.title(courseId);
        const records = this.records(courseId);
        const course = this.options.getCourses()[courseId];
        find('#notebookMeta').textContent = `${records.length} video note${records.length === 1 ? '' : 's'}${course ? '' : ' / Archived course'}`;
        find('#notebookDetail').classList.remove('hidden');
        const select = find('#notebookVideoSelect');
        select.replaceChildren(new Option('All written notes', ''));
        const videos = new Map((course?.videos || []).map(video => [video.id, video.title]));
        for (const record of records) if (!videos.has(record.videoId)) videos.set(record.videoId, record.videoTitle);
        for (const [id, title] of videos) select.append(new Option(title, id));
        select.value = videos.has(videoId) ? videoId : '';
        this.selectVideo(select.value);
      } catch (error) { if (view === this.view) { find('#notebookMeta').textContent = ''; this.report(error); } }
    }

    selectVideo(videoId, mode) {
      if (!this.reviewCourse) return;
      find('#notebookEditorHost').classList.toggle('hidden', !videoId);
      find('#notebookDocuments').classList.toggle('hidden', !!videoId);
      if (videoId) {
        return this.bind(this.reviewCourse, videoId, find('#notebookEditorHost'), mode);
      } else {
        if (this.active) this.save(this.active);
        this.active = null;
        this.binding++;
        this.setMode('read');
        this.renderDocuments(find('#notebookDocuments'), this.reviewCourse, false);
      }
    }

    renderDocuments(container, courseId, portable) {
      container.replaceChildren();
      const records = this.records(courseId);
      for (const state of records) {
        const section = node('section', 'note-document');
        const heading = node('header', 'note-document-heading');
        heading.append(node('h2', '', state.videoTitle));
        if (!portable) {
          const edit = node('button', 'btn ghost slim', 'Edit');
          edit.type = 'button';
          edit.addEventListener('click', () => {
            find('#notebookVideoSelect').value = state.videoId;
            this.selectVideo(state.videoId, 'edit');
          });
          heading.append(edit);
        }
        const content = node('div', 'note-content');
        NotebookEditor.render(content, state.document, { videoId: state.videoId, portable, onSeek: seconds => this.options.onJump(courseId, state.videoId, seconds) });
        section.append(heading, content);
        container.append(section);
      }
      if (!records.length) container.append(node('p', 'empty-state', 'No written notes yet.'));
    }

    async exportMarkdown() {
      const courseId = this.reviewCourse;
      if (!courseId || !(await this.flush())) throw new Error('Resolve unsaved notes before exporting.');
      const records = this.records(courseId);
      if (!records.length) throw new Error('This notebook has no written notes.');
      const text = '# ' + model.escapeMarkdown(this.title(courseId)) + '\n\n' + records.map(record => `## ${model.escapeMarkdown(record.videoTitle)}\n\n${model.markdown(record.document, record.videoId)}`).join('\n\n') + '\n';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const link = node('a');
      link.href = url;
      link.download = (this.title(courseId).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'notebook') + '.md';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async print() {
      const courseId = this.reviewCourse;
      if (!courseId || !(await this.flush())) throw new Error('Resolve unsaved notes before printing.');
      if (!this.records(courseId).length) throw new Error('This notebook has no written notes.');
      const printable = find('#notebookPrint');
      printable.replaceChildren(node('h1', '', this.title(courseId)));
      const content = node('div');
      this.renderDocuments(content, courseId, true);
      printable.append(content);
      document.body.classList.add('notebook-printing');
      window.print();
    }

    async removeNotebook() {
      const courseId = this.reviewCourse;
      if (!courseId || !confirm(`Delete all notes in "${this.title(courseId)}"? This cannot be undone.`)) return;
      if (!(await this.flush())) throw new Error('Resolve unsaved notes before deleting this notebook.');
      const result = await this.request(`/api/notebooks/${encodeURIComponent(courseId)}?notesRevision=${this.notesRevision}`, { method: 'DELETE' });
      for (const record of result.records) {
        const state = this.stateFor(courseId, record.videoId);
        Object.assign(state, record, { dirty: false, conflict: null, error: '' });
        this.clearDraft(state);
      }
      this.active = null;
      this.loaded.delete(courseId);
      location.hash = '#notebooks';
    }

    leave() {
      this.editor.quill.update();
      if (this.active) this.save(this.active);
      this.binding++;
      this.view++;
      this.pendingBinding = null;
      this.active = null;
      find('#notebooksView').classList.add('hidden');
    }

    reset() {
      this.states.forEach(state => { clearTimeout(state.timer); if (state.dirty) this.keepDraft(state); });
      this.generation++;
      this.requests.forEach(controller => controller.abort());
      this.states.clear();
      this.loaded.clear();
      this.active = null;
      this.binding++;
      this.view++;
      this.notesRevision = 0;
      this.pendingBinding = null;
      this.retryBinding = null;
      this.editor.load(null);
      this.editor.enable(false);
      find('#noteRead').replaceChildren();
      find('#notebookDocuments').replaceChildren();
      find('#notebookIndex').replaceChildren();
      find('#notebookPrint').replaceChildren();
      find('#notebooksView').classList.add('hidden');
      document.body.classList.remove('notebook-printing');
    }
  }

  window.Notebooks = Notebooks;
})();