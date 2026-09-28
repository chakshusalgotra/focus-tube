'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'docs', 'diagrams');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function loadCatalog(base = root) {
  const catalog = readJson(path.join(base, 'docs', 'diagrams', 'catalog.json'));
  if (catalog.version !== 1 || !Array.isArray(catalog.diagrams) || !Array.isArray(catalog.sources)) throw new Error('Invalid diagram catalog.');
  const ids = new Set();
  for (const item of catalog.diagrams) {
    if (!/^[a-z][a-z0-9-]+$/.test(item.id) || ids.has(item.id) || !['architecture', 'workflow'].includes(item.type) || !['current', 'draft'].includes(item.state)) {
      throw new Error('Invalid diagram identity: ' + item.id);
    }
    ids.add(item.id);
    const spec = readJson(path.join(base, 'docs', 'diagrams', `${item.id}.${item.type}.json`));
    if (spec.diagram_type !== item.type || spec.meta.quality_profile !== 'showcase') throw new Error('Invalid diagram profile: ' + item.id);
    if (item.type === 'workflow' && spec.schema_version !== 2) throw new Error('New workflows require schema version 2.');
    if (item.state === 'draft' && !spec.meta.title.startsWith('Draft:')) throw new Error('Draft diagram must be labelled: ' + item.id);
    for (const evidence of item.evidence) {
      if (!catalog.sources.includes(evidence.path)) throw new Error('Evidence is outside the source allowlist: ' + evidence.path);
      if (!fs.readFileSync(path.join(base, evidence.path), 'utf8').includes(evidence.anchor)) throw new Error('Missing evidence anchor in ' + evidence.path);
    }
  }
  return catalog;
}

function sourceInventory(catalog, base = root) {
  const sources = catalog.sources.map(file => {
    if (path.isAbsolute(file) || file.split('/').includes('..') || /(^|\/)(?:\.env|data|\.ssh|node_modules)(?:\/|$)/.test(file)) throw new Error('Unsafe documentation source: ' + file);
    return { path: file, sha256: digest(fs.readFileSync(path.join(base, file))) };
  });
  const tables = [];
  for (const file of ['db.js', 'video-chat-store.js', 'extension-store.js']) {
    const text = fs.readFileSync(path.join(base, file), 'utf8');
    for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)) tables.push({ name: match[1], source: file });
  }
  let revision = 'unavailable';
  try { revision = execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  return { version: 1, reviewedOn: catalog.reviewedOn, scope: catalog.scope, gitBase: revision,
    sources: sources.sort((first, second) => first.path.localeCompare(second.path)), tables: tables.sort((first, second) => first.name.localeCompare(second.name)) };
}

function verifySources(catalog, base = root) {
  const expected = readJson(path.join(base, 'docs', 'diagrams', 'source-inventory.json'));
  const actual = sourceInventory(catalog, base);
  for (const source of actual.sources) {
    if (expected.sources.find(item => item.path === source.path)?.sha256 !== source.sha256) {
      throw new Error(`Documentation evidence changed: ${source.path}. Review the docs and diagrams, then run docs:build -- --refresh-evidence.`);
    }
  }
  if (expected.sources.length !== actual.sources.length || JSON.stringify(expected.tables) !== JSON.stringify(actual.tables)) throw new Error('Documentation source or table inventory changed.');
}

function indexHtml(catalog) {
  const items = catalog.diagrams.map(item => ({ id: item.id, title: item.title, state: item.state, source: `${item.id}.${item.type}.json` }));
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self' file:; connect-src 'none'; object-src 'none'; base-uri 'none'">
<title>FocusTube Architecture Atlas</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--panel:#fff;--text:#202124;--muted:#62676b;--line:#dedfe1;--accent:#0e7566}*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "IBM Plex Sans",sans-serif}header{padding:16px 24px;border-bottom:1px solid var(--line)}h1{font:700 23px/1.25 Georgia,serif;margin:0 0 6px}p{margin:4px 0;color:var(--muted)}nav{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}a{color:var(--accent);text-underline-offset:3px}.toolbar{display:flex;gap:16px;align-items:end;flex-wrap:wrap;padding:12px 24px}label{display:grid;gap:4px;font-size:13px}select{min-height:44px;max-width:100%;padding:8px;background:var(--panel);color:var(--text);border:1px solid var(--muted);border-radius:6px;font:inherit}.actions{display:flex;gap:18px;align-items:center;min-height:44px}.actions a{padding:10px 0}a:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}iframe{display:block;border:0;width:100%;height:calc(100dvh - 235px);min-height:540px;background:var(--panel)}#state{font-size:13px}#state[data-state="draft"]{color:#a63632;font-weight:600}@media(prefers-color-scheme:dark){:root{--bg:#151617;--panel:#1c1e20;--text:#eceef0;--muted:#a9adb3;--line:#3b3f43;--accent:#7edac2}#state[data-state="draft"]{color:#f49995}}@media(max-width:600px){header,.toolbar{padding-inline:16px}h1{font-size:21px}.toolbar{align-items:start;gap:8px}label{width:100%}iframe{min-height:650px}nav{gap:12px}}
</style></head><body>
<header><h1>FocusTube Architecture Atlas</h1><p>Source review: ${escapeHtml(catalog.reviewedOn)}. Animated paths explain the model; they are not live traffic.</p>
<nav aria-label="Documentation"><a href="../architecture.md">Architecture</a><a href="../flows.md">Website flows</a><a href="../api.md">API reference</a><a href="../README.md">Documentation index</a></nav></header>
<main><div class="toolbar"><label for="diagram">Diagram<select id="diagram">${items.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join('')}</select></label>
<div class="actions"><a id="open" href="system.html" target="_blank" rel="noopener">Open full diagram</a><a id="source" href="system.architecture.json">Editable JSON</a></div><p id="state" role="status"></p></div>
<iframe id="viewer" src="system.html" title="FocusTube system map" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups" allow="clipboard-write"></iframe></main>
<script>
const charts=${data};const choice=document.getElementById('diagram');const frame=document.getElementById('viewer');
function selectChart(){const selected=charts.find(item=>item.id===location.hash.slice(1))||charts[0];choice.value=selected.id;const filename=selected.id+'.html';if(frame.getAttribute('src')!==filename)frame.src=filename;frame.title=selected.title;document.getElementById('open').href=filename;document.getElementById('source').href=selected.source;const state=document.getElementById('state');state.dataset.state=selected.state;state.textContent=selected.state==='draft'?'Draft proposal; not implemented automation.':'Reviewed source model; not a deployment-health claim.';}
choice.addEventListener('change',()=>{location.hash=choice.value});window.addEventListener('hashchange',selectChart);selectChart();
</script></body></html>\n`;
}

function verifyArtifacts(catalog, base = root) {
  const folder = path.join(base, 'docs', 'diagrams');
  const receipts = readJson(path.join(folder, 'receipts.json'));
  for (const item of catalog.diagrams) {
    const receipt = receipts.diagrams.find(value => value.id === item.id);
    if (!receipt || receipt.validation.checksPassed !== 9 || receipt.validation.errors || receipt.validation.warnings) throw new Error('Missing showcase receipt: ' + item.id);
    for (const [kind, filename] of [['specification', `${item.id}.${item.type}.json`], ['artifact', `${item.id}.html`]]) {
      const bytes = fs.readFileSync(path.join(folder, filename));
      if (digest(bytes) !== receipt[kind].sha256 || bytes.length !== receipt[kind].bytes) throw new Error('Stale diagram ' + kind + ': ' + item.id);
    }
  }
  if (fs.readFileSync(path.join(folder, 'index.html'), 'utf8') !== indexHtml(catalog)) throw new Error('Diagram index is stale. Run docs:build.');
}

function checkLinks(base = root) {
  const documents = ['README.md', ...fs.readdirSync(path.join(base, 'docs')).filter(file => file.endsWith('.md')).map(file => 'docs/' + file)];
  let checked = 0;
  for (const file of documents) {
    const content = fs.readFileSync(path.join(base, file), 'utf8');
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const filename = decodeURIComponent(target.split('#')[0]);
      if (!fs.existsSync(path.resolve(base, path.dirname(file), filename))) throw new Error(`Broken documentation link in ${file}: ${target}`);
      checked++;
    }
  }
  return checked;
}

function commandLine() {
  const [command = 'check', selection] = process.argv.slice(2);
  const catalog = loadCatalog();
  const cli = path.join(process.env.ARCHIFY_SKILL_DIR || path.join(os.homedir(), '.copilot', 'skills', 'archify'), 'bin', 'archify.mjs');
  const environment = { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir(), ARCHIFY_UPDATE_CHECK_DISABLED: '1' };
  if (command === 'check') {
    verifySources(catalog); verifyArtifacts(catalog);
    console.log(`PASS: ${catalog.diagrams.length} diagrams, ${catalog.sources.length} source fingerprints, ${checkLinks()} local documentation links.`);
    return;
  }
  if (!fs.existsSync(cli)) throw new Error('Install the global Archify skill or set ARCHIFY_SKILL_DIR. See docs/architecture.md.');
  if (command === 'preview') {
    const item = catalog.diagrams.find(value => value.id === selection);
    if (!item) throw new Error('Choose a diagram: ' + catalog.diagrams.map(value => value.id).join(', '));
    const result = spawnSync(process.execPath, [cli, 'preview', item.type, path.join(directory, `${item.id}.${item.type}.json`), path.join(directory, `${item.id}.html`), '--quality', 'showcase', '--no-open'], { env: environment, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command !== 'build') throw new Error('Use check, build [--refresh-evidence], or preview <diagram-id>.');
  if (fs.existsSync(path.join(directory, 'source-inventory.json')) && selection !== '--refresh-evidence') verifySources(catalog);
  const receipts = [];
  for (const item of catalog.diagrams) {
    const result = spawnSync(process.execPath, [cli, 'deliver', item.type, path.join(directory, `${item.id}.${item.type}.json`), path.join(directory, `${item.id}.html`), '--quality', 'showcase', '--json'], { env: environment, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const receipt = JSON.parse(result.stdout || '{}');
    if (result.status !== 0 || !receipt.ok) throw new Error(item.id + ': ' + (receipt.error || result.stderr || 'Archify delivery failed.'));
    receipts.push({ id: item.id, type: item.type, specification: receipt.specification, artifact: receipt.artifact, validation: receipt.validation });
    console.log(`PASS: ${item.id}, ${receipt.validation.checksPassed}/9 showcase checks`);
  }
  writeJson(path.join(directory, 'source-inventory.json'), sourceInventory(catalog));
  writeJson(path.join(directory, 'receipts.json'), { version: 1, generator: catalog.archify, diagrams: receipts });
  fs.writeFileSync(path.join(directory, 'index.html'), indexHtml(catalog));
  verifySources(catalog); verifyArtifacts(catalog);
  console.log('PASS: documentation diagrams built and byte-verified.');
}

if (require.main === module) {
  try { commandLine(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { loadCatalog, sourceInventory, verifySources, verifyArtifacts, checkLinks, indexHtml };