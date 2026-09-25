(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.NotebookModel = model;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const MAX_BYTES = 256 * 1024;
  const MAX_PROFILE_BYTES = 5 * 1024 * 1024;
  const MAX_DOCUMENTS = 20_000;
  const BLOCK_KEYS = new Set(['header', 'list', 'indent', 'code-block', 'blockId', 'anchorSeconds']);
  const INLINE_KEYS = new Set(['bold', 'italic', 'code', 'link']);
  const empty = () => ({ version: 1, ops: [{ insert: '\n' }] });
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const hasTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 31_536_000;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);

  function safeLink(value) {
    if (typeof value !== 'string' || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function lines(document) {
    const result = [];
    let line = { ops: [], attributes: {}, start: 0, text: '' };
    let position = 0;
    for (const operation of document?.ops || []) {
      const parts = operation.insert.split('\n');
      for (let index = 0; index < parts.length; index++) {
        const text = parts[index];
        if (text) {
          const attributes = Object.fromEntries(Object.entries(operation.attributes || {}).filter(([key]) => INLINE_KEYS.has(key)));
          line.ops.push(Object.keys(attributes).length ? { insert: text, attributes } : { insert: text });
          line.text += text;
          position += text.length;
        }
        if (index < parts.length - 1) {
          line.attributes = Object.fromEntries(Object.entries(operation.attributes || {}).filter(([key]) => BLOCK_KEYS.has(key)));
          if (typeof line.attributes.anchorSeconds === 'string' && /^\d+$/.test(line.attributes.anchorSeconds)) {
            line.attributes.anchorSeconds = Number(line.attributes.anchorSeconds);
          }
          line.length = position - line.start + 1;
          result.push(line);
          position++;
          line = { ops: [], attributes: {}, start: position, text: '' };
        }
      }
    }
    return result;
  }

  function fromLines(blocks) {
    const ops = [];
    for (const block of blocks) {
      ops.push(...block.ops);
      const attributes = block.attributes || {};
      ops.push(Object.keys(attributes).length ? { insert: '\n', attributes } : { insert: '\n' });
    }
    return { version: 1, ops: ops.length ? ops : [{ insert: '\n' }] };
  }

  function validate(value) {
    if (value === null) return null;
    if (!value || value.version !== 1 || !Array.isArray(value.ops) || !value.ops.length || value.ops.length > 10_000) {
      throw new Error('Invalid notebook document.');
    }
    if (bytes(value) > MAX_BYTES) throw new Error('A video note can contain up to 256 KiB.');
    const ops = value.ops.map(operation => {
      if (!operation || typeof operation.insert !== 'string' || !operation.insert || Object.keys(operation).some(key => !['insert', 'attributes'].includes(key))) {
        throw new Error('Notes must contain text, not embedded files or HTML objects.');
      }
      const attributes = {};
      if (operation.attributes !== undefined) {
        if (!operation.attributes || typeof operation.attributes !== 'object' || Array.isArray(operation.attributes)) throw new Error('Invalid note formatting.');
        for (const key of Object.keys(operation.attributes).sort()) {
          const setting = operation.attributes[key];
          if (!BLOCK_KEYS.has(key) && !INLINE_KEYS.has(key)) throw new Error('Unsupported note formatting.');
          if (BLOCK_KEYS.has(key) && operation.insert !== '\n') throw new Error('Block metadata must belong to a single paragraph.');
          if (key === 'header' && ![2, 3].includes(setting)) throw new Error('Invalid heading.');
          if (key === 'list' && !['ordered', 'bullet'].includes(setting)) throw new Error('Invalid list.');
          if (key === 'indent' && (!Number.isInteger(setting) || setting < 1 || setting > 4)) throw new Error('Lists support up to four indentation levels.');
          if (key === 'code-block' && ![true, 'plain'].includes(setting)) throw new Error('Invalid code block.');
          if (['bold', 'italic', 'code'].includes(key) && setting !== true) throw new Error('Invalid text formatting.');
          if (key === 'blockId' && (!validId(setting) || setting.length > 80)) throw new Error('Invalid paragraph identity.');
          if (key === 'anchorSeconds' && !hasTime(setting)) throw new Error('Invalid video timestamp.');
          if (key === 'link' && !safeLink(setting)) throw new Error('Links must use HTTP or HTTPS.');
          attributes[key] = key === 'link' ? safeLink(setting) : setting;
        }
      }
      return Object.keys(attributes).length ? { insert: operation.insert, attributes } : { insert: operation.insert };
    });
    if (!ops.at(-1).insert.endsWith('\n')) throw new Error('A note must end with a paragraph break.');
    const document = { version: 1, ops };
    const blocks = lines(document);
    if (blocks.length > 2000) throw new Error('A video note can contain up to 2,000 paragraphs.');
    const identities = new Set();
    for (const block of blocks) {
      const { blockId, anchorSeconds, header, list, indent } = block.attributes;
      if (block.text.trim() && !blockId) throw new Error('A written paragraph needs an identity.');
      if (blockId && identities.has(blockId)) throw new Error('Paragraph identities must be unique.');
      if (blockId) identities.add(blockId);
      if (anchorSeconds !== undefined && !blockId) throw new Error('A video timestamp needs a paragraph identity.');
      if ([header, list, block.attributes['code-block']].filter(Boolean).length > 1 || (indent && !list)) throw new Error('Incompatible paragraph formatting.');
    }
    return blocks.some(block => block.text.trim()) ? document : null;
  }

  function anchorChanges(previous, next, change, seconds, makeId) {
    const oldBlocks = lines(previous);
    const origins = [];
    for (const block of oldBlocks) {
      for (const character of block.text.split('')) origins.push(character.trim() ? block : null);
      origins.push(block.text.trim() ? block : null);
    }
    const moved = [];
    let cursor = 0;
    for (const operation of change.ops) {
      if (operation.retain) {
        for (let index = cursor; index < cursor + operation.retain; index++) moved.push(origins[index]);
        cursor += operation.retain;
      } else if (operation.delete) cursor += operation.delete;
      else if (typeof operation.insert === 'string') for (let index = 0; index < operation.insert.length; index++) moved.push(null);
    }
    for (let index = cursor; index < origins.length; index++) moved.push(origins[index]);
    const used = new Set();
    const blocks = lines(next);
    for (const block of blocks) {
      const textSource = moved.slice(block.start, block.start + block.text.length).find(Boolean);
      const endingSource = moved[block.start + block.text.length];
      const source = textSource || (endingSource && !used.has(endingSource.attributes.blockId) ? endingSource : null);
      const attributes = { ...block.attributes };
      delete attributes.blockId;
      delete attributes.anchorSeconds;
      if (block.text.trim()) {
        const oldId = source?.attributes.blockId;
        attributes.blockId = oldId && !used.has(oldId) ? oldId : makeId();
        const time = source ? source.attributes.anchorSeconds : seconds;
        if (hasTime(time)) attributes.anchorSeconds = time;
        used.add(attributes.blockId);
      }
      block.attributes = attributes;
    }
    return fromLines(blocks);
  }

  function generatedBlocks(proposal) {
    if (!proposal || !/^p_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(proposal.id) ||
        !validId(proposal.courseId) || !/^[A-Za-z0-9_-]{11}$/.test(proposal.videoId || '') || !/^[a-f0-9]{64}$/.test(proposal.sourceHash || '') ||
        !Array.isArray(proposal.blocks) || !proposal.blocks.length || proposal.blocks.length > 12) throw new Error('The note preview is invalid. Reload chat.');
    let length = 0;
    const blocks = proposal.blocks.flatMap((block, index) => {
      if (!block || !['paragraph', 'heading'].includes(block.kind) || typeof block.text !== 'string' || !block.text.trim() || block.text.length > 4000 ||
          (length += block.text.length) > 16000 || block.text.includes('\u0000') ||
          !Array.isArray(block.segmentIds) || block.segmentIds.length > 8 || block.segmentIds.some(id => typeof id !== 'string' || !/^s[1-9]\d{0,4}$/.test(id)) ||
          !Array.isArray(block.messageIds) || block.messageIds.length > 8 || block.messageIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) ||
          (block.seconds !== null && (!hasTime(block.seconds) || block.seconds > 14400 || !block.segmentIds.length || block.kind === 'heading')) ||
          (block.kind === 'paragraph' && !block.segmentIds.length && !block.messageIds.length)) throw new Error('The note preview has invalid text or source references.');
      return block.text.replace(/\r\n?/g, '\n').split('\n').map((text, line) => ({ ops: text ? [{ insert: text }] : [], attributes: {
        blockId: `${proposal.id}_${index}_${line}`, ...(block.kind === 'heading' ? { header: 2 } : {}),
        ...(block.seconds === null ? {} : { anchorSeconds: block.seconds }),
      } }));
    });
    validate(fromLines(blocks));
    return blocks;
  }

  function generatedStatus(document, proposal, blocks = generatedBlocks(proposal)) {
    const existing = lines(document).filter(block => block.attributes.blockId?.startsWith(proposal.id + '_'));
    if (!existing.length) return 'absent';
    const expected = new Map(blocks.map(block => [block.attributes.blockId, block]));
    if (existing.length !== blocks.length || existing.some(block => {
      const target = expected.get(block.attributes.blockId);
      return !target || JSON.stringify(block.ops) !== JSON.stringify(target.ops) ||
        Object.keys({ ...target.attributes, ...block.attributes }).some(key => target.attributes[key] !== block.attributes[key]);
    })) throw new Error('Part of this preview is already in the note or has been edited. Review Notes before adding it again.');
    return 'present';
  }

  function sourceUrl(videoId, seconds) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return null;
    const url = new URL('https://www.youtube.com/watch');
    url.searchParams.set('v', videoId);
    if (hasTime(seconds)) url.searchParams.set('t', String(seconds));
    return url.href;
  }

  function validateRecords(value) {
    if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) throw new Error('Invalid notebook collection.');
    const keys = new Set();
    let size = 0;
    return value.map(record => {
      if (!record || !validId(record.courseId) || !/^[A-Za-z0-9_-]{11}$/.test(record.videoId || '')) throw new Error('Invalid notebook video.');
      if (typeof record.courseTitle !== 'string' || typeof record.videoTitle !== 'string' || record.courseTitle.length > 500 || record.videoTitle.length > 500) throw new Error('Invalid notebook title.');
      const key = record.courseId + '/' + record.videoId;
      if (keys.has(key)) throw new Error('Duplicate video note.');
      keys.add(key);
      const document = validate(record.document);
      size += document ? bytes(document) : 0;
      if (size > MAX_PROFILE_BYTES) throw new Error('Notebooks can contain up to 5 MiB per profile.');
      return { courseId: record.courseId, videoId: record.videoId, courseTitle: record.courseTitle, videoTitle: record.videoTitle, document };
    });
  }

  const escapeMarkdown = value => String(value).replace(/([\\`*_{}\[\]()<>#!|~])/g, '\\$1');
  const emphasize = (text, marker) => text.replace(/^(\s*)(\S[\s\S]*?)(\s*)$/, (_match, before, content, after) => before + marker + content + marker + after);

  function markdown(document, videoId) {
    const checked = validate(document);
    if (!checked) return '';
    return lines(checked).map((block, index, blocks) => {
      const attributes = block.attributes;
      const source = hasTime(attributes.anchorSeconds) ? sourceUrl(videoId, attributes.anchorSeconds) : null;
      if (attributes['code-block']) {
        if (index && blocks[index - 1].attributes['code-block']) return null;
        const codeBlocks = [];
        for (let cursor = index; cursor < blocks.length && blocks[cursor].attributes['code-block']; cursor++) codeBlocks.push(blocks[cursor]);
        const code = codeBlocks.map(item => item.text).join('\n');
        const sources = [...new Set(codeBlocks.filter(item => hasTime(item.attributes.anchorSeconds)).map(item => sourceUrl(videoId, item.attributes.anchorSeconds)))].filter(Boolean);
        const longest = Math.max(0, ...(code.match(/`+/g) || []).map(run => run.length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        const links = sources.map((url, sourceIndex) => `[Source${sourceIndex ? ' ' + (sourceIndex + 1) : ''}](${url})`).join(' ');
        return `${fence}\n${code}\n${fence}${links ? '\n\n' + links : ''}`;
      }
      if (!block.text.trim()) return '';
      const linked = block.ops.some(operation => operation.attributes?.link);
      let text = block.ops.map(operation => {
        const format = operation.attributes || {};
        let content = escapeMarkdown(operation.insert);
        if (format.code) {
          const longest = Math.max(0, ...(operation.insert.match(/`+/g) || []).map(run => run.length));
          const fence = '`'.repeat(longest + 1);
          content = `${fence} ${operation.insert} ${fence}`;
        }
        if (format.bold) content = emphasize(content, '**');
        if (format.italic) content = emphasize(content, '_');
        if (format.link) content = `[${content}](<${format.link.replace(/>/g, '%3E')}>)`;
        return content;
      }).join('');
      if (source) text = linked ? `${text} [Source](${source})` : `[${text}](${source})`;
      const prefix = attributes.header ? '#'.repeat(attributes.header + 1) + ' ' : attributes.list ? '  '.repeat(attributes.indent || 0) + (attributes.list === 'ordered' ? '1. ' : '- ') : '';
      return prefix + text;
    }).filter(block => block !== null).join('\n\n');
  }

  return { MAX_BYTES, MAX_PROFILE_BYTES, MAX_DOCUMENTS, empty, bytes, hasTime, validId, safeLink, lines, fromLines, validate, validateRecords, anchorChanges, generatedBlocks, generatedStatus, sourceUrl, escapeMarkdown, markdown };
});