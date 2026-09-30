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
      this.permissions = new Set();
      this.selected = new Map();
      this.newChatRequests = new Map();
      this.renaming = false;
      this.composing = false;
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
      find('#chatNew').addEventListener('click', () => this.newConversation());
      find('#chatHistory').addEventListener('change', event => this.load(event.target.value));
      find('#chatRename').addEventListener('click', () => {
        if (this.pending || !this.data.conversationId) return;
        this.renaming = true;
        find('#chatMenu').open = false;
        find('#chatName').value = this.data.title || 'New chat';
        this.controls();
        find('#chatName').focus();
      });
      find('#chatRenameForm').addEventListener('submit', event => { event.preventDefault(); this.renameConversation(); });
      find('#chatRenameCancel').addEventListener('click', () => { this.renaming = false; this.controls(); find('#chatHistory').focus(); });
      find('#chatDelete').addEventListener('click', () => this.deleteConversation());
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
      find('#chatClear').addEventListener('click', () => this.clear(false));
      find('#chatPrivacy').addEventListener('click', () => {
        if (!this.identity || this.pending) return;
        this.permissions.delete(this.identity.key);
        find('#chatMenu').open = false;
        find('#chatStatus').textContent = 'AI permission reset';
      });
      find('#chatForm').addEventListener('submit', event => { event.preventDefault(); this.ask(); });
      find('#chatQuestion').addEventListener('compositionstart', () => { this.composing = true; });
      find('#chatQuestion').addEventListener('compositionend', () => { this.composing = false; });
      find('#chatQuestion').addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || this.composing || event.keyCode === 229) return;
        event.preventDefault();
        if (!event.repeat) this.ask();
      });
      find('#chatQuestion').addEventListener('input', () => {
        if (this.identity) this.drafts.set(this.threadKey(), find('#chatQuestion').value);
        this.controls();
      });
      find('#videoChatPanel').addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault(); event.stopPropagation();
        if (this.renaming) { this.renaming = false; this.controls(); find('#chatHistory').focus(); }
        else if (find('#chatMenu').open) { find('#chatMenu').open = false; find('#chatMenuToggle').focus(); }
        else { this.hide(); find('#videoChatBtn').focus(); }
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
      if (this.identity) this.drafts.set(this.threadKey(), find('#chatQuestion').value);
      this.cancel();
      this.generation++;
      this.pending = null;
      this.provisional = null;
      this.needsReload = false;
      this.identity = { courseId, videoId, title, key, conversationId: this.selected?.get(key) || null,
        path: '/api/video-chat/' + encodeURIComponent(courseId) + '/videos/' + encodeURIComponent(videoId) };
      this.preview = this.previews?.get(this.threadKey()) || null;
      this.data = { revision: 0, transcript: null, messages: [], conversations: [], conversationId: this.identity.conversationId };
      this.renaming = false;
      this.composing = false;
      this.historySignature = '';
      find('#chatQuestion').value = this.drafts.get(this.threadKey()) || '';
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
      if (this.identity) this.drafts.set(this.threadKey(), find('#chatQuestion').value);
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
      this.permissions?.clear();
      this.selected?.clear();
      this.newChatRequests?.clear();
      this.renaming = false;
      this.preview = null;
      this.data = { revision: 0, transcript: null, messages: [] };
      this.config = { available: false, reason: 'Video chat is not configured.' };
      find('#chatQuestion').value = '';
      this.render();
    }

    cancel() {
      const pending = this.pending;
      if (!pending) return;
      pending.controller.abort();
      if (pending.requestId) fetch(pending.path + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: pending.requestId, conversationId: pending.conversationId || undefined }), keepalive: true,
        ...(pending.owner ? { headers: { 'Content-Type': 'application/json', 'X-Video-Chat-Account': String(pending.owner) } } : {}) }).catch(() => {});
    }

    async perform(label, operation, requestId) {
      if (!this.identity || this.pending || this.preview?.busy) return;
      const generation = this.generation;
      const session = this.session;
      const owner = this.options.getUser?.()?.id;
      const identity = { ...this.identity };
      const controller = new AbortController();
      const pending = { controller, path: identity.path, conversationId: identity.conversationId, requestId, owner, dispatched: false };
      this.pending = pending;
      find('#chatStatus').textContent = label;
      find('#chatError').textContent = '';
      this.controls();
      const timer = setTimeout(() => controller.abort(), 75000);
      const current = () => generation === this.generation && session === this.session && owner === this.options.getUser?.()?.id &&
        this.identity?.key === identity.key && this.identity?.conversationId === identity.conversationId;
      const request = async (suffix = '', body, method = body ? 'POST' : 'GET', onEvent) => {
        controller.signal.throwIfAborted();
        const response = await fetch(identity.path + suffix, { method, signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: onEvent ? 'application/x-ndjson, application/json' : 'application/json',
            ...(owner ? { 'X-Video-Chat-Account': String(owner) } : {}) },
          body: body ? JSON.stringify({ conversationId: identity.conversationId || undefined, ...body }) : undefined });
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
          this.applyData(result);
          this.reconcilePreview();
          const completed = requestId && result.messages?.find(message => message.id === requestId);
          if (completed?.proposal?.suggested) this.offerPreview(completed, false);
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
          this.needsReload = pending.dispatched;
          if (!pending.dispatched) this.provisional = null;
          else if (this.provisional) this.provisional.interrupted = true;
          this.render();
        }
        if (error.code === 'CHAT_NOT_FOUND' && !requestId) {
          this.selected?.delete(identity.key);
          this.applyData({ ...this.data, conversationId: null, title: 'New chat', messages: [], generation: '' });
        }
        find('#chatStatus').textContent = controller.signal.aborted ? 'Canceled' : 'Unavailable';
        find('#chatError').textContent = controller.signal.aborted
          ? pending.dispatched ? 'Request canceled. Reload chat before continuing; a submitted request may still incur charges.' : 'Canceled. Your message has not been sent.'
          : error.message;
      } finally {
        clearTimeout(timer);
        if (this.pending === pending) { this.pending = null; this.render(); }
      }
    }

    threadKey(conversationId = this.identity?.conversationId) {
      return (this.identity?.key || '') + '/' + (conversationId || 'draft');
    }

    applyData(data) {
      const conversationId = data.conversationId ?? null;
      const previousKey = this.threadKey();
      if ((this.identity?.conversationId || null) !== conversationId) {
        this.drafts.set(previousKey, find('#chatQuestion').value);
        this.generation++;
        this.renaming = false;
        this.needsReload = false;
        this.provisional = null;
        if (this.identity) this.identity.conversationId = conversationId;
        find('#chatQuestion').value = this.drafts.get(this.threadKey()) || '';
        this.preview = this.previews?.get(this.threadKey()) || null;
      }
      this.data = { ...data, conversationId, conversations: data.conversations || [] };
      if (data.config) this.config = data.config;
      if (this.identity && conversationId) this.selected?.set(this.identity.key, conversationId);
    }

    load(conversationId = this.identity?.conversationId) {
      find('#chatMenu').open = false;
      return this.perform('Loading chat...', async request => {
        let data;
        try { data = await request(conversationId ? '?conversationId=' + encodeURIComponent(conversationId) : ''); }
        catch (error) {
          if (error.code !== 'CHAT_NOT_FOUND' || !conversationId) throw error;
          data = await request();
        }
        this.needsReload = false;
        this.provisional = null;
        return data;
      });
    }

    newConversation() {
      if (!this.identity || this.pending || this.preview?.busy) return;
      find('#chatMenu').open = false;
      const key = this.identity.key;
      const id = this.newChatRequests.get(key) || crypto.randomUUID();
      this.newChatRequests.set(key, id);
      const revision = this.data.revision;
      return this.perform('Creating chat...', async (request, identity, signal) => {
        if (!(await this.options.ensureCourseSaved())) throw new Error('Save the course before starting a chat.');
        signal.throwIfAborted();
        const data = await request('/conversations', { id, revision });
        this.newChatRequests.delete(key);
        this.needsReload = false;
        return data;
      });
    }

    renameConversation() {
      if (!this.data.conversationId || this.pending) return;
      const title = find('#chatName').value.trim();
      if (!title || title.length > 80) { find('#chatError').textContent = 'Use a chat name between 1 and 80 characters.'; return; }
      return this.perform('Renaming chat...', async request => {
        const data = await request('/conversations/' + this.data.conversationId, { title, revision: this.data.revision }, 'PATCH');
        this.renaming = false;
        return data;
      });
    }

    deleteConversation() {
      if (!this.data.conversationId || this.pending || this.preview?.busy || !confirm('Delete this conversation? Other chats and the video transcript will remain.')) return;
      find('#chatMenu').open = false;
      const key = this.threadKey();
      return this.perform('Deleting chat...', async request => {
        const data = await request('/conversations/' + this.data.conversationId, { revision: this.data.revision }, 'DELETE');
        this.drafts.delete(key);
        this.previews.delete(key);
        find('#chatQuestion').value = '';
        return data;
      });
    }

    ask({ scope = 'video', mode = 'answer', question = find('#chatQuestion').value.trim() } = {}) {
      if (!this.identity || this.pending || this.composing || this.needsReload || !question || !this.config.available) return;
      const requestId = crypto.randomUUID();
      const playhead = this.options.getTime(this.identity.courseId, this.identity.videoId);
      if (scope === 'moment' && !Number.isSafeInteger(playhead)) {
        find('#chatError').textContent = 'Wait for playback to load or choose Whole video.';
        return;
      }
      const messages = this.data.messages;
      const messageIds = scope === 'discussion' ? messages.map(message => message.id) : undefined;
      if (scope === 'discussion' && !messageIds.length) { find('#chatError').textContent = 'There are no completed messages to summarize.'; return; }
      if (!this.permissions.has(this.identity.key)) {
        if (!confirm('Use AI chat for this video? Captions and this conversation will be sent to Google. Continue only if you have permission to use and share this content.')) return;
        this.permissions.add(this.identity.key);
      }
      this.provisional = { question, answer: '', context: { scope, playhead, mode } };
      this.render();
      return this.perform('Preparing answer...', async (request, identity, signal) => {
        let data = this.data;
        if (!data.transcript) data = await request(identity.conversationId ? '?conversationId=' + encodeURIComponent(identity.conversationId) : '');
        if (!data.transcript) {
          if (!this.config.autoCaptions) throw new Error('AI chat cannot access this video yet. Please try another video.');
          find('#chatStatus').textContent = 'Preparing video...';
          if (!(await this.options.ensureCourseSaved())) throw new Error('Save the video before starting a conversation.');
          signal.throwIfAborted();
          try { data = await request('/transcript', { source: 'youtube', rightsConfirmed: true, revision: data.revision }, 'PUT'); }
          catch (error) {
            if (['CAPTIONS_UNAVAILABLE', 'AUTO_CAPTIONS_DISABLED', 'CAPTIONS_TOO_LARGE'].includes(error.code)) {
              error.message = 'I could not access captions for this video. Please try another video.';
            }
            if (error.code === 'RATE_LIMITED') error.message = 'Please wait a moment before trying this video again.';
            throw error;
          }
        }
        if (!data.conversationId) {
          const id = this.newChatRequests.get(identity.key) || crypto.randomUUID();
          this.newChatRequests.set(identity.key, id);
          data = await request('/conversations', { id, revision: data.revision });
          this.newChatRequests.delete(identity.key);
        }
        const { transcript, revision, generation: sourceGeneration, conversationId } = data;
        if (!transcript?.hash || !conversationId || !Number.isSafeInteger(revision)) throw new Error('This video could not be prepared for chat. Please try again.');
        this.pending.conversationId = conversationId;
        this.pending.dispatched = true;
        const result = await request('/messages', { question, playhead, requestId, revision, conversationId, consent: true, scope, mode, sourceHash: transcript.hash, messageIds }, 'POST', event => {
          if (event.type === 'start') {
            if (event.requestId !== requestId || event.conversationId !== conversationId ||
                (!event.replay && (event.sourceHash !== transcript.hash || event.generation !== sourceGeneration))) {
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
        if (!message || message.id !== requestId || result.conversationId !== conversationId || message.question !== question.trim() || typeof message.answer !== 'string' || !message.answer.trim() || message.answer.length > 16000 ||
            typeof message.supported !== 'boolean' || !Array.isArray(message.citations) || message.citations.length > 8 ||
            message.citations.some(citation => !/^s[1-9]\d{0,4}$/.test(citation.id) || !Number.isSafeInteger(citation.seconds) || citation.seconds < 0 || citation.seconds > 14400) ||
            (message.followUps !== undefined && (!Array.isArray(message.followUps) || message.followUps.length > 2 ||
              message.followUps.some(question => typeof question !== 'string' || !question.trim() || question.length > 160 || question.includes('\u0000')))) ||
            (message.supported && !message.citations.length) || (!message.supported && (message.citations.length || message.proposal)) ||
            !Number.isSafeInteger(result.revision) || result.revision <= revision) {
          throw new Error('The completed answer could not be verified. Reload chat.');
        }
        if (message.proposal) {
            if (message.proposal.id !== `p_${requestId}` || message.proposal.courseId !== identity.courseId || message.proposal.videoId !== identity.videoId ||
              message.proposal.conversationId !== conversationId || message.proposal.sourceHash !== transcript.hash || typeof message.proposal.suggested !== 'boolean') throw new Error('The note destination changed.');
          window.NotebookModel.generatedBlocks(message.proposal);
        }
        this.provisional = null;
        if (this.identity?.key === identity.key && mode === 'answer' && find('#chatQuestion').value.trim() === question.trim()) {
          find('#chatQuestion').value = '';
          this.drafts.delete(this.threadKey());
        }
        return { ...data, revision: result.revision, title: result.title || data.title,
          conversations: data.conversations.map(conversation => conversation.id === result.conversationId
            ? { ...conversation, title: result.title || conversation.title, messageCount: messages.length + 1 } : conversation),
          messages: messages.some(message => message.id === result.message.id) ? messages : [...messages, result.message] };
      }, requestId);
    }

    clear(removeTranscript) {
      if (this.pending || !confirm(removeTranscript ? 'Remove this transcript and all conversations for this video?' : 'Clear this conversation? Other chats and the transcript will remain.')) return;
      find('#chatMenu').open = false;
      const revision = this.data.revision;
      return this.perform('Clearing chat...', request => request('', { revision, removeTranscript }, 'DELETE'));
    }

    offerPreview(message, render = true) {
      if (!message.supported || !message.proposal || !this.identity || !this.data.transcript) return;
      const ownerId = this.options.getUser?.()?.id;
        if (!ownerId || message.proposal.sourceHash !== this.data.transcript.hash || message.proposal.courseId !== this.identity.courseId || message.proposal.videoId !== this.identity.videoId ||
          (message.proposal.conversationId || 'default') !== (this.data.conversationId || 'default')) return;
      window.NotebookModel.generatedBlocks(message.proposal);
      if (this.preview?.busy) return;
      const key = this.threadKey();
      const existing = this.previews.get(key);
        if (existing && existing.proposal.id !== message.proposal.id && !existing.saved &&
          (!render || !confirm('Replace your current note preview and its edits?'))) return;
      if (existing?.proposal.id === message.proposal.id && existing.sourceGeneration === this.data.generation) this.preview = existing;
      else {
        this.preview = { proposal: structuredClone(message.proposal), identity: { ...this.identity }, key, ownerId, sourceGeneration: this.data.generation,
          courseTitle: this.options.getCourseTitle?.(this.identity.courseId) || this.identity.courseId, status: 'Preview', busy: false, saved: false, appended: false };
        this.previews.set(key, this.preview);
      }
      if (render) this.render();
    }

    reconcilePreview() {
      const preview = this.preview;
      if (!preview) return;
      if (preview.ownerId !== this.options.getUser?.()?.id || preview.key !== this.threadKey() || preview.sourceGeneration !== this.data.generation ||
          preview.proposal.sourceHash !== this.data.transcript?.hash || !this.data.messages.some(message => `p_${message.id}` === preview.proposal.id)) {
        this.previews.delete(preview.key);
        this.preview = null;
        find('#chatError').textContent = 'The source or discussion changed. The previous preview is no longer available.';
      }
    }

    cancelPreview() {
      if (!this.preview || this.preview.busy) return;
      this.previews.delete(this.preview.key);
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
        preview.key === this.threadKey() &&
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
      const destination = textNode('p', `${preview.courseTitle} / ${preview.identity.title}`, 'chat-preview-destination');
      section.append(title, destination);
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
        references.textContent = block.seconds !== null ? 'Source ' + this.options.formatTime(block.seconds) : block.messageIds.length ? 'From this conversation' : '';
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
      find('#chatSend').disabled = busy || this.needsReload || !available || !find('#chatQuestion').value.trim();
      find('#chatQuestion').disabled = busy || !available;
      find('#chatHistory').disabled = busy || !this.data.conversations?.length;
      find('#chatHistory').value = this.data.conversationId || '';
      find('#chatNew').disabled = busy || !available || (this.data.conversations?.length || 0) >= (this.config.maxConversations || 20);
      find('#chatRename').disabled = busy || !this.data.conversationId;
      find('#chatDelete').disabled = busy || !this.data.conversationId;
      find('#chatRenameForm').classList.toggle('hidden', !this.renaming);
      find('#chatName').disabled = busy;
      find('#chatRenameSave').disabled = busy;
      find('#chatRenameCancel').disabled = busy;
      find('#chatPrivacy').disabled = busy;
      find('#chatClear').disabled = busy || !this.data.messages.length;
      find('#chatReload').disabled = busy;
      find('#chatCancel').classList.toggle('hidden', !this.pending?.requestId);
      find('#chatMessages').setAttribute('aria-busy', String(busy));
      for (const [selector, selected] of [['#studyChatTab', this.opened], ['#studyNotesTab', !this.opened]]) {
        const tab = find(selector);
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
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
      find('#chatVideoTitle').title = this.identity?.title || 'Video chat';
      const histories = this.data.conversations || [];
      const signature = JSON.stringify(histories.map(conversation => [conversation.id, conversation.title]));
      if (signature !== this.historySignature) {
        const options = histories.map(conversation => {
          const option = textNode('option', conversation.title);
          option.value = conversation.id;
          return option;
        });
        if (!options.length) { const option = textNode('option', 'New chat'); option.value = ''; options.push(option); }
        find('#chatHistory').replaceChildren(...options);
        this.historySignature = signature;
      }
      const messages = find('#chatMessages');
      const atBottom = this.atBottom();
      const scrollTop = messages.scrollTop;
      messages.replaceChildren();
      for (const message of this.data.messages) {
        const question = textNode('article', '', 'chat-turn chat-user');
        question.setAttribute('aria-label', 'Your message');
        question.append(textNode('h4', 'You', 'chat-author'), textNode('p', message.question, 'chat-question'));
        const article = textNode('article', '', 'chat-turn chat-assistant');
        article.setAttribute('aria-label', 'AI response');
        article.append(textNode('h4', 'Assistant', 'chat-author'), textNode('p', message.answer, 'chat-answer'));
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
        messages.append(question, article);
        if (this.preview?.proposal.id === `p_${message.id}`) messages.append(this.renderPreview(this.preview));
      }
      if (this.provisional) {
        const question = textNode('article', '', 'chat-turn chat-user');
        question.setAttribute('aria-label', 'Your message');
        question.append(textNode('h4', 'You', 'chat-author'), textNode('p', this.provisional.question, 'chat-question'));
        const article = textNode('article', '', 'chat-turn chat-assistant chat-provisional');
        article.setAttribute('aria-live', 'off');
        const answer = textNode('p', this.provisional.answer || (this.provisional.interrupted ? 'Response interrupted.' : 'Thinking...'), 'chat-answer');
        answer.id = 'chatLiveAnswer';
        article.append(textNode('h4', 'Assistant', 'chat-author'), answer);
        messages.append(question, article);
      }
      if (!this.data.messages.length && !this.provisional) {
        const empty = textNode('div', '', 'chat-empty');
        empty.id = 'chatStarters';
        for (const [label, question] of [['Summarize video', 'Summarize this video.'], ['Explain the key ideas', 'Explain the key ideas in this video.']]) {
          const action = textNode('button', label, 'chat-starter');
          action.type = 'button';
          action.disabled = !!this.pending || !this.config.available || this.needsReload;
          action.addEventListener('click', () => this.ask({ question }));
          empty.append(action);
        }
        messages.append(empty);
      }
      const suggestions = find('#chatFollowUps');
      suggestions.replaceChildren();
      const last = this.data.messages.at(-1);
      const showSuggestions = !!last?.supported && !this.pending && !this.provisional && !this.needsReload && !this.preview;
      suggestions.classList.toggle('hidden', !showSuggestions);
      if (showSuggestions) {
        const questions = Array.isArray(last.followUps) && last.followUps.length <= 2 && last.followUps.every(question => typeof question === 'string' && question.trim() && question.length <= 160)
          ? last.followUps : ['Can you explain that more simply?', 'Which part of the video supports that?'];
        for (const question of questions) {
          const button = textNode('button', question, 'chat-suggestion');
          button.type = 'button';
          button.disabled = !this.config.available;
          button.addEventListener('click', () => { if (this.data.messages.at(-1)?.id === last.id) this.ask({ question }); });
          suggestions.append(button);
        }
      }
      if (!atBottom) messages.scrollTop = scrollTop;
      this.follow(atBottom);
      this.controls();
    }
  }
  window.VideoChat = VideoChat;
  window.VideoChat.readStream = readChatStream;
})();