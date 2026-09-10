'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const stages = new Set(['prod', 'dev', 'branch', 'bugs', 'pending']);

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trimEnd();
}

function revision(ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function buildTimeline({ notes, commits, refs, head, branch, generatedAt }) {
  if (notes.version !== 1 || !Array.isArray(notes.milestones) || !Array.isArray(notes.observations)) {
    throw new Error('Unsupported timeline notes schema.');
  }
  const ids = new Set();
  const assigned = new Set();
  const resolveCommits = prefixes => (prefixes || []).map(prefix => {
    const matches = commits.filter(commit => commit.hash.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`Missing or ambiguous timeline commit: ${prefix}`);
    return matches[0];
  });
  const checkEntry = entry => {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Missing or duplicate timeline ID: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.title || !entry.why || !Array.isArray(entry.changes) || !entry.changes.length) {
      throw new Error(`Missing rationale or changes for ${entry.id}`);
    }
  };
  const filesFor = (entry, linked) => [...new Set([
    ...(entry.files || []), ...linked.flatMap(commit => commit.files),
  ])].sort();
  const entries = notes.milestones.map(milestone => {
    checkEntry(milestone);
    const linked = resolveCommits(milestone.commits);
    linked.forEach(commit => assigned.add(commit.hash));
    const latest = [...linked].sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0];
    const stage = !linked.length ? 'pending'
      : linked.every(commit => commit.stage === 'prod') ? 'prod'
        : linked.every(commit => ['prod', 'dev'].includes(commit.stage)) ? 'dev' : 'branch';
    return {
      ...milestone,
      date: latest?.date || milestone.recordedDate,
      dateKind: latest ? 'commit' : 'recorded',
      stage,
      commits: linked,
      files: filesFor(milestone, linked),
    };
  });
  for (const observation of notes.observations) {
    checkEntry(observation);
    if (!['bugs', 'pending'].includes(observation.stage)) throw new Error(`Invalid observation stage: ${observation.stage}`);
    const related = (observation.relatedMilestones || []).flatMap(id => {
      const milestone = entries.find(entry => entry.id === id);
      if (!milestone) throw new Error(`Unknown related milestone: ${id}`);
      return milestone.commits;
    });
    entries.push({
      ...observation,
      dateKind: 'observed',
      commits: [...new Map(related.map(commit => [commit.hash, commit])).values()],
      files: observation.files || [],
    });
  }
  for (const commit of commits) {
    if (assigned.has(commit.hash)) continue;
    const integration = commit.parents.length > 1;
    const entry = {
      id: `commit-${commit.hash}`,
      title: commit.subject,
      date: commit.date,
      dateKind: 'commit',
      stage: commit.stage,
      why: integration ? 'Integrate branch history. This records a merge, not a verified deployment.'
        : 'No separate feature rationale recorded; see the commit for implementation context.',
      changes: [commit.body || commit.subject],
      commits: [commit],
      files: commit.files,
    };
    checkEntry(entry);
    entries.push(entry);
  }
  for (const entry of entries) {
    if (!Number.isFinite(Date.parse(entry.date)) || !stages.has(entry.stage)) {
      throw new Error(`Invalid date or stage for ${entry.id}`);
    }
    if (entry.files.some(file => typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..'))) {
      throw new Error(`Unsafe file path in ${entry.id}`);
    }
  }
  entries.sort((left, right) => Date.parse(right.date) - Date.parse(left.date) || left.id.localeCompare(right.id));
  return { version: 1, repository: notes.repository, generatedAt, head, branch, refs, commitCount: commits.length, entries };
}

function collectHistory() {
  const refs = { prod: { name: 'origin/main', hash: revision('origin/main') }, dev: { name: 'origin/dev', hash: revision('origin/dev') } };
  const head = revision('HEAD');
  const branch = git(['branch', '--show-current']) || 'detached HEAD';
  const prod = new Set(refs.prod.hash ? git(['rev-list', refs.prod.hash]).split('\n') : []);
  const dev = new Set(refs.dev.hash ? git(['rev-list', refs.dev.hash]).split('\n') : []);
  const revisions = [head, refs.prod.hash, refs.dev.hash].filter(Boolean);
  const hashes = git(['rev-list', '--date-order', ...revisions]).split('\n');
  const commits = hashes.map(hash => {
    const [date, authoredAt, subject, parentText, ...bodyParts] = git(['show', '-s', '--format=%cI%x00%aI%x00%s%x00%P%x00%b', hash]).split('\0');
    const parents = parentText ? parentText.split(' ') : [];
    const changedFiles = parents.length
      ? git(['diff', '--name-only', '-z', parents[0], hash])
      : git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', hash]);
    return {
      hash, date, authoredAt, subject, parents, body: bodyParts.join('\0').trim(),
      stage: prod.has(hash) ? 'prod' : dev.has(hash) ? 'dev' : 'branch',
      files: changedFiles.split('\0').filter(Boolean),
    };
  });
  return { refs, head, branch, commits };
}

function replaceSnapshot(html, snapshot) {
  const marker = /<script id="timeline-data" type="application\/json">[\s\S]*?<\/script>/g;
  if ([...html.matchAll(marker)].length !== 1) throw new Error('Expected exactly one timeline-data script.');
  const json = JSON.stringify(snapshot, null, 2).replace(/</g, '\\u003c');
  return html.replace(marker, () => `<script id="timeline-data" type="application/json">\n${json}\n</script>`);
}

if (require.main === module) {
  const notes = JSON.parse(fs.readFileSync(path.join(root, 'docs/timeline-notes.json'), 'utf8'));
  const snapshot = buildTimeline({ notes, ...collectHistory(), generatedAt: new Date().toISOString() });
  const output = path.join(root, 'timeline.html');
  fs.writeFileSync(output, replaceSnapshot(fs.readFileSync(output, 'utf8'), snapshot));
  console.log(`Updated timeline.html: ${snapshot.entries.length} entries, ${snapshot.commitCount} commits, through ${snapshot.head.slice(0, 7)}.`);
}

module.exports = { buildTimeline, replaceSnapshot };