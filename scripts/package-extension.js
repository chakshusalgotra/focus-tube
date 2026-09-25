'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createWriteStream } = require('node:fs');
const sharp = require('sharp');
const { icons } = require('lucide');
const archiver = require('archiver');

async function packageExtension(outputDirectory = path.join(__dirname, '..', 'extension')) {
  const root = path.join(__dirname, '..');
  const source = path.join(root, 'extension');
  const files = new Map();
  for (const filename of ['manifest.json', 'service-worker.js', 'popup.html', 'popup.js', 'popup.css']) files.set(filename, await fs.readFile(path.join(source, filename)));
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error('Use a numeric extension version.');
  const names = ['BookOpen', 'UserRound', 'Plus', 'LogIn', 'LogOut', 'Check', 'RefreshCw', 'ExternalLink', 'X', 'LoaderCircle', 'Link', 'Video', 'CircleAlert', 'LockKeyhole'];
  const subset = Object.fromEntries(names.map(name => {
    if (!Array.isArray(icons[name])) throw new Error(`Missing local Lucide icon: ${name}`);
    return [name, icons[name]];
  }));
  files.set('assets/icons.js', Buffer.from(`'use strict';\nglobalThis.CaptureIcons = ${JSON.stringify(subset)};\n`));
  const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const paths = subset.BookOpen.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).map(([name, value]) => `${name}="${escape(value)}"`).join(' ')}/>`).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 32 32"><rect x="0" y="0" width="32" height="32" rx="6" fill="#0e7566"/><g transform="translate(5 5) scale(.92)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`);
  for (const size of [16, 32, 48, 128]) files.set(`assets/icon-${size}.png`, await sharp(svg).resize(size, size).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer());
  const localAssets = {
    'assets/plex-400.woff2': '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2',
    'assets/plex-600.woff2': '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2',
    'assets/manrope.woff2': '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2',
    'assets/LICENSE-plex.txt': '@fontsource/ibm-plex-sans/LICENSE',
    'assets/LICENSE-manrope.txt': '@fontsource-variable/manrope/LICENSE',
    'assets/LICENSE-lucide.txt': 'lucide/LICENSE',
  };
  for (const [target, original] of Object.entries(localAssets)) files.set(target, await fs.readFile(path.join(root, 'node_modules', original)));
  await fs.mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
  for (const [filename, bytes] of files) if (outputDirectory !== source || filename.startsWith('assets/')) await fs.writeFile(path.join(outputDirectory, filename), bytes);
  const filename = path.join(outputDirectory, `focustube-${manifest.version}.zip`);
  const archive = typeof archiver === 'function' ? archiver('zip', { zlib: { level: 9 } }) : new archiver.ZipArchive({ zlib: { level: 9 } });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(filename);
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(output);
    for (const name of [...files.keys()].sort()) archive.append(files.get(name), { name, date: new Date('2020-01-01T00:00:00.000Z'), mode: 0o644 });
    archive.finalize().catch(reject);
  });
  return { file: filename, version: manifest.version, sha256: crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex'), files: [...files.keys()].sort() };
}

module.exports = { packageExtension };
if (require.main === module) packageExtension().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(`Extension packaging failed: ${error.message}`); process.exitCode = 1; });