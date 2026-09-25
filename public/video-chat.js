(function () {
  'use strict';
  const find = selector => document.querySelector(selector);
  const textNode = (tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  async function readChatStream(response, signal, onEvent) {
    if (!response.body) throw new Error('Streaming is unavailable. Reload chat before retrying.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const encoder = new TextEncoder();
    let buffer = '';
    let bytes = 0;
    let textBytes = 0;
    let started = false;
    let final = null;
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) { buffer += decoder.decode(); break; }
        bytes += chunk.value.byteLength;
        if (bytes > 512 * 1024) throw new Error('The chat response exceeded its size limit.');
        buffer += decoder.decode(chunk.value, { stream: true });
        let ending;
        while ((ending = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, ending);
          buffer = buffer.slice(ending + 1);
          if (!line || encoder.encode(line).byteLength > 128 * 1024) throw new Error('Invalid chat stream record.');
          const event = JSON.parse(line);
          if (!event || final || !['start', 'text', 'final', 'error', 'heartbeat'].includes(event.type)) throw new Error('Invalid chat stream event.');
          if (event.type === 'error') throw Object.assign(new Error(event.error || 'The answer could not be completed.'), { code: event.code });
          if (event.type === 'heartbeat') continue;
          if (event.type === 'start') {
            if (started) throw new Error('The chat stream restarted unexpectedly.');
            started = true;
          } else if (!started) throw new Error('The chat stream did not start correctly.');
          if (event.type === 'text' && (typeof event.text !== 'string' || (textBytes += encoder.encode(event.text).byteLength) > 64 * 1024)) {
            throw new Error('The answer exceeded its size limit.');
          }
          if (event.type === 'final') final = event;
          else await onEvent(event);
        }
        if (encoder.encode(buffer).byteLength > 128 * 1024) throw new Error('The chat record exceeded its size limit.');
      }
      if (buffer.trim() || !final) throw new Error('The answer was interrupted. Reload chat before retrying.');
      return final;
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  class VideoChat {
    constructor(options) {
      this.options = options;
      this.generation = 0;
      this.session = 0;
      this.identity = null;
      this.opened = false;
      this.pending = null;
      this.provisional = null;
      this.needsReload = false;
      this.drafts = new Map();
      this.previews = new Map();
      this.preview = null;
      this.config = { available: false, reason: 'Video chat is not configured.' };
      this.data = { revision: 0, transcript: null, messages: [] };
      find('#videoChatBtn').addEventListener('click', () => {
        if (!this.config.available) return options.showError(this.config.reason);
        if (this.opened) this.hide(); else this.open();
      });
      find('#chatClose').addEventListener('click', () => { this.hide(); find('#videoChatBtn').focus(); });
      find('#chatReload').addEventListener('click', () => this.load());
      find('#chatCancel').addEventListener('click', () => this.cancel());
      find('#studyChatTab').addEventListener('click', () => this.selectTab('chat'));
      find('#studyNotesTab').addEventListener('click', () => this.selectTab('notes'));
      find('#studyTabs').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const tab = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'notes' : this.opened ? 'notes' : 'chat';
        this.selectTab(tab);
        find(tab === 'chat' ? '#studyChatTab' : '#studyNotesTab').focus();
      });
      find('#chatLatest').addEventListener('click', () => this.follow(true));
      find('#chatMessages').addEventListener('scroll', () => { if (this.atBottom()) find('#chatLatest').classList.add('hidden'); }, { passive: true });
      find('#chatScope').addEventListener('change', () => this.controls());
      find('#chatSummarize').addEventListener('click', () => {
        const scope = find('#chatScope').value;
        this.ask({ scope, mode: 'note_draft', question: `Summarize ${scope === 'moment' ? 'this moment' : scope === 'discussion' ? 'the completed discussion' : 'this video'} for a note preview.` });
      });
      find('#chatLoadCaptions').addEventListener('click', () => this.prepare('youtube'));
      find('#chatUpload').addEventListener('change', event => this.prepare('upload', event.target.files[0]));
      find('#chatClear').addEventListener('click', () => this.clear(false));
      find('#chatRemoveTranscript').addEventListener('click', () => this.clear(true));
      find('#chatForm').addEventListener('submit', event => { event.preventDefault(); this.ask(); });
      find('#chatQuestion').addEventListener('input', () => {
        if (this.identity) this.drafts.set(this.identity.key, find('#chatQuestion').value);
        this.controls();
      });
      for (const id of ['chatConsent', 'chatRights']) find('#' + id).addEventListener('change', () => this.controls());
      find('#videoChatPanel').addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault(); event.stopPropagation(); this.hide(); find('#videoChatBtn').focus();
      });
      window.addEventListener('pagehide', () => this.cancel());
    }

    async configure() {
      const session = this.session;
      const owner = this.options.getUser?.()?.id;
      this.configController?.abort();
      this.configController = new AbortController();
      try {
        const response = await fetch('/api/video-chat/config', { signal: AbortSignal.any([this.configController.signal, AbortSignal.timeout(10000)]),
          headers: owner ? { 'X-Video-Chat-Account': String(owner) } : {} });
        const config = await response.json();
        if (session !== this.session || owner !== this.options.getUser?.()?.id) return;
        if (response.status === 401 || config.code === 'SESSION_CHANGED') { this.reset(); this.options.onSessionChanged?.(); return; }
        this.config = response.ok ? config : { available: false, reason: 'Video chat is unavailable.' };
      } catch { if (session === this.session) this.config = { available: false, reason: 'Video chat is unavailable. Reload to try again.' }; }
      if (session === this.session) this.controls();
    }

    showVideo(courseId, videoId, title) {
      const key = courseId + '/' + videoId;
      if (this.identity?.key === key) return;
      this.cancel();
      this.generation++;
      this.pending = null;
      this.provisional = null;
      this.needsReload = false;
      this.identity = { courseId, videoId, title, key, path: '/api/video-chat/' + encodeURIComponent(courseId) + '/videos/' + encodeURIComponent(videoId) };
      this.preview = this.previews?.get(key) || null;
      this.data = { revision: 0, transcript: null, messages: [] };
      find('#chatQuestion').value = this.drafts.get(key) || '';
      find('#chatConsent').checked = false;
      find('#chatRights').checked = false;
      find('#chatUpload').value = '';
      find('#chatStatus').textContent = '';
      find('#chatError').textContent = '';
      this.render();
      if (this.opened) { this.options.setNotesOpen(false); this.load(); }
    }

    open() {
      if (!this.identity) return;
      if (!this.opened) this.notesWasOpen = this.options.notesOpen();
      this.options.setNotesOpen(false);
      this.opened = true;
      find('#videoChatPanel').classList.remove('hidden');
      find('#studyLayout').classList.add('chat-open');
      this.options.onOpen();
      this.controls();
      this.load();
    }

    selectTab(tab) {
      if (tab === 'chat') {
        if (!this.opened) this.open();
      } else {
        this.hide(false);
        this.options.setNotesOpen(true);
        this.options.onNotesOpen?.();
        this.controls();
      }
    }

    hide(restoreNotes = true) {
      if (!this.opened) return;
      this.opened = false;
      find('#videoChatPanel').classList.add('hidden');
      find('#studyLayout').classList.remove('chat-open');
      if (restoreNotes) this.options.setNotesOpen(this.notesWasOpen);
      this.controls();
    }

    leave() {
      this.cancel();
      this.generation++;
      this.pending = null;
      this.provisional = null;
      this.hide(false);
      this.identity = null;
    }

    reset() {
      this.session++;
      this.configController?.abort();
      this.leave();
      this.drafts.clear();
      this.previews?.clear();
      this.preview = null;
      this.data = { revision: 0, transcript: null, messages: [] };
      this.config = { available: false, reason: 'Video chat is not configured.' };
      find('#chatQuestion').value = '';
      find('#chatConsent').checked = false;
      this.render();
    }

    cancel() {
      const pending = this.pending;
      if (!pending) return;
      pending.controller.abort();
      if (pending.requestId) fetch(pending.path + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: pending.requestId }), keepalive: true,
        ...(pending.owner ? { headers: { 'Content-Type': 'application/json', 'X-Video-Chat-Account': String(pending.owner) } } : {}) }).catch(() => {});
    }

    async perform(label, operation, requestId) {
      if (!this.identity || this.pending || this.preview?.busy) return;
      const generation = this.generation;
      const session = this.session;
      const owner = this.options.getUser?.()?.id;
      const identity = { ...this.identity };
      const controller = new AbortController();
      const pending = { controller, path: identity.path, requestId, owner };
      this.pending = pending;
      find('#chatStatus').textContent = label;
      find('#chatError').textContent = '';
      this.controls();
      const timer = setTimeout(() => controller.abort(), 75000);
      const current = () => generation === this.generation && session === this.session && owner === this.options.getUser?.()?.id && this.identity?.key === identity.key;
      const request = async (suffix = '', body, method = body ? 'POST' : 'GET', onEvent) => {
        controller.signal.throwIfAborted();
        const response = await fetch(identity.path + suffix, { method, signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: onEvent ? 'application/x-ndjson, application/json' : 'application/json',
            ...(owner ? { 'X-Video-Chat-Account': String(owner) } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const streaming = response.ok && response.headers?.get('content-type')?.split(';')[0] === 'application/x-ndjson';
        const result = streaming ? await readChatStream(response, controller.signal, async event => {
          if (!current()) throw new DOMException('Chat changed', 'AbortError');
          await onEvent?.(event);
        }) : response.status === 204 ? null : await response.json();
        if (!current()) throw new DOMException('Chat changed', 'AbortError');
        if (!response.ok) throw Object.assign(new Error(result?.error || 'Chat request failed.'), { status: response.status, body: result, code: result?.code });
        return result;
      };
      try {
        const result = await operation(request, identity, controller.signal);
        if (!current() || controller.signal.aborted) return;
        if (result) {
          this.data = result;
          this.reconcilePreview();
        }
        find('#chatStatus').textContent = 'Ready';
        this.render();
      } catch (error) {
        if (!current()) return;
        if (error.status === 401 || error.code === 'SESSION_CHANGED') {
          this.reset();
          this.options.onSessionChanged?.();
          this.options.showError('Your account or session changed. Sign in again before using chat.');
          return;
        }
        if (requestId) {
          this.needsReload = true;
          if (this.provisional) this.provisional.interrupted = true;
          this.render();
        }
        find('#chatStatus').textContent = controller.signal.aborted ? 'Canceled' : 'Unavailable';
        find('#chatError').textContent = controller.signal.aborted ? 'Request canceled. Reload chat before continuing; a submitted request may still incur charges.' : error.message;
      } finally {
        clearTimeout(timer);
        if (this.pending === pending) { this.pending = null; this.render(); }
      }
    }

    load() {
      return this.perform('Loading chat...', async request => {
        const data = await request();
        this.needsReload = false;
        this.provisional = null;
        return data;
      });
    }

    async prepare(source, file) {
      if (!this.identity || this.pending || (source === 'upload' && !file)) return;
      if (!find('#chatRights').checked) { find('#chatError').textContent = 'Confirm permission to use these captions.'; return; }
      if (file && file.size > 1024 * 1024) { find('#chatError').textContent = 'Choose an SRT or VTT file up to 1 MB.'; find('#chatUpload').value = ''; return; }
      const replace = !!this.data.transcript;
      if (replace && !confirm('Replace this transcript and clear its chat history?')) { find('#chatUpload').value = ''; return; }
      const revision = this.data.revision;
      const language = find('#chatLanguage').value.trim() || 'und';
      return this.perform('Preparing transcript...', async (request, identity, signal) => {
        const text = file ? await file.text() : undefined;
        if (!(await this.options.ensureCourseSaved())) throw new Error('Save the course before loading captions.');
        signal.throwIfAborted();
        const data = await request('/transcript', { source, text, language, rightsConfirmed: true, replace, revision }, 'PUT');
        return data;
      });
    }

    ask({ scope = find('#chatScope')?.value || 'video', mode = 'answer', question = find('#chatQuestion').value.trim() } = {}) {
      if (!this.identity || this.pending || this.needsReload || !question || !this.data.transcript || !find('#chatConsent').checked) return;
      const revision = this.data.revision;
      const requestId = crypto.randomUUID();
      const playhead = this.options.getTime(this.identity.courseId, this.identity.videoId);
      if (scope === 'moment' && !Number.isSafeInteger(playhead)) {
        find('#chatError').textContent = 'Wait for playback to load or choose Whole video.';
        return;
      }
      const messages = this.data.messages;
      const transcript = this.data.transcript;
      const sourceGeneration = this.data.generation;
      const messageIds = scope === 'discussion' ? messages.map(message => message.id) : undefined;
      if (scope === 'discussion' && !messageIds.length) { find('#chatError').textContent = 'There are no completed messages to summarize.'; return; }
      this.provisional = { question, answer: '', context: { scope, playhead, mode } };
      this.render();
      return this.perform('Preparing answer...', async (request, identity, signal) => {
        const result = await request('/messages', { question, playhead, requestId, revision, consent: true, scope, mode, sourceHash: transcript.hash, messageIds }, 'POST', event => {
          if (event.type === 'start') {
            if (event.requestId !== requestId || (!event.replay && (event.sourceHash !== transcript.hash || event.generation !== sourceGeneration))) {
              throw new Error('The video source changed. Reload chat.');
            }
          } else if (event.type === 'text') {
            const atBottom = this.atBottom();
            if (!this.provisional.answer) find('#chatStatus').textContent = 'Answering...';
            this.provisional.answer += event.text;
            find('#chatLiveAnswer').textContent = this.provisional.answer;
            this.follow(atBottom);
          }
        });
        signal.throwIfAborted();
        const message = result?.message;
        if (!message || message.id !== requestId || message.question !== question.trim() || typeof message.answer !== 'string' || !message.answer.trim() || message.answer.length > 16000 ||
            typeof message.supported !== 'boolean' || !Array.isArray(message.citations) || message.citations.length > 8 ||
            message.citations.some(citation => !/^s[1-9]\d{0,4}$/.test(citation.id) || !Number.isSafeInteger(citation.seconds) || citation.seconds < 0 || citation.seconds > 14400) ||
            (message.supported && !message.citations.length) || (!message.supported && (message.citations.length || message.proposal)) ||
            !Number.isSafeInteger(result.revision) || result.revision <= revision) {
          throw new Error('The completed answer could not be verified. Reload chat.');
        }
        if (message.proposal) {
            if (message.proposal.id !== `p_${requestId}` || message.proposal.courseId !== identity.courseId || message.proposal.videoId !== identity.videoId ||
              message.proposal.sourceHash !== transcript.hash || typeof message.proposal.suggested !== 'boolean') throw new Error('The note destination changed.');
          window.NotebookModel.generatedBlocks(message.proposal);
          if (message.proposal.suggested) this.offerPreview(message, false);
        }
        this.provisional = null;
        if (this.identity?.key === identity.key && mode === 'answer' && find('#chatQuestion').value.trim() === question.trim()) {
          find('#chatQuestion').value = '';
          this.drafts.delete(identity.key);
        }
        return { ...this.data, revision: result.revision, messages: messages.some(message => message.id === result.message.id) ? messages : [...messages, result.message] };
      }, requestId);
    }

    clear(removeTranscript) {
      if (this.pending || !confirm(removeTranscript ? 'Remove this transcript and its chat history?' : 'Clear the chat history for this video? The transcript will remain.')) return;
      const revision = this.data.revision;
      return this.perform('Clearing chat...', request => request('', { revision, removeTranscript }, 'DELETE'));
    }

    offerPreview(message, render = true) {
      if (!message.supported || !message.proposal || !this.identity || !this.data.transcript) return;
      const ownerId = this.options.getUser?.()?.id;
      if (!ownerId || message.proposal.sourceHash !== this.data.transcript.hash || message.proposal.courseId !== this.identity.courseId || message.proposal.videoId !== this.identity.videoId) return;
      window.NotebookModel.generatedBlocks(message.proposal);
      if (this.preview?.busy) return;
      const existing = this.previews.get(this.identity.key);
        if (existing && existing.proposal.id !== message.proposal.id && !existing.saved &&
          (!render || !confirm('Replace your current note preview and its edits?'))) return;
      if (existing?.proposal.id === message.proposal.id && existing.sourceGeneration === this.data.generation) this.preview = existing;
      else {
        this.preview = { proposal: structuredClone(message.proposal), identity: { ...this.identity }, ownerId, sourceGeneration: this.data.generation,
          courseTitle: this.options.getCourseTitle?.(this.identity.courseId) || this.identity.courseId, status: 'Preview', busy: false, saved: false, appended: false };
        this.previews.set(this.identity.key, this.preview);
      }
      if (render) this.render();
    }

    reconcilePreview() {
      const preview = this.preview;
      if (!preview) return;
      if (preview.ownerId !== this.options.getUser?.()?.id || preview.sourceGeneration !== this.data.generation ||
          preview.proposal.sourceHash !== this.data.transcript?.hash || !this.data.messages.some(message => `p_${message.id}` === preview.proposal.id)) {
        this.previews.delete(preview.identity.key);
        this.preview = null;
        find('#chatError').textContent = 'The source or discussion changed. The previous preview is no longer available.';
      }
    }

    cancelPreview() {
      if (!this.preview || this.preview.busy) return;
      this.previews.delete(this.preview.identity.key);
      this.preview = null;
      this.render();
    }

    async appendPreview() {
      const preview = this.preview;
      if (!preview || preview.busy || preview.saved || preview.invalid || this.pending) return;
      const session = this.session;
      const generation = this.generation;
      const current = () => this.preview === preview && session === this.session && generation === this.generation &&
        preview.ownerId === this.options.getUser?.()?.id && preview.identity.key === this.identity?.key &&
        preview.proposal.sourceHash === this.data.transcript?.hash && preview.sourceGeneration === this.data.generation;
      preview.busy = true;
      preview.status = preview.appended ? 'Saving...' : 'Checking destination...';
      this.render();
      try {
        if (!this.options.appendGeneratedNote) throw new Error('Notes are unavailable. Reload this video.');
        const result = await this.options.appendGeneratedNote(preview.proposal, {
          ownerId: preview.ownerId, sourceGeneration: preview.sourceGeneration, isCurrent: current,
        });
        if (!current()) return;
        preview.appended = true;
        preview.saved = result.saved;
        preview.status = result.saved ? 'Saved to notes' : result.error || 'Unsaved. Retry save.';
      } catch (error) {
        if (!current()) return;
        preview.status = error.message;
        if (error.body?.code === 'CHAT_CHANGED') preview.invalid = true;
        if (error.status === 401 || error.body?.code === 'SESSION_CHANGED') { this.reset(); this.options.onSessionChanged?.(); this.options.showError('Your session changed. Sign in again.'); }
      } finally {
        preview.busy = false;
        if (current()) this.render();
      }
    }

    renderPreview(preview) {
      const section = textNode('section', '', 'chat-preview');
      section.setAttribute('aria-label', 'Note preview');
      const title = textNode('h4', 'Note preview');
      const destination = textNode('p', `${preview.courseTitle} / ${preview.identity.title} / ${preview.identity.videoId}`, 'chat-preview-destination');
      const source = textNode('p', `${this.data.transcript.source === 'youtube' ? 'YouTube captions' : 'Uploaded captions'} / ${this.data.transcript.language} / ${preview.proposal.sourceHash.slice(0, 12)}`, 'chat-context-label');
      section.append(title, destination, source);
      preview.proposal.blocks.forEach((block, index) => {
        const label = textNode('label', block.kind === 'heading' ? 'Heading' : `Note block ${index + 1}`);
        const input = document.createElement('textarea');
        input.rows = block.kind === 'heading' ? 2 : 4;
        input.maxLength = 4000;
        input.value = block.text;
        input.disabled = preview.busy || preview.saved || preview.appended || preview.invalid || !!this.pending;
        input.addEventListener('input', () => { block.text = input.value; });
        label.append(input);
        section.append(label);
        const references = textNode('p', '', 'chat-context-label');
        references.textContent = block.segmentIds.length ? `${block.segmentIds.join(', ')}${block.seconds !== null ? ' / ' + this.options.formatTime(block.seconds) : ''}` :
          block.messageIds.length ? `Discussion / ${block.messageIds.length} completed message${block.messageIds.length === 1 ? '' : 's'}` : 'Heading';
        section.append(references);
      });
      const status = textNode('p', preview.status, 'chat-preview-status');
      status.setAttribute('role', 'status');
      const actions = textNode('div', '', 'chat-preview-actions');
      const append = textNode('button', preview.saved ? 'Saved' : preview.appended ? 'Retry save' : 'Append to notes', 'btn slim');
      append.type = 'button';
      append.disabled = preview.busy || preview.saved || preview.invalid || !!this.pending;
      append.addEventListener('click', () => this.appendPreview());
      const cancel = textNode('button', preview.appended ? 'Close preview' : 'Cancel', 'btn ghost slim');
      cancel.type = 'button';
      cancel.disabled = preview.busy;
      cancel.addEventListener('click', () => this.cancelPreview());
      actions.append(append, cancel);
      if (preview.appended) {
        const view = textNode('button', 'View notes', 'btn ghost slim');
        view.type = 'button';
        view.addEventListener('click', () => this.selectTab('notes'));
        actions.append(view);
      }
      section.append(status, actions);
      return section;
    }

    controls() {
      const busy = !!this.pending || !!this.preview?.busy;
      const available = !!this.config.available;
      const toggle = find('#videoChatBtn');
      toggle.setAttribute('aria-disabled', String(!available));
      toggle.setAttribute('aria-expanded', String(this.opened));
      toggle.title = available ? this.opened ? 'Hide video chat' : 'Ask about video' : this.config.reason;
      toggle.setAttribute('aria-label', available ? 'Ask about video' : this.config.reason);
      find('#chatSend').disabled = busy || this.needsReload || !available || !this.data.transcript || !find('#chatConsent').checked || !find('#chatQuestion').value.trim();
      find('#chatQuestion').disabled = busy || !available || !this.data.transcript;
      find('#chatScope').disabled = busy;
      find('#chatSummarize').disabled = busy || this.needsReload || !available || !this.data.transcript || !find('#chatConsent').checked ||
        (find('#chatScope').value === 'discussion' && !this.data.messages.length);
      find('#chatLoadCaptions').disabled = busy || !available || !this.config.autoCaptions || !find('#chatRights').checked;
      find('#chatUpload').disabled = busy || !available || !find('#chatRights').checked;
      find('#chatLanguage').disabled = busy;
      find('#chatClear').disabled = busy || !this.data.messages.length;
      find('#chatRemoveTranscript').disabled = busy || !this.data.transcript;
      find('#chatReload').disabled = busy;
      find('#chatCancel').classList.toggle('hidden', !this.pending?.requestId);
      find('#chatMessages').setAttribute('aria-busy', String(busy));
      for (const [selector, selected] of [['#studyChatTab', this.opened], ['#studyNotesTab', !this.opened]]) {
        const tab = find(selector);
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      find('#chatContextTime').textContent = this.provisional ? this.contextLabel(this.provisional.context) :
        find('#chatScope').value === 'moment' ? '120s before / 60s after the sent playhead' : find('#chatScope').value === 'discussion' ? `${this.data.messages.length} completed exchanges` : 'Full permitted transcript';
    }

    contextLabel(context) {
      if (!context) return 'Whole video';
      return (context.scope === 'moment' ? `Current moment${Number.isSafeInteger(context.playhead) ? ' / ' + this.options.formatTime(context.playhead) : ''}` :
        context.scope === 'discussion' ? 'Completed discussion' : 'Whole video') + (context.mode === 'note_draft' ? ' / Note preview' : '');
    }

    atBottom() {
      const messages = find('#chatMessages');
      return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 40;
    }

    follow(atBottom) {
      if (atBottom) find('#chatMessages').scrollTop = find('#chatMessages').scrollHeight;
      find('#chatLatest')?.classList.toggle('hidden', atBottom);
    }

    render() {
      find('#chatVideoTitle').textContent = this.identity?.title || 'Video chat';
      const transcript = this.data.transcript;
      find('#chatSourceInfo').textContent = transcript ? `${transcript.source === 'youtube' ? 'YouTube captions' : 'Uploaded captions'} / ${transcript.language} / ${transcript.segmentCount} segments` : 'No transcript loaded';
      find('#chatSource').open = !transcript;
      const messages = find('#chatMessages');
      const atBottom = this.atBottom();
      const scrollTop = messages.scrollTop;
      messages.replaceChildren();
      for (const message of this.data.messages) {
        const article = document.createElement('article');
        article.className = 'chat-exchange';
        article.append(textNode('p', this.contextLabel(message.context), 'chat-context-label'), textNode('h4', 'You'), textNode('p', message.question, 'chat-question'), textNode('h4', 'AI answer'), textNode('p', message.answer, 'chat-answer'));
        const citations = document.createElement('div');
        citations.className = 'chat-citations';
        const identity = { ...this.identity };
        for (const citation of message.citations || []) {
          const button = textNode('button', this.options.formatTime(citation.seconds));
          button.type = 'button';
          button.title = citation.text;
          button.setAttribute('aria-label', 'Open source at ' + this.options.formatTime(citation.seconds));
          button.addEventListener('click', () => this.options.onJump(identity.courseId, identity.videoId, citation.seconds));
          citations.append(button);
        }
        article.append(citations);
        if (message.supported && message.proposal) {
          const add = textNode('button', 'Add to notes', 'btn ghost slim chat-add-note');
          add.type = 'button';
          add.disabled = !!this.pending || !!this.preview?.busy || this.needsReload;
          add.addEventListener('click', () => this.offerPreview(message));
          article.append(add);
        }
        messages.append(article);
        if (this.preview?.proposal.id === `p_${message.id}`) messages.append(this.renderPreview(this.preview));
      }
      if (this.provisional) {
        const article = textNode('article', '', 'chat-exchange chat-provisional');
        article.setAttribute('aria-live', 'off');
        const answer = textNode('p', this.provisional.answer, 'chat-answer');
        answer.id = 'chatLiveAnswer';
        article.append(textNode('h4', 'You'), textNode('p', this.provisional.question, 'chat-question'),
          textNode('h4', this.provisional.interrupted ? 'Interrupted answer' : 'Answer in progress'), answer);
        messages.append(article);
      }
      if (!this.data.messages.length && !this.provisional) messages.append(textNode('p', 'No questions yet.', 'muted'));
      if (!atBottom) messages.scrollTop = scrollTop;
      this.follow(atBottom);
      this.controls();
    }
  }
  window.VideoChat = VideoChat;
  window.VideoChat.readStream = readChatStream;
})();