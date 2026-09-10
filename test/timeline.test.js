'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildTimeline, replaceSnapshot } = require('../scripts/update-timeline');

function fixture() {
  return {
    notes: {
      version: 1,
      repository: 'https://github.com/example/project',
      milestones: [
        { id: 'foundation', title: 'Foundation', why: 'Start the project', changes: ['Create the app'], commits: ['aaa'] },
        { id: 'feature', title: 'Feature', why: 'Support learning', changes: ['Add workspace'], commits: ['bbb', 'ccc'] },
        { id: 'future', title: 'Not committed', why: 'Track planned work', changes: ['Pending'], recordedDate: '2026-09-10', commits: [], files: ['timeline.html'] },
      ],
      observations: [{ id: 'issue', title: 'Known issue', why: 'Record a verified problem', changes: ['Needs review'], date: '2026-09-09', stage: 'bugs', files: ['server.js'], relatedMilestones: ['feature'] }],
    },
    commits: [
      { hash: 'aaa111', date: '2026-08-01T12:00:00Z', subject: 'Foundation', parents: [], files: ['server.js'], stage: 'prod' },
      { hash: 'bbb222', date: '2026-09-08T12:00:00Z', subject: 'Workspace', parents: ['aaa111'], files: ['db.js', 'server.js'], stage: 'dev' },
      { hash: 'ccc333', date: '2026-09-09T18:00:00+05:30', subject: 'Search', parents: ['bbb222'], files: ['server.js', 'public/app.js'], stage: 'branch' },
      { hash: 'ddd444', date: '2026-09-09T15:00:00Z', subject: 'Merge feature', parents: ['bbb222', 'ccc333'], files: ['server.js'], stage: 'branch' },
    ],
    refs: { prod: { name: 'origin/main', hash: 'aaa111' }, dev: { name: 'origin/dev', hash: 'bbb222' } },
    head: 'ddd444', branch: 'feature/example', generatedAt: '2026-09-10T12:00:00Z',
  };
}

test('timeline sorts newest first using timezone-aware dates and groups commit files', () => {
  const data = buildTimeline(fixture());
  assert.deepEqual(data.entries.map(entry => entry.id), ['future', 'commit-ddd444', 'feature', 'issue', 'foundation']);
  const feature = data.entries.find(entry => entry.id === 'feature');
  assert.deepEqual(feature.files, ['db.js', 'public/app.js', 'server.js']);
  assert.equal(feature.commits.length, 2);
  assert.equal(feature.date, '2026-09-09T18:00:00+05:30');
});

test('branch stages require every grouped commit to reach the corresponding branch', () => {
  const input = fixture();
  assert.equal(buildTimeline(input).entries.find(entry => entry.id === 'feature').stage, 'branch');
  input.commits[2].stage = 'dev';
  assert.equal(buildTimeline(input).entries.find(entry => entry.id === 'feature').stage, 'dev');
  input.commits[1].stage = 'prod';
  input.commits[2].stage = 'prod';
  assert.equal(buildTimeline(input).entries.find(entry => entry.id === 'feature').stage, 'prod');
  assert.equal(buildTimeline(input).entries.find(entry => entry.id === 'future').stage, 'pending');
});

test('observations retain their own date and stage while linking related commits', () => {
  const issue = buildTimeline(fixture()).entries.find(entry => entry.id === 'issue');
  assert.equal(issue.stage, 'bugs');
  assert.equal(issue.dateKind, 'observed');
  assert.equal(issue.date, '2026-09-09');
  assert.deepEqual(issue.commits.map(commit => commit.hash), ['bbb222', 'ccc333']);
});

test('unknown commits, duplicate IDs, and unsafe file paths fail explicitly', () => {
  const unknown = fixture();
  unknown.notes.milestones[0].commits = ['missing'];
  assert.throws(() => buildTimeline(unknown), /Missing or ambiguous/);
  const duplicate = fixture();
  duplicate.notes.milestones[1].id = 'foundation';
  assert.throws(() => buildTimeline(duplicate), /duplicate timeline ID/);
  const unsafe = fixture();
  unsafe.notes.milestones[0].files = ['../secret'];
  assert.throws(() => buildTimeline(unsafe), /Unsafe file path/);
});

test('snapshot embedding cannot turn commit text into executable HTML', () => {
  const html = '<script id="timeline-data" type="application/json">{}</script><script>safe()</script>';
  const snapshot = { title: '</script><script>unsafe()</script>' };
  const replaced = replaceSnapshot(html, snapshot);
  assert.equal(replaced.includes('<script>unsafe()'), false);
  assert.ok(replaced.endsWith('<script>safe()</script>'));
  const data = JSON.parse(replaced.match(/type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data, snapshot);
  assert.throws(() => replaceSnapshot('', snapshot), /exactly one/);
});

test('the generated standalone timeline contains valid data and browser JavaScript', () => {
  const html = fs.readFileSync(path.join(__dirname, '../timeline.html'), 'utf8');
  const data = JSON.parse(html.match(/<script id="timeline-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.ok(data.entries.length >= 10);
  assert.match(data.head, /^[a-f0-9]{40}$/);
  for (let index = 1; index < data.entries.length; index++) {
    assert.ok(Date.parse(data.entries[index - 1].date) >= Date.parse(data.entries[index].date));
  }
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});