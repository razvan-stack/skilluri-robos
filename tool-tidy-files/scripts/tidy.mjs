#!/usr/bin/env node
// tidy.mjs - the engine of the tool-tidy-files skill: scan, plan, check, apply, undo, runs.
// Made by Răzvan Bordeanu for the robOS community. MIT license.
//
// Nothing in this file deletes a file. Files only move: into folders the operator approved,
// or into a quarantine folder on the same disk (<folder>/_tidy/<run>/quarantine/). Every
// move is written to a journal before it happens, so `undo` can put everything back.
// The only removals are empty folders that a run itself created, when that run is undone.
//
//   node tidy.mjs scan  <folder> [--out DIR] [--protect PATH]... [--max-files N]
//                       [--max-hash-mb N] [--no-dupes] [--force-root] [--allow-drive-root]
//   node tidy.mjs plan  <scan.json> --mode type|date|type-date|projects|para|dupes
//                       [--projects DIR] [--lang ro|en] [--all-depths]
//                       [--dupes quarantine|report] [--archive-months 12] [--out plan.json]
//   node tidy.mjs check <plan.json>
//   node tidy.mjs apply <plan.json> --yes [--limit N]
//   node tidy.mjs undo  <folder> [--run ID]
//   node tidy.mjs runs  <folder>
//
// Exit codes: 0 done; 1 done with skipped entries or undo conflicts; 2 refused (bad input,
// invalid plan, missing --yes); 4 the chosen folder itself looks like a project or program
// package (re-run with --force-root only if the operator confirms it is not one).
//
// Node 18+, no dependencies. Works on Windows, macOS and Linux.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FORMAT = 1;
const CREDIT = 'tool-tidy-files · made by Răzvan Bordeanu for the robOS community';
const RUN_DIR = '_tidy';
const IS_WIN = process.platform === 'win32';
const CASE_INSENSITIVE = IS_WIN || process.platform === 'darwin';
const MTIME_TOLERANCE_MS = 2000; // FAT and some network drives keep 2-second mtimes

// ---------------------------------------------------------------- small helpers

function die(msg, code = 2) { console.error('ERROR: ' + msg); process.exit(code); }

function parseArgs(argv) {
  const out = { _: [], protect: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    if (k === 'protect') { if (!hasValue) die('--protect needs a path'); out.protect.push(next); i++; continue; }
    if (hasValue) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}

const fmtBytes = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
};
const stamp = (d = new Date()) => { // UTC, so the order of runs survives clock changes
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`cannot read ${f}: ${e.message}`); } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n', 'utf8');

// Comparable form of a path: absolute, NFC, lower case where the file system ignores case.
function norm(p) {
  let r = path.resolve(p).normalize('NFC');
  if (CASE_INSENSITIVE) r = r.toLowerCase();
  if (r.length > 1 && /[\\/]$/.test(r) && !/^[a-z]:[\\/]$/i.test(r)) r = r.replace(/[\\/]+$/, '');
  return r;
}
function isInside(child, parent) {
  const c = norm(child); const p = norm(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
const key = (rel) => { const r = rel.normalize('NFC'); return CASE_INSENSITIVE ? r.toLowerCase() : r; };
// "Is something there": lstat, so a broken link also counts and is never replaced.
const exists = (p) => {
  try { return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined; } catch (e) { return !(e.code === 'ENOTDIR' || e.code === 'ENOENT'); } // unreadable counts as taken
};
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
// Two names for one file (another case on a case-insensitive disk, a Windows short name, a link).
function sameFile(a, b) {
  try {
    const x = fs.statSync(a, { bigint: true }); const y = fs.statSync(b, { bigint: true });
    if (x.ino !== 0n && x.dev === y.dev && x.ino === y.ino) return true;
  } catch { return false; }
  const ra = real(a); const rb = real(b);
  return Boolean(ra && rb && norm(ra) === norm(rb));
}
// Files the system keeps in every folder (folder icon, name, thumbnails): never moved.
const SYSTEM_FILES = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'icon\r', '.ds_store', '.localized']);

// Relative paths are stored with "/" so a plan reads the same on every system.
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const fromRel = (root, rel) => path.join(root, ...rel.split('/'));

const HERE = path.dirname(fileURLToPath(import.meta.url));
function findRobosRoot(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'CLAUDE.md')) && fs.existsSync(path.join(d, 'skills')) && fs.existsSync(path.join(d, 'scripts'))) return d;
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  return null;
}
const ROBOS_ROOT = findRobosRoot(HERE);

// ---------------------------------------------------------------- protection

function systemProtected() {
  const home = os.homedir(); const e = process.env; const L = [];
  if (IS_WIN) {
    L.push(e.SystemRoot || 'C:\\Windows', e.ProgramFiles || 'C:\\Program Files',
      e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', e.ProgramData || 'C:\\ProgramData',
      path.join(home, 'AppData'));
  } else if (process.platform === 'darwin') {
    L.push('/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/opt', '/private/etc', '/private/var/db', '/private/var/root');
    // ~/Library is protected except the cloud folders kept there (Dropbox, OneDrive, Google Drive, iCloud Drive).
    const lib = path.join(home, 'Library'); const CLOUD = new Set(['cloudstorage', 'mobile documents']);
    try { for (const e of fs.readdirSync(lib)) if (!CLOUD.has(e.toLowerCase())) L.push(path.join(lib, e)); } catch { L.push(lib); }
  } else {
    L.push('/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/sbin', '/snap', '/sys', '/usr', '/opt',
      '/var/lib', '/var/log', '/var/cache', '/var/spool', '/var/backups', '/var/mail', '/var/opt', '/var/db',
      '/run/systemd', '/run/user', '/run/lock', '/run/udev', '/run/dbus');
  }
  return L;
}
// Folder names that are never entered, wherever they appear.
const PROTECTED_NAMES = new Set(['$recycle.bin', 'system volume information', 'appdata', 'windowsapps', 'recovery', 'config.msi']);

// The operator's permanent off-limits list: protect.txt next to SKILL.md, one path per line
// (# starts a comment). A plan cannot switch it off, unlike a --protect given for one scan.
const PROTECT_FILE = path.join(path.dirname(HERE), 'protect.txt');
function expandPath(p) {
  let s = p;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  if (IS_WIN) s = s.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  return s;
}
// Strict on purpose: a line that protects nothing must not look as if it did.
function permanentProtect() {
  let text; try { text = fs.readFileSync(PROTECT_FILE, 'utf8'); } catch { return { paths: [], errors: [] }; }
  const paths = []; const errors = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue; // only whole-line comments: "#" may be part of a name
    const optional = l.startsWith('?'); // "?E:\\Backup": a removable drive, protected when it is plugged in
    const p = expandPath(optional ? l.slice(1).trim() : l);
    if (!path.isAbsolute(p)) { errors.push(`protect.txt: "${l}" is not a full path (write it from the drive or from /)`); continue; }
    if (!exists(p)) { if (!optional) errors.push(`protect.txt: "${l}" does not exist (fix the line, or start it with ? for a removable drive)`); continue; }
    paths.push(path.resolve(p));
  }
  return { paths, errors };
}
function protectedList(extra) {
  const L = systemProtected();
  if (ROBOS_ROOT) L.push(ROBOS_ROOT);
  for (const p of [...permanentProtect().paths, ...(extra || [])]) L.push(path.resolve(p));
  // Compare real paths too, so a link cannot walk around a protected folder.
  for (const p of [...L]) { const r = real(p); if (r && norm(r) !== norm(p)) L.push(r); }
  return L;
}
const isProtected = (abs, list) => list.some((p) => isInside(abs, p));
// The same protected folders by identity (disk and file number), for spellings a string compare
// cannot see: another case on a case-insensitive disk, a short name, a second mount.
function protIds(list) {
  const ids = new Set();
  for (const p of list) { try { const st = fs.statSync(p, { bigint: true }); if (st.ino !== 0n) ids.add(`${st.dev}:${st.ino}`); } catch { /* missing */ } }
  return ids;
}
const idOf = (p) => { try { const st = fs.statSync(p, { bigint: true }); return st.ino !== 0n ? `${st.dev}:${st.ino}` : null; } catch { return null; } };
// True when abs or one of its folders up to stop (inclusive) is a protected folder by identity.
function idProtected(abs, stop, ids) {
  if (!ids.size) return false;
  let d = abs;
  for (let i = 0; i < 64; i++) {
    const id = idOf(d); if (id && ids.has(id)) return true;
    if (norm(d) === norm(stop)) return false;
    const up = path.dirname(d); if (up === d) return false; d = up;
  }
  return false;
}

// ---------------------------------------------------------------- packages (kept whole)

// A package is a folder whose files belong together: a code project, an installed program,
// a driver pack, a website, a photo library, a medical study. It is never split.
const STRONG_MARKERS = new Set(['.git', '.hg', '.svn', 'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile', 'wp-config.php', 'claude.md', 'skill.md', 'dicomdir']);
const WEAK_MARKERS = new Set(['index.html', 'makefile', 'cmakelists.txt', 'requirements.txt', 'setup.py', '.project', 'autorun.inf']);
const MARKER_EXT = new Set(['.sln', '.csproj', '.vcxproj', '.uproject', '.code-workspace']);
const PACKAGE_DIR_EXT = new Set(['.app', '.photoslibrary', '.fcpbundle', '.xcodeproj', '.xcworkspace', '.lrdata', '.imovielibrary',
  '.band', '.logicx', '.pages', '.numbers', '.key', '.rtfd', '.bundle', '.framework', '.plugin', '.kext']);
const PACKAGE_NAME_RE = [
  /^(xampp|wamp(64)?|laragon|mamp|htdocs|bin|lib|lib64|libs|plugins|wp-content|wp-includes|wp-admin|node_modules|vendor|site-packages|venv|__pycache__|drivers?|program files( \(x86\))?|programdata|steamapps)$/i,
  /_win(xp|7|8|8\.1|10|11|32|64)(_|$)/i,
  /_VER/,
];
const PROGRAM_EXT = new Set(['.dll', '.sys', '.inf', '.so', '.jar', '.php', '.cab', '.dylib', '.ocx', '.drv', '.cat', '.pyd', '.class', '.o', '.a', '.lib']);
// At the chosen folder itself a weak marker counts only next to files of its kind (a site, a Python or C project).
// Not Images/Fonts/Code: this tool creates those folders itself.
const ROOT_WEAK_DIRS = { 'index.html': ['assets', 'css', 'js', 'static'], 'setup.py': ['src', 'tests'], 'requirements.txt': ['src', 'tests', 'app'], 'makefile': ['src', 'include'], 'cmakelists.txt': ['src', 'include'] };
const ROOT_WEAK = { 'index.html': ['.css', '.js', '.htm', '.html', '.svg', '.ico', '.webmanifest'], 'setup.py': ['.py'], 'requirements.txt': ['.py'], 'makefile': ['.c', '.cpp', '.h', '.o'], 'cmakelists.txt': ['.c', '.cpp', '.h'], 'autorun.inf': ['.exe', '.inf', '.cab'] };

function packageReason(dirName, ents, isRoot) {
  const lowerName = dirName.toLowerCase();
  if (PACKAGE_DIR_EXT.has(path.extname(lowerName))) return `package folder type (${path.extname(lowerName)})`;
  for (const e of ents) {
    const n = e.name.toLowerCase();
    if (STRONG_MARKERS.has(n)) return `project marker (${e.name})`;
    if (!isRoot && WEAK_MARKERS.has(n)) return `project marker (${e.name})`;
    if (isRoot && ROOT_WEAK[n] && ents.some((o) => o !== e && o.isFile() && ROOT_WEAK[n].includes(path.extname(o.name).toLowerCase()))) return `project marker (${e.name} with ${ROOT_WEAK[n].join('/')} files)`;
    if (isRoot && ROOT_WEAK_DIRS[n] && ents.some((o) => o.isDirectory() && ROOT_WEAK_DIRS[n].includes(o.name.toLowerCase()))) return `project marker (${e.name} with a ${ROOT_WEAK_DIRS[n].join('/')} folder)`;
    if (e.isFile() && MARKER_EXT.has(path.extname(n))) return `project marker (${e.name})`;
    if (e.isFile() && path.extname(n) === '.dcm') return 'medical imaging study (.dcm)';
  }
  if (!isRoot && PACKAGE_NAME_RE.some((re) => re.test(dirName))) return `program or driver folder name (${dirName})`;
  const files = ents.filter((e) => e.isFile());
  const prog = files.filter((e) => PROGRAM_EXT.has(path.extname(e.name).toLowerCase()) || (!isRoot && path.extname(e.name).toLowerCase() === '.exe')).length;
  if (!isRoot && prog > 0 && (prog >= 5 || prog / files.length >= 0.3)) return `program or library files (${prog} of ${files.length})`;
  if (isRoot && prog >= 5 && prog / files.length >= 0.3) return `program or library files (${prog} of ${files.length})`;
  return null;
}

function treeStats(dir, cap = 200000) {
  let files = 0; let bytes = 0; let links = 0; const stack = [dir];
  while (stack.length && files < cap) {
    const d = stack.pop(); let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      if (e.isSymbolicLink()) { links++; continue; }
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) { files++; try { bytes += fs.statSync(abs).size; } catch { /* unreadable */ } }
    }
  }
  return { files, bytes, links };
}

// ---------------------------------------------------------------- file kinds

const CATEGORY_EXT = {
  documents: 'doc docx odt rtf txt md pages tex wpd',
  spreadsheets: 'xls xlsx xlsm ods csv tsv numbers',
  presentations: 'ppt pptx odp key',
  pdf: 'pdf',
  images: 'jpg jpeg png gif webp heic heif bmp tif tiff svg raw cr2 cr3 nef arw dng psd ico avif',
  design: 'ai eps fig sketch xd indd afdesign afphoto',
  video: 'mp4 mov avi mkv wmv webm m4v 3gp mts flv mpg mpeg',
  audio: 'mp3 wav m4a aac flac ogg opus wma aiff mid midi',
  archives: 'zip rar 7z tar gz tgz bz2 xz iso zst',
  installers: 'exe msi msix appx dmg pkg deb rpm appimage apk',
  ebooks: 'epub mobi azw azw3 djvu fb2',
  code: 'js mjs ts py java c cpp h cs go rs rb sh ps1 bat cmd json xml yml yaml html htm css sql ipynb',
  fonts: 'ttf otf woff woff2',
};
const EXT_CAT = {};
for (const [cat, list] of Object.entries(CATEGORY_EXT)) for (const x of list.split(' ')) EXT_CAT['.' + x] = cat;

const SCREENSHOT_RE = /^(screenshot|screen shot|captur(a|ă) de ecran|capture d.(e|é)cran|bildschirmfoto|schermata|captura de pantalla|snip|screenclip|scr_)/i;
const CAMERA_NAME_RE = /^(img|dsc|dscn|dscf|dji|pxl|gopr|mvimg|p\d{7})[_-]?\d/i;
const WHATSAPP_RE = /^(img|vid|aud|ptt|doc)-\d{8}-wa\d+/i;
const CONFLICT_RE = [/conflicted copy/i, /copie (î|i)n conflict/i, /\(conflict\)/i, /-(desktop|laptop)-[a-z0-9]{5,}(\.[^.]+)?$/i, /\[conflict\]/i];
const COPY_NAME_RE = [/\s\(\d+\)$/, /\s-\s(copy|copie|kopie|copia)(\s\(\d+\))?$/i, /^(copy of|copie a|copie după)\s/i, /[_\s](copy|copie)\d*$/i];
const PARTIAL_EXT = new Set(['.crdownload', '.part', '.partial', '.download', '.opdownload', '.tmp']);

function stem(name) { const e = path.extname(name); return e ? name.slice(0, -e.length) : name; }
function cleanStem(name) {
  let s = stem(name);
  for (let i = 0; i < 3; i++) for (const re of COPY_NAME_RE) s = s.replace(re, '');
  return s.trim().toLowerCase();
}

// Minimal EXIF reader for JPEG: camera make/model and the capture date.
function readExif(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(262144); const n = fs.readSync(fd, buf, 0, buf.length, 0); const b = buf.subarray(0, n);
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let off = 2;
    while (off + 4 < b.length) {
      if (b[off] !== 0xff) return null;
      const marker = b[off + 1]; const len = b.readUInt16BE(off + 2);
      if (marker === 0xe1 && b.toString('latin1', off + 4, off + 10) === 'Exif\0\0') return parseTiff(b.subarray(off + 10, off + 2 + len));
      if (marker === 0xda) return null;
      off += 2 + len;
    }
  } catch { /* unreadable: no exif */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
function parseTiff(t) {
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ascii = (entry) => {
    const count = u32(entry + 4); const at = count <= 4 ? entry + 8 : u32(entry + 8);
    if (at + count > t.length) return '';
    return t.toString('latin1', at, at + count).replace(/\0+$/, '').trim();
  };
  const readIfd = (o) => {
    const out = {}; if (o + 2 > t.length) return out;
    const cnt = u16(o);
    for (let i = 0; i < cnt; i++) {
      const e = o + 2 + i * 12; if (e + 12 > t.length) break;
      const tag = u16(e);
      if (tag === 0x010f) out.make = ascii(e);
      else if (tag === 0x0110) out.model = ascii(e);
      else if (tag === 0x0132) out.date = ascii(e);
      else if (tag === 0x9003) out.dateOriginal = ascii(e);
      else if (tag === 0x8769) out.exifIfd = u32(e + 8);
    }
    return out;
  };
  try {
    const ifd0 = readIfd(u32(4));
    const sub = ifd0.exifIfd ? readIfd(ifd0.exifIfd) : {};
    const raw = sub.dateOriginal || ifd0.date || '';
    const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
    return { camera: Boolean(ifd0.make || ifd0.model), date: m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null };
  } catch { return null; }
}

function fileRecord(root, abs, st, top) {
  const name = path.basename(abs).normalize('NFC'); const ext = path.extname(name).toLowerCase(); // macOS keeps names decomposed (NFD)
  const flags = [];
  let cat = EXT_CAT[ext] || 'other';
  let date = new Date(st.mtimeMs).toISOString().slice(0, 10);
  if (PARTIAL_EXT.has(ext)) flags.push('partial');
  if (name.startsWith('~$') || name.startsWith('.~lock.')) flags.push('lockfile');
  if (cat === 'installers') flags.push('installer');
  if (CONFLICT_RE.some((re) => re.test(stem(name)))) flags.push('conflict');
  if (COPY_NAME_RE.some((re) => re.test(stem(name)))) flags.push('copyname');
  if (cat === 'images' || cat === 'video' || cat === 'audio') {
    if (WHATSAPP_RE.test(name)) flags.push('whatsapp');
    else if (cat === 'images' && SCREENSHOT_RE.test(name)) flags.push('screenshot');
    else if (CAMERA_NAME_RE.test(name)) flags.push('camera');
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const ex = readExif(abs);
    if (ex) {
      if (ex.camera && !flags.includes('camera') && !flags.includes('screenshot')) flags.push('camera');
      if (ex.date) date = ex.date;
    }
  }
  return { p: toRel(root, abs), size: st.size, mtime: Math.round(st.mtimeMs), ext, cat, flags, date, top };
}

// ---------------------------------------------------------------- hashing

function sha256File(abs, limit) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const opts = { highWaterMark: 1 << 20 };
    if (limit) opts.end = limit - 1;
    const s = fs.createReadStream(abs, opts);
    s.on('data', (d) => h.update(d)); s.on('end', () => resolve(h.digest('hex'))); s.on('error', reject);
  });
}
async function pool(items, n, fn) {
  let i = 0; const workers = [];
  for (let w = 0; w < Math.min(n, items.length); w++) {
    workers.push((async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })());
  }
  await Promise.all(workers);
}

function sameBytes(a, b) {
  const fa = fs.openSync(a, 'r'); const fb = fs.openSync(b, 'r');
  try {
    const sa = fs.fstatSync(fa).size; const sb = fs.fstatSync(fb).size;
    if (sa !== sb) return false;
    const A = Buffer.alloc(1 << 20); const B = Buffer.alloc(1 << 20); let pos = 0;
    while (pos < sa) {
      const n = fs.readSync(fa, A, 0, A.length, pos); const m = fs.readSync(fb, B, 0, B.length, pos);
      if (n !== m || n <= 0) return false;
      if (!A.subarray(0, n).equals(B.subarray(0, n))) return false;
      pos += n;
    }
    return true;
  } finally { fs.closeSync(fa); fs.closeSync(fb); }
}
function listTree(dir) {
  const out = []; const stack = ['']; let link = false;
  while (stack.length) {
    const rel = stack.pop(); const d = rel ? path.join(dir, rel) : dir;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) link = true;
      else if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) out.push(r);
    }
  }
  return { files: out.sort(), link };
}
function sameTree(a, b) {
  const ta = listTree(a); const tb = listTree(b);
  if (ta.link || tb.link) return false;
  if (ta.files.length !== tb.files.length) return false;
  for (let i = 0; i < ta.files.length; i++) if (ta.files[i] !== tb.files[i]) return false;
  return ta.files.every((f) => sameBytes(path.join(a, f), path.join(b, f)));
}

// ---------------------------------------------------------------- scan

async function cmdScan(args) {
  const target = args._[1]; if (!target) die('usage: scan <folder>');
  const typed = path.resolve(target);
  let st; try { st = fs.statSync(typed); } catch { die(`folder not found: ${typed}`); }
  if (!st.isDirectory()) die(`not a folder: ${typed}`);
  // Every path stored from here on starts from the folder's real path (links, junctions and short names resolved).
  const root = real(typed) || typed;
  const pp = permanentProtect(); if (pp.errors.length) die(pp.errors.join('\n') + `\n(${PROTECT_FILE})`);
  // --protect: a relative path means a folder inside the scanned folder; a path that does not exist is an error, not a silent no-op.
  args.protect = args.protect.map((p) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)));
  for (const p of args.protect) if (!exists(p)) die(`--protect path not found: ${p}`);
  const prot = protectedList(args.protect); const protIdSet = protIds(prot);
  const realRootScan = root;
  if (isProtected(root, prot) || isProtected(realRootScan, prot)) die(`refused: ${root} is a protected location (system, the robOS installation, protect.txt or a --protect path).`);
  const badSeg = realRootScan.split(/[\\/]/).find((sg) => PROTECTED_NAMES.has(sg.toLowerCase()));
  if (badSeg) die(`refused: ${root} is inside a protected system folder (${badSeg}).`);
  if (path.parse(root).root === root && !args['allow-drive-root']) {
    die(`refused: ${root} is the root of a disk. Choose a folder, or pass --allow-drive-root if the operator asked for the whole disk.`);
  }
  const maxFiles = Number(args['max-files'] || 200000);
  const maxHash = Number(args['max-hash-mb'] || 0) * 1024 * 1024;

  const rootEnts = fs.readdirSync(root, { withFileTypes: true });
  const rootPkg = packageReason(path.basename(root), rootEnts, true);
  if (rootPkg && !args['force-root']) {
    console.error(`STOP: the folder itself looks like a project or program package: ${rootPkg}.`);
    console.error('Organizing inside it would split it. Ask the operator; re-run with --force-root only if they confirm it is a plain folder.');
    process.exit(4);
  }

  const files = []; const packages = []; const skipped = []; let hiddenFiles = 0; let truncated = false;
  const stack = [root]; const topDirs = [];
  const t0 = Date.now();
  while (stack.length) {
    const dir = stack.pop(); let ents;
    try { ents = dir === root ? rootEnts : fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped.push({ p: toRel(root, dir), reason: 'unreadable (' + e.code + ')' }); continue; }
    if (dir !== root) {
      const why = packageReason(path.basename(dir), ents, false);
      if (why) { const s = treeStats(dir); packages.push({ p: toRel(root, dir), reason: why, files: s.files, bytes: s.bytes }); continue; }
    }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      if (e.name.toLowerCase() === RUN_DIR && e.isDirectory()) { if (dir !== root) skipped.push({ p: toRel(root, abs), reason: 'an earlier tidy run (its journal and quarantine)' }); continue; }
      if (SYSTEM_FILES.has(e.name.toLowerCase())) { hiddenFiles++; continue; }
      if (e.name.startsWith('.')) { if (e.isDirectory()) skipped.push({ p: toRel(root, abs), reason: 'hidden folder' }); else hiddenFiles++; continue; }
      if (e.isSymbolicLink()) { skipped.push({ p: toRel(root, abs), reason: 'link or junction (not followed)' }); continue; }
      if (e.isDirectory()) {
        if (PROTECTED_NAMES.has(e.name.toLowerCase()) || isProtected(abs, prot)) { skipped.push({ p: toRel(root, abs), reason: 'protected' }); continue; }
        try { if (fs.statSync(abs).dev !== st.dev) { skipped.push({ p: toRel(root, abs), reason: 'another disk mounted here' }); continue; } } catch { /* unreadable: handled when entered */ }
        if (protIdSet.size) { const id = idOf(abs); if (id && protIdSet.has(id)) { skipped.push({ p: toRel(root, abs), reason: 'protected' }); continue; } }
        if (dir === root) topDirs.push(abs);
        stack.push(abs); continue;
      }
      if (!e.isFile()) { skipped.push({ p: toRel(root, abs), reason: 'special file' }); continue; }
      if (isProtected(abs, prot)) { skipped.push({ p: toRel(root, abs), reason: 'protected' }); continue; }
      let fst; try { fst = fs.statSync(abs); } catch (err) { skipped.push({ p: toRel(root, abs), reason: 'unreadable (' + err.code + ')' }); continue; }
      files.push(fileRecord(root, abs, fst, dir === root));
      if (files.length >= maxFiles) { truncated = true; break; }
    }
    if (truncated) break;
  }

  // Duplicates: same size -> same first 64 KB -> same SHA-256 of the whole file.
  const bySize = new Map();
  // --no-dupes: for cloud folders with files on demand, where reading a file downloads it.
  if (!args['no-dupes']) for (const f of files) if (f.size > 0 && !f.flags.includes('lockfile') && !f.flags.includes('partial')) {
    if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(f);
  }
  const notCompared = [];
  const sizeGroups = [...bySize.values()].filter((g) => g.length > 1);
  const heads = []; for (const g of sizeGroups) for (const f of g) heads.push(f);
  const headHash = new Map();
  await pool(heads, 4, async (f) => {
    if (maxHash && f.size > maxHash) { notCompared.push({ p: f.p, reason: `larger than --max-hash-mb (${fmtBytes(f.size)})` }); return; }
    try { headHash.set(f.p, await sha256File(fromRel(root, f.p), 65536)); } catch (e) { notCompared.push({ p: f.p, reason: 'unreadable (' + e.code + ')' }); }
  });
  const fullCands = [];
  for (const g of sizeGroups) {
    const m = new Map();
    for (const f of g) { const h = headHash.get(f.p); if (!h) continue; if (!m.has(h)) m.set(h, []); m.get(h).push(f); }
    for (const sub of m.values()) if (sub.length > 1) fullCands.push(...sub);
  }
  let hashedBytes = 0;
  await pool(fullCands, 4, async (f) => {
    try { f.sha256 = f.size <= 65536 ? headHash.get(f.p) : await sha256File(fromRel(root, f.p)); hashedBytes += f.size; } catch (e) { notCompared.push({ p: f.p, reason: 'unreadable (' + e.code + ')' }); }
  });
  const byHash = new Map();
  for (const f of fullCands) if (f.sha256) { const k = f.size + ':' + f.sha256; if (!byHash.has(k)) byHash.set(k, []); byHash.get(k).push(f); }
  // Hard links are one file under two names: keep one name per file before calling it a duplicate.
  for (const [k, g] of byHash) {
    const seenIds = new Set(); const uniq = [];
    for (const f of g) { const id = idOf(fromRel(root, f.p)); if (id && seenIds.has(id)) continue; if (id) seenIds.add(id); uniq.push(f); }
    byHash.set(k, uniq);
  }
  const dupes = [...byHash.values()].filter((g) => g.length > 1).map((g) => ({
    sha256: g[0].sha256, size: g[0].size, files: g.map((f) => f.p).sort(),
    namesDiffer: new Set(g.map((f) => cleanStem(path.basename(f.p)))).size > 1,
  })).sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));

  // Identical folders: packages and top-level folders with the same file count and bytes.
  const folderCands = [...packages.map((p) => ({ p: p.p, files: p.files, bytes: p.bytes }))];
  for (const d of topDirs) { if (packages.some((p) => p.p === toRel(root, d))) continue; const s = treeStats(d); if (!s.links) folderCands.push({ p: toRel(root, d), files: s.files, bytes: s.bytes }); }
  const fGroups = new Map();
  for (const c of folderCands) if (c.files > 0) { const k = c.files + ':' + c.bytes; if (!fGroups.has(k)) fGroups.set(k, []); fGroups.get(k).push(c); }
  const folderDupes = [];
  for (const g of fGroups.values()) {
    if (g.length < 2) continue;
    const used = new Set();
    for (let i = 0; i < g.length; i++) {
      if (used.has(i)) continue; const same = [g[i].p];
      for (let j = i + 1; j < g.length; j++) {
        if (used.has(j)) continue;
        if (isInside(fromRel(root, g[j].p), fromRel(root, g[i].p)) || isInside(fromRel(root, g[i].p), fromRel(root, g[j].p))) continue;
        try { if (sameTree(fromRel(root, g[i].p), fromRel(root, g[j].p))) { same.push(g[j].p); used.add(j); } } catch { /* unreadable */ }
      }
      if (same.length > 1) folderDupes.push({ folders: same, files: g[i].files, bytes: g[i].bytes });
    }
  }

  const cloud = /(onedrive|google drive|googledrive|my drive|dropbox|icloud|mega|pcloud|nextcloud)/i.test(root);
  const scan = {
    tool: 'tidy-files', format: FORMAT, created: new Date().toISOString(), platform: process.platform,
    root, robosRoot: ROBOS_ROOT, protect: args.protect.map((p) => path.resolve(p)),
    truncated, cloud, rootPackageOverride: rootPkg || null, allowDriveRoot: Boolean(args['allow-drive-root']), dupesSkipped: Boolean(args['no-dupes']),
    files, packages, skipped, hiddenFiles, dupes, folderDupes, notCompared,
    hashed: { files: fullCands.length, bytes: hashedBytes }, seconds: Math.round((Date.now() - t0) / 1000),
  };
  const outDir = path.resolve(args.out || defaultOutDir());
  fs.mkdirSync(outDir, { recursive: true });
  const scanFile = path.join(outDir, 'scan.json'); writeJson(scanFile, scan);
  const sumFile = path.join(outDir, 'summary.txt'); fs.writeFileSync(sumFile, summaryText(scan), 'utf8');
  console.log(summaryText(scan, 12));
  console.log(`scan: ${scanFile}`); console.log(`summary: ${sumFile}`);
}

function defaultOutDir() {
  const d = new Date(); const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (ROBOS_ROOT) return path.join(ROBOS_ROOT, '.scratch', ym, 'tool-tidy-files', stamp(d));
  return path.join(os.tmpdir(), 'tidy-files', stamp(d));
}

function summaryText(s, listMax = 40) {
  const L = [CREDIT];
  const total = s.files.reduce((a, f) => a + f.size, 0);
  const top = s.files.filter((f) => f.top);
  L.push(`Folder: ${s.root}`);
  L.push(`Files: ${s.files.length} (${fmtBytes(total)}), of which ${top.length} loose at the top level. Scan took ${s.seconds}s.`);
  if (s.truncated) L.push(`WARNING: stopped at --max-files; the scan is partial.`);
  if (s.cloud) L.push('NOTE: this looks like a cloud-synced folder; every move is also synced to the cloud and to the other devices.');
  const byCat = {};
  for (const f of s.files) { byCat[f.cat] = byCat[f.cat] || { n: 0, b: 0 }; byCat[f.cat].n++; byCat[f.cat].b += f.size; }
  L.push('By type: ' + Object.entries(byCat).sort((a, b) => b[1].b - a[1].b).map(([c, v]) => `${c} ${v.n} (${fmtBytes(v.b)})`).join(', '));
  const now = Date.now(); const age = { '<30 days': 0, '<1 year': 0, '1-3 years': 0, '>3 years': 0 };
  for (const f of s.files) { const d = (now - f.mtime) / 864e5; age[d < 30 ? '<30 days' : d < 365 ? '<1 year' : d < 1095 ? '1-3 years' : '>3 years']++; }
  L.push('By last change: ' + Object.entries(age).map(([k, v]) => `${k} ${v}`).join(', '));
  const flagCount = (fl) => s.files.filter((f) => f.flags.includes(fl)).length;
  L.push(`Marked: screenshots ${flagCount('screenshot')}, camera photos ${flagCount('camera')}, WhatsApp media ${flagCount('whatsapp')}, conflicted copies ${flagCount('conflict')}, copy-like names ${flagCount('copyname')}, unfinished downloads ${flagCount('partial')}, office lock files ${flagCount('lockfile')}, installers ${flagCount('installer')}.`);
  const reclaim = s.dupes.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
  L.push(`Duplicates (whole-file SHA-256): ${s.dupes.length} groups, ${s.dupes.reduce((a, g) => a + g.files.length, 0)} files, ${fmtBytes(reclaim)} held by the extra copies; ${s.dupes.filter((g) => g.namesDiffer).length} groups have different names.`);
  for (const g of s.dupes.slice(0, listMax)) L.push(`  - ${fmtBytes(g.size)} x${g.files.length}${g.namesDiffer ? ' [names differ]' : ''}: ${g.files.join(' | ')}`);
  if (s.notCompared.length) L.push(`Not compared (counted as unknown, not as unique): ${s.notCompared.length}`);
  if (s.folderDupes.length) { L.push(`Identical folders: ${s.folderDupes.length}`); for (const g of s.folderDupes.slice(0, listMax)) L.push(`  - ${g.files} files, ${fmtBytes(g.bytes)}: ${g.folders.join(' | ')}`); }
  L.push(`Packages kept whole (never split): ${s.packages.length}`);
  for (const p of s.packages.slice(0, listMax)) L.push(`  - ${p.p} (${p.reason}; ${p.files} files, ${fmtBytes(p.bytes)})`);
  const big = [...s.files].sort((a, b) => b.size - a.size).slice(0, 10);
  L.push('Largest files: ' + big.map((f) => `${f.p} (${fmtBytes(f.size)})`).join('; '));
  if (s.skipped.length || s.hiddenFiles) L.push(`Skipped: ${s.skipped.length} folders or files (protected, hidden, links, unreadable) and ${s.hiddenFiles} hidden files.`);
  for (const k of s.skipped.slice(0, listMax)) L.push(`  - ${k.p}: ${k.reason}`);
  if (s.robosRoot) L.push(`The robOS installation (${s.robosRoot}) is protected and never touched.`);
  if (s.protect && s.protect.length) L.push(`Also protected for this scan: ${s.protect.join('; ')}`);
  const perm = permanentProtect().paths; if (perm.length) L.push(`Protected by protect.txt: ${perm.join('; ')}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- plan

const LABELS = {
  ro: { documents: 'Documente', spreadsheets: 'Tabele', presentations: 'Prezentări', pdf: 'PDF', images: 'Imagini', screenshot: 'Capturi de ecran', camera: 'Fotografii', whatsapp: 'WhatsApp', design: 'Design', video: 'Video', audio: 'Audio', archives: 'Arhive', installers: 'Kituri de instalare', ebooks: 'Cărți electronice', code: 'Cod', fonts: 'Fonturi', other: 'Altele', archive: '4-Arhivă' },
  en: { documents: 'Documents', spreadsheets: 'Spreadsheets', presentations: 'Presentations', pdf: 'PDF', images: 'Images', screenshot: 'Screenshots', camera: 'Photos', whatsapp: 'WhatsApp', design: 'Design', video: 'Video', audio: 'Audio', archives: 'Archives', installers: 'Installers', ebooks: 'Ebooks', code: 'Code', fonts: 'Fonts', other: 'Other', archive: '4-Archive' },
};
const STOP = new Set(('final copy copie draft new nou noua old vechi img image imagine scan scanned document doc file fisier the and for with din pentru care sau version versiune untitled fara titlu screenshot captura ecran export download pdf docx xlsx pptx jpg jpeg png page pagina edit edited ver rev revised www http https com '
  + 'jan feb mar apr may jun jul aug sep oct nov dec ian mai iun iul noi').split(' '));
function tokens(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^v\d+$/.test(t) && !STOP.has(t));
}
function buildVocab(projectsAbs) {
  const vocab = [];
  let ents = []; try { ents = fs.readdirSync(projectsAbs, { withFileTypes: true }); } catch { return vocab; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === RUN_DIR) continue;
    const w = new Map(); for (const t of tokens(e.name)) w.set(t, 3);
    const stack = [path.join(projectsAbs, e.name)]; let seen = 0;
    while (stack.length && seen < 300) {
      const d = stack.pop(); let sub; try { sub = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const s of sub) {
        if (s.isSymbolicLink() || s.name.startsWith('.')) continue;
        if (s.isDirectory()) { for (const t of tokens(s.name)) if (!w.has(t)) w.set(t, 2); stack.push(path.join(d, s.name)); } else if (s.isFile()) { seen++; for (const t of tokens(stem(s.name))) if (!w.has(t)) w.set(t, 1); }
      }
    }
    vocab.push({ name: e.name, w });
  }
  return vocab;
}

// True when a part of the destination path already exists as a file, not a folder.
function blockedByFile(root, rel) {
  const segs = rel.split('/'); let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    let st; try { st = fs.lstatSync(cur, { throwIfNoEntry: false }); } catch { return true; } // unreadable: treat as blocked
    if (!st) return false;
    if (!st.isDirectory()) return true;
  }
  return false;
}

function cmdPlan(args) {
  const scanFile = args._[1]; if (!scanFile) die('usage: plan <scan.json> --mode ...');
  const scan = readJson(scanFile);
  if (scan.tool !== 'tidy-files') die('not a tidy-files scan');
  const mode = args.mode; if (!['type', 'date', 'type-date', 'projects', 'para', 'dupes'].includes(mode)) die('--mode must be type, date, type-date, projects, para or dupes');
  if (mode === 'dupes' && args.dupes === 'report') die('--mode dupes sets duplicates aside; it cannot be combined with --dupes report');
  const lang = (args.lang || process.env.ROBOS_LANG || 'en').toLowerCase().startsWith('ro') ? 'ro' : 'en';
  const lab = LABELS[lang]; const root = scan.root;
  const allDepths = Boolean(args['all-depths']);
  const dupeMode = args.dupes || 'quarantine';
  const archiveMonths = Number(args['archive-months'] || 12);
  let projectsRel = null; let vocab = [];
  if (mode === 'projects') {
    const pAbs = path.resolve(args.projects ? path.resolve(root, args.projects) : root);
    if (!isInside(pAbs, root)) die('--projects must be inside the scanned folder');
    projectsRel = toRel(root, pAbs); vocab = buildVocab(pAbs);
    if (!vocab.length) die(`no project folders found in ${pAbs}`);
  }
  const inScope = (f) => (allDepths ? true : f.top);
  const byPath = new Map(scan.files.map((f) => [f.p, f]));
  const entries = []; const quarantined = new Set();
  const review = { unassigned: [], partial: [], lockfiles: [], installersOld: [], conflicted: [], duplicatesOutOfScope: [], identicalFolders: scan.folderDupes };

  if (dupeMode === 'quarantine') {
    for (const g of scan.dupes) {
      const recs = g.files.map((p) => byPath.get(p)).filter(Boolean);
      // Keep: one already filed in a subfolder, then the cleanest name, then the oldest.
      const rank = (f) => [f.top ? 1 : 0, f.flags.includes('copyname') || f.flags.includes('conflict') ? 1 : 0, f.mtime];
      const keep = [...recs].sort((a, b) => { const ra = rank(a); const rb = rank(b); for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return a.p.length - b.p.length; })[0];
      const others = recs.filter((f) => f !== keep && inScope(f));
      if (!others.length) { review.duplicatesOutOfScope.push(g); continue; }
      for (const o of others) {
        entries.push({ kind: 'quarantine', unit: 'file', from: o.p, keep: keep.p, size: o.size, mtime: o.mtime, sha256: g.sha256, namesDiffer: g.namesDiffer, reason: 'same content as the kept copy (whole-file SHA-256)' });
        quarantined.add(o.p);
      }
    }
  } else review.duplicatesOutOfScope = scan.dupes;

  const nowMs = Date.now();
  const taken = new Set();
  const uniqueTo = (rel) => {
    let cand = rel; let n = 2;
    while (taken.has(cand.normalize('NFC').toLowerCase()) || exists(fromRel(root, cand))) {
      if (n > 1000) return null; // an unreadable destination folder makes every name look taken
      const dir = path.posix.dirname(rel); const base = path.posix.basename(rel); const e = path.posix.extname(base);
      cand = (dir === '.' ? '' : dir + '/') + base.slice(0, base.length - e.length) + ` (${n++})` + e;
    }
    taken.add(cand.normalize('NFC').toLowerCase()); return cand;
  };
  const typeLabel = (f) => {
    if (f.cat === 'images' || f.cat === 'video') {
      for (const fl of ['screenshot', 'whatsapp', 'camera']) if (f.flags.includes(fl)) return `${lab[f.cat]}/${lab[fl]}`;
    }
    return lab[f.cat] || lab.other;
  };
  for (const f of scan.files) {
    if (mode === 'dupes') break; // only the identical copies are set aside; every other file stays where it is
    if (!inScope(f) || quarantined.has(f.p)) continue;
    if (f.flags.includes('partial')) { review.partial.push(f.p); continue; }
    if (f.flags.includes('lockfile')) { review.lockfiles.push(f.p); continue; }
    if (f.flags.includes('conflict')) review.conflicted.push(f.p);
    if (f.flags.includes('installer') && nowMs - f.mtime > 180 * 864e5) review.installersOld.push(f.p);
    const name = path.posix.basename(f.p); const y = f.date.slice(0, 4); const ym = f.date.slice(0, 7);
    let dest = null; let reason = '';
    if (mode === 'type') { dest = `${typeLabel(f)}/${name}`; reason = `type: ${f.cat}`; }
    else if (mode === 'date') { dest = `${y}/${ym}/${name}`; reason = `date ${f.date}`; }
    else if (mode === 'type-date') { dest = `${typeLabel(f)}/${y}/${name}`; reason = `type ${f.cat}, year ${y}`; }
    else if (mode === 'para') {
      if (nowMs - f.mtime > archiveMonths * 30.4 * 864e5) { dest = `${lab.archive}/${y}/${name}`; reason = `not changed in ${archiveMonths} months`; }
    } else if (mode === 'projects') {
      if (projectsRel && isInside(fromRel(root, f.p), fromRel(root, projectsRel)) && projectsRel !== '') continue;
      const ft = new Set(tokens(stem(name)));
      const scores = vocab.map((v) => ({ v, s: [...ft].reduce((a, t) => a + (v.w.get(t) || 0), 0) })).sort((a, b) => b.s - a.s);
      const best = scores[0]; const second = scores[1] || { s: 0 };
      if (best && best.s >= 3 && best.s >= 1.5 * second.s) {
        const shared = [...ft].filter((t) => best.v.w.has(t));
        dest = `${projectsRel ? projectsRel + '/' : ''}${best.v.name}/${name}`; reason = `matches project "${best.v.name}" (${shared.join(', ')})`;
      }
    }
    if (!dest) { review.unassigned.push(f.p); continue; }
    if (key(dest) === key(f.p)) continue;
    if (blockedByFile(root, dest)) { review.unassigned.push(f.p); continue; } // a file sits where the folder would go
    const to = uniqueTo(dest); if (!to) { review.unassigned.push(f.p); continue; }
    entries.push({ kind: 'move', unit: 'file', from: f.p, to, size: f.size, mtime: f.mtime, reason });
  }
  entries.forEach((e, i) => { e.id = i + 1; });
  const plan = {
    tool: 'tidy-files', kind: 'plan', format: FORMAT, created: new Date().toISOString(), root, mode, lang, allDepths, dupes: dupeMode,
    robosRoot: scan.robosRoot, protect: scan.protect, packages: scan.packages.map((p) => p.p), cloud: scan.cloud,
    scanFile: path.resolve(scanFile), allowDriveRoot: Boolean(scan.allowDriveRoot),
    entries, review,
  };
  const out = path.resolve(args.out || path.join(path.dirname(path.resolve(scanFile)), 'plan.json'));
  writeJson(out, plan);
  const q = entries.filter((e) => e.kind === 'quarantine');
  console.log(`Plan (${mode}): ${entries.length - q.length} moves, ${q.length} duplicates to quarantine (${fmtBytes(q.reduce((a, e) => a + e.size, 0))}).`);
  console.log(`Left for a decision: ${review.unassigned.length} unassigned, ${review.partial.length} unfinished downloads, ${review.lockfiles.length} lock files, ${review.conflicted.length} conflicted copies, ${review.installersOld.length} installers older than 6 months, ${review.identicalFolders.length} identical folders, ${review.duplicatesOutOfScope.length} duplicate groups outside the moved files.`);
  console.log(`plan: ${out}`);
}

// ---------------------------------------------------------------- check

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function relProblem(rel, isDest) {
  if (typeof rel !== 'string' || !rel.trim()) return 'empty path';
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel)) return 'absolute path (must be relative to the folder)';
  const segs = rel.split(/[\\/]/);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return 'path with "..", "." or an empty part';
  for (const sg of segs) {
    const low = sg.toLowerCase();
    if (low === RUN_DIR) return `path through ${RUN_DIR}/ (a tidy run folder)`;
    if (sg.startsWith('.')) return `path through a hidden name: "${sg}"`;
    if (PROTECTED_NAMES.has(low)) return `path through a protected system folder: "${sg}"`;
    if (/\x00/.test(sg)) return 'name with a null character';
  }
  if (SYSTEM_FILES.has(segs[segs.length - 1].toLowerCase())) return 'a system file (folder icon or thumbnails)';
  if (IS_WIN) { // on other systems these names already exist on the disk and are fine
    for (const sg of segs) {
      if (/[<>:"|?*\x01-\x1f]/.test(sg)) return `name not allowed on Windows: "${sg}"`; // ":" would also reach a hidden data stream
      if (isDest && /[. ]$/.test(sg)) return `name ends with a dot or space: "${sg}"`;
      if (isDest && WIN_RESERVED.test(sg)) return `reserved name on Windows: "${sg}"`;
    }
  }
  return null;
}

function checkPlan(plan, { quiet } = {}) {
  const errors = []; const warnings = [];
  if (plan.tool !== 'tidy-files' || plan.kind !== 'plan') return { errors: ['not a tidy-files plan'], warnings };
  const root = plan.root;
  let rst; try { rst = fs.statSync(root); } catch { return { errors: [`folder not found: ${root}`], warnings }; }
  if (!rst.isDirectory()) return { errors: [`not a folder: ${root}`], warnings };
  // The scan is the source of truth for the folder, its protections and its packages: a plan cannot drop them.
  let sc = null; try { sc = JSON.parse(fs.readFileSync(plan.scanFile, 'utf8')); } catch { /* missing or unreadable */ }
  if (!sc || sc.tool !== 'tidy-files') return { errors: ['the plan has no readable scan (scanFile); make plans with the plan command from a scan'], warnings };
  if (norm(sc.root) !== norm(root)) return { errors: [`the plan's folder (${root}) is not the scanned folder (${sc.root})`], warnings };
  if (path.parse(path.resolve(root)).root === path.resolve(root) && !sc.allowDriveRoot) return { errors: ['the plan works on the root of a disk; scan with --allow-drive-root if the operator asked for that'], warnings };
  const pp = permanentProtect(); if (pp.errors.length) return { errors: pp.errors, warnings };
  const scanProtect = sc.protect || []; const scanPackages = (sc.packages || []).map((p) => p.p);
  if (!sc.rootPackageOverride && packageReason(path.basename(root), fs.readdirSync(root, { withFileTypes: true }), true)) errors.push('the folder itself looks like a package now; scan it again');
  const prot = protectedList([...(plan.protect || []), ...scanProtect]); const protIdSet = protIds(prot);
  if (isProtected(root, prot)) errors.push('the folder is protected');
  const realRoot = real(root) || root;
  // A path is safe when the real place it resolves to (after links, junctions and short names) is inside the folder and not protected.
  const realInside = (abs) => { const r = real(abs); return Boolean(r) && isInside(r, realRoot) && !isProtected(r, prot) && !idProtected(r, realRoot, protIdSet); };
  const pkgs = [...new Set([...(plan.packages || []), ...scanPackages])].map((p) => fromRel(root, p));
  // Packages are also looked for again on disk, so a plan that lost its list cannot split one.
  const pkgCache = new Map();
  const pkgAncestor = (abs) => {
    const segs = toRel(root, abs).split('/'); let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      cur = path.join(cur, segs[i]);
      if (!pkgCache.has(cur)) { let why = null; try { const st = fs.lstatSync(cur); if (st.isDirectory() && !st.isSymbolicLink()) why = packageReason(segs[i], fs.readdirSync(cur, { withFileTypes: true }), false); } catch { /* not there */ } pkgCache.set(cur, why); }
      if (pkgCache.get(cur)) return cur;
    }
    return null;
  };
  // A folder that moves whole must not carry a protected place, a link, a system folder, an earlier run or a robOS installation.
  const folderHazard = (dir) => {
    const rdir = real(dir) || dir;
    if (prot.some((p) => isInside(p, dir) || isInside(p, rdir))) return 'it contains a protected folder';
    if (protIdSet.size) { const id = idOf(dir); if (id && protIdSet.has(id)) return 'it is a protected folder'; }
    const stack = [dir]; let seen = 0;
    while (stack.length) {
      if (seen >= 200000) return 'too large to verify (over 200,000 entries); move its subfolders instead';
      const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return `unreadable folder inside: ${toRel(root, d)}`; }
      if (ents.some((x) => x.name === 'CLAUDE.md') && ents.some((x) => x.name === 'skills') && ents.some((x) => x.name === 'scripts')) return `it contains a robOS installation (${toRel(root, d)})`;
      for (const x of ents) {
        seen++;
        if (x.isSymbolicLink()) return `it contains a link or junction (${toRel(root, path.join(d, x.name))})`;
        if (x.isDirectory()) {
          const low = x.name.toLowerCase(); const sub = path.join(d, x.name);
          if (PROTECTED_NAMES.has(low) || low === RUN_DIR) return `it contains ${x.name}`;
          if (protIdSet.size) { const id = idOf(sub); if (id && protIdSet.has(id)) return `it contains a protected folder (${toRel(root, sub)})`; }
          stack.push(sub);
        }
      }
    }
    return null;
  };
  const rootDev = rst.dev;
  const entries = plan.entries || [];
  const froms = new Map(); const tos = new Map();
  const ci = (rel) => rel.normalize('NFC').toLowerCase(); // destinations collide case-insensitively everywhere
  const qFroms = new Set(entries.filter((e) => e.kind === 'quarantine').map((e) => key(e.from || '')));
  for (const e of entries) {
    const tag = `#${e.id ?? '?'} ${e.from}`;
    if (!['move', 'quarantine'].includes(e.kind)) { errors.push(`${tag}: kind must be move or quarantine`); continue; }
    if (!['file', 'folder'].includes(e.unit || 'file')) { errors.push(`${tag}: unit must be file or folder`); continue; }
    const unit = e.unit || 'file';
    const pf = relProblem(e.from, false); if (pf) { errors.push(`${tag}: from: ${pf}`); continue; }
    const fromAbs = fromRel(root, e.from);
    if (!isInside(fromAbs, root)) { errors.push(`${tag}: from leaves the folder`); continue; }
    if (isProtected(fromAbs, prot)) { errors.push(`${tag}: from is protected`); continue; }
    const inPkg = pkgs.find((p) => isInside(fromAbs, p)) || pkgAncestor(fromAbs);
    if (inPkg && !(unit === 'folder' && norm(inPkg) === norm(fromAbs))) { errors.push(`${tag}: from is inside the package ${toRel(root, inPkg)} (packages move only whole)`); continue; }
    if (unit === 'folder' && pkgs.some((p) => isInside(fromAbs, p) === false && isInside(p, fromAbs) && norm(p) !== norm(fromAbs))) warnings.push(`${tag}: the folder holds a package; it moves whole, with the folder`);
    let fst; try { fst = fs.lstatSync(fromAbs); } catch { errors.push(`${tag}: from does not exist (moved or renamed since the scan?)`); continue; }
    if (fst.isSymbolicLink()) { errors.push(`${tag}: from is a link`); continue; }
    if (!realInside(fromAbs)) { errors.push(`${tag}: from is protected, or goes through a link or junction to a place outside the folder`); continue; }
    if (unit === 'file' && !fst.isFile()) { errors.push(`${tag}: from is not a file`); continue; }
    if (unit === 'folder' && !fst.isDirectory()) { errors.push(`${tag}: from is not a folder`); continue; }
    if (unit === 'folder') { const hz = folderHazard(fromAbs); if (hz) { errors.push(`${tag}: this folder cannot move whole: ${hz}`); continue; } }
    if (unit === 'file') {
      if (e.size === undefined) { e.size = fst.size; e.mtime = Math.round(fst.mtimeMs); }
      else if (fst.size !== e.size || Math.abs(Math.round(fst.mtimeMs) - e.mtime) > MTIME_TOLERANCE_MS) { errors.push(`${tag}: the file changed since the scan; scan again`); continue; }
    }
    const fk = CASE_INSENSITIVE ? key(e.from) : e.from;
    if (froms.has(fk)) { errors.push(`${tag}: the same file appears twice in the plan`); continue; }
    froms.set(fk, e);
    if (e.kind === 'move') {
      const pt = relProblem(e.to, true); if (pt) { errors.push(`${tag}: to: ${pt}`); continue; }
      const toAbs = fromRel(root, e.to);
      if (!isInside(toAbs, root)) { errors.push(`${tag}: to leaves the folder`); continue; }
      if (isProtected(toAbs, prot)) { errors.push(`${tag}: to is protected`); continue; }
      const toPkg = pkgs.find((p) => isInside(toAbs, p)) || pkgAncestor(toAbs);
      if (toPkg) { errors.push(`${tag}: to is inside the package ${toRel(root, toPkg)}`); continue; }
      if (unit === 'folder' && isInside(toAbs, fromAbs)) { errors.push(`${tag}: a folder cannot move inside itself`); continue; }
      if (exists(toAbs)) { errors.push(`${tag}: to already exists (${e.to}); nothing is ever overwritten`); continue; }
      let anc = path.dirname(toAbs); let ok = true;
      while (isInside(anc, root) && norm(anc) !== norm(root)) {
        if (fs.existsSync(anc)) { const ast = fs.lstatSync(anc); if (!ast.isDirectory() || ast.isSymbolicLink()) { errors.push(`${tag}: a part of the destination is not a folder: ${toRel(root, anc)}`); ok = false; } break; }
        anc = path.dirname(anc);
      }
      if (!ok) continue;
      if (!realInside(anc)) { errors.push(`${tag}: to goes through a link or junction to a place outside the folder or protected`); continue; }
      if (fs.existsSync(anc)) { try { if (fs.statSync(anc).dev !== rootDev) { errors.push(`${tag}: the destination is on another disk`); continue; } } catch { /* stat failed */ } }
      if (tos.has(ci(e.to))) { errors.push(`${tag}: two entries go to the same place: ${e.to}`); continue; }
      tos.set(ci(e.to), e);
    } else {
      const pk = relProblem(e.keep, false); if (pk) { errors.push(`${tag}: keep: ${pk}`); continue; }
      const keepAbs = fromRel(root, e.keep);
      if (key(e.keep) === key(e.from) || (exists(keepAbs) && sameFile(keepAbs, fromAbs))) { errors.push(`${tag}: keep and from are the same file (one copy must stay)`); continue; }
      if (qFroms.has(key(e.keep))) { errors.push(`${tag}: the kept copy is itself sent to quarantine; one copy must stay`); continue; }
      let kst; try { kst = fs.lstatSync(keepAbs); } catch { errors.push(`${tag}: the kept copy does not exist: ${e.keep}`); continue; }
      if (kst.isSymbolicLink() || !realInside(keepAbs)) { errors.push(`${tag}: the kept copy is a link, protected, or outside the folder`); continue; }
      if (unit === 'file' && (!kst.isFile() || kst.size !== fst.size)) { errors.push(`${tag}: the kept copy is not a file of the same size`); continue; }
      if (unit === 'folder' && !kst.isDirectory()) { errors.push(`${tag}: the kept copy is not a folder`); continue; }
    }
  }
  for (const e of entries) {
    if (e.kind === 'move' && froms.has(key(e.to))) errors.push(`#${e.id} ${e.from}: goes where another entry starts (${e.to}); chains are not allowed`);
    if ((e.unit || 'file') === 'folder') for (const o of entries) if (o !== e && o.from && e.from && isInside(fromRel(root, o.from), fromRel(root, e.from))) errors.push(`#${o.id} ${o.from}: is inside the folder moved by #${e.id}`);
  }
  if (!quiet) {
    for (const w of warnings) console.log('WARNING: ' + w);
  }
  return { errors, warnings };
}

function previewText(plan) {
  const L = [CREDIT]; const q = plan.entries.filter((e) => e.kind === 'quarantine'); const mv = plan.entries.filter((e) => e.kind === 'move');
  L.push(`Folder: ${plan.root}`);
  L.push(`Moves: ${mv.length}. To quarantine (identical copies, the kept copy stays): ${q.length}, ${fmtBytes(q.reduce((a, e) => a + (e.size || 0), 0))}.`);
  const byDest = new Map();
  for (const e of mv) { const d = path.posix.dirname(e.to); if (!byDest.has(d)) byDest.set(d, []); byDest.get(d).push(e); }
  for (const [d, list] of [...byDest.entries()].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`\n-> ${d}/  (${list.length})`);
    for (const e of list.slice(0, 15)) L.push(`   ${e.from}${path.posix.basename(e.to) !== path.posix.basename(e.from) ? '  =>  ' + path.posix.basename(e.to) : ''}`);
    if (list.length > 15) L.push(`   ... and ${list.length - 15} more`);
  }
  if (q.length) {
    L.push('\nQuarantine (moved to _tidy/<run>/quarantine/, not deleted):');
    for (const e of q) L.push(`   ${e.from}   (same as: ${e.keep})${e.namesDiffer ? '   [different name: show it to the operator]' : ''}`);
  }
  const r = plan.review || {};
  const sec = (title, list) => { if (list && list.length) { L.push(`\n${title} (${list.length}):`); for (const p of list.slice(0, 30)) L.push('   ' + (typeof p === 'string' ? p : (p.folders || p.files).join(' | '))); if (list.length > 30) L.push(`   ... and ${list.length - 30} more`); } };
  sec('Not placed, needs a decision', r.unassigned);
  sec('Unfinished downloads (left in place)', r.partial);
  sec('Office lock files (left in place)', r.lockfiles);
  sec('Conflicted copies (compare with the original before deciding)', r.conflicted);
  sec('Installers older than 6 months (candidates, nothing done)', r.installersOld);
  sec('Identical folders (nothing done)', r.identicalFolders);
  return L.join('\n') + '\n';
}

function cmdCheck(args) {
  const f = args._[1]; if (!f) die('usage: check <plan.json>');
  const plan = readJson(f);
  const { errors } = checkPlan(plan);
  const prev = path.join(path.dirname(path.resolve(f)), 'preview.txt');
  if (errors.length) { console.log(`Plan NOT valid: ${errors.length} problem(s).`); for (const e of errors.slice(0, 50)) console.log(' - ' + e); process.exit(2); }
  fs.writeFileSync(prev, previewText(plan), 'utf8');
  console.log(previewText(plan).split('\n').slice(0, 60).join('\n'));
  console.log(`Plan valid. preview: ${prev}`);
}

// ---------------------------------------------------------------- apply

function cmdApply(args) {
  const f = args._[1]; if (!f) die('usage: apply <plan.json> --yes');
  if (!args.yes) die('apply moves files: run it only after the operator approved the preview, with --yes.');
  const plan = readJson(f);
  const { errors } = checkPlan(plan, { quiet: true });
  if (errors.length) { console.log(`Plan NOT valid, nothing moved: ${errors.length} problem(s).`); for (const e of errors.slice(0, 50)) console.log(' - ' + e); process.exit(2); }
  const root = plan.root;
  // Each run gets its own folder, even when two runs start in the same second.
  fs.mkdirSync(fromRel(root, RUN_DIR), { recursive: true });
  let id = stamp(); let runAbs;
  for (let n = 1; ; n++) {
    const cand = n === 1 ? id : `${id}-${n}`;
    try { fs.mkdirSync(fromRel(root, `${RUN_DIR}/${cand}`)); id = cand; runAbs = fromRel(root, `${RUN_DIR}/${cand}`); break; } catch (err) { if (err.code !== 'EEXIST' || n > 50) throw err; }
  }
  const runRel = `${RUN_DIR}/${id}`;
  writeJson(path.join(runAbs, 'plan.json'), plan);
  const jfd = fs.openSync(path.join(runAbs, 'journal.jsonl'), 'a');
  const journal = (o) => { fs.writeSync(jfd, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); fs.fsyncSync(jfd); };
  const ensureDir = (absDir) => {
    const missing = []; let d = absDir;
    while (!fs.existsSync(d)) { missing.push(d); const up = path.dirname(d); if (up === d) break; d = up; }
    for (const m of missing.reverse()) { fs.mkdirSync(m); journal({ op: 'mkdir', path: toRel(root, m) }); }
  };
  const order = [...plan.entries.filter((e) => e.kind === 'quarantine'), ...plan.entries.filter((e) => e.kind === 'move')];
  const limit = args.limit ? Number(args.limit) : order.length;
  let done = 0; const skipped = []; const journalWarnings = []; const manifest = ['from\tkept_copy\tsize\tsha256'];
  for (const e of order.slice(0, limit)) {
    const unit = e.unit || 'file';
    const src = fromRel(root, e.from); let moved = false;
    try {
      if (!exists(src)) { skipped.push(`${e.from}: no longer there`); continue; }
      if (unit === 'file') {
        const st = fs.statSync(src);
        if (st.size !== e.size || Math.abs(Math.round(st.mtimeMs) - e.mtime) > MTIME_TOLERANCE_MS) { skipped.push(`${e.from}: changed since the scan`); continue; }
      }
      let destRel;
      if (e.kind === 'quarantine') {
        const keepAbs = fromRel(root, e.keep);
        if (!exists(keepAbs) || sameFile(src, keepAbs)) { skipped.push(`${e.from}: the kept copy is missing or is the same file; left in place`); continue; }
        const same = unit === 'file' ? sameBytes(src, keepAbs) : sameTree(src, keepAbs);
        if (!same) { skipped.push(`${e.from}: not byte-identical to ${e.keep} right now; left in place`); journal({ op: 'skip', id: e.id, from: e.from, reason: 'not identical' }); continue; }
        destRel = `${runRel}/quarantine/${e.from}`;
      } else destRel = e.to;
      const dest = fromRel(root, destRel);
      ensureDir(path.dirname(dest));
      const sig = fileSig(src);
      journal({ op: 'move', id: e.id, kind: e.kind, from: e.from, to: destRel, sig, status: 'start' });
      // Checked as the very last step before the move: rename would replace whatever is there.
      if (exists(dest)) { skipped.push(`${e.from}: ${destRel} exists now; nothing overwritten`); journal({ op: 'skip', id: e.id, reason: 'destination appeared' }); continue; }
      fs.renameSync(src, dest); moved = true;
      if (e.kind === 'quarantine') manifest.push(`${e.from}\t${e.keep}\t${e.size ?? ''}\t${e.sha256 ?? ''}`);
      done++;
      journal({ op: 'move', id: e.id, status: 'done' });
    } catch (err) {
      if (moved) { journalWarnings.push(`${e.from}: moved, but the journal could not record it (${err.code || err.message}); undo still finds it`); continue; }
      skipped.push(`${e.from}: ${err.code === 'EXDEV' ? 'the destination is on another disk' : err.message}`);
      try { journal({ op: 'error', id: e.id, from: e.from, error: String(err.code || err.message) }); } catch { /* disk full: the report still lists it */ }
    }
  }
  fs.closeSync(jfd);
  if (manifest.length > 1) fs.writeFileSync(path.join(runAbs, 'quarantine-manifest.tsv'), manifest.join('\n') + '\n', 'utf8');
  let restFile = null;
  if (limit < order.length) { // a trial batch: the rest of the plan, to apply after the operator looked
    restFile = path.resolve(f).replace(/(\.rest)?\.json$/i, '') + '.rest.json';
    writeJson(restFile, { ...plan, entries: order.slice(limit), created: new Date().toISOString() });
  }
  const rep = [CREDIT, `Run ${id} in ${root}`, `Done: ${done} of ${Math.min(limit, order.length)}${limit < order.length ? ` (trial batch; ${order.length - limit} left)` : ''}.`,
    `Skipped: ${skipped.length}${restFile && skipped.length ? ' (not in the rest plan: scan again to include them)' : ''}`, ...skipped.map((s) => ' - ' + s),
    ...journalWarnings.map((s) => ' ! ' + s),
    ...(restFile ? [`The rest of the plan (${order.length - limit} entries): ${restFile} (check it, then apply it)`] : []),
    `Undo everything from this run: node tidy.mjs undo "${root}" --run ${id}`,
    `Quarantine: ${fromRel(root, runRel + '/quarantine')} (nothing was deleted; the operator empties it after checking).`];
  fs.writeFileSync(path.join(runAbs, 'report.txt'), rep.join('\n') + '\n', 'utf8');
  console.log(rep.join('\n'));
  process.exit(skipped.length ? 1 : 0);
}

// ---------------------------------------------------------------- undo and runs

// Identity of what moved: inode where the disk has one, else size and time.
function fileSig(p) {
  try { const st = fs.lstatSync(p, { bigint: true }); return { ino: st.ino.toString(), size: Number(st.size), mtime: Math.round(Number(st.mtimeMs)), dir: st.isDirectory() }; } catch { return null; }
}
function sigMatches(sig, p) {
  if (!sig) return true; // journals from before signatures
  const now = fileSig(p); if (!now) return false;
  if (sig.dir || now.dir) return sig.dir === now.dir;
  if (sig.ino !== '0' && sig.ino === now.ino) return true;
  // FAT32/exFAT number a file by its place, so the number changes with every move: size and time decide there.
  return sig.size === now.size && Math.abs(sig.mtime - now.mtime) <= MTIME_TOLERANCE_MS;
}

function listRuns(root) {
  const base = path.join(root, RUN_DIR);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'journal.jsonl'))).map((e) => e.name).sort();
}

function cmdUndo(args) {
  const target = args._[1]; if (!target) die('usage: undo <folder> [--run ID]');
  const root = path.resolve(target);
  const runs = listRuns(root); if (!runs.length) die(`no runs in ${path.join(root, RUN_DIR)}`);
  const id = args.run || [...runs].reverse().find((r) => !fs.existsSync(path.join(root, RUN_DIR, r, 'UNDONE')));
  if (!id || !runs.includes(id)) die('run not found (or every run is already undone): ' + (args.run || ''));
  const runAbs = path.join(root, RUN_DIR, id);
  if (fs.existsSync(path.join(runAbs, 'UNDONE'))) die(`run ${id} is already undone`);
  const lines = fs.readFileSync(path.join(runAbs, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const moves = new Map(); const order = []; const dirs = [];
  for (const l of lines) {
    if (l.op === 'mkdir') dirs.push(l.path);
    if (l.op === 'move' && l.status === 'start') { moves.set(l.id + ':' + l.from, { ...l, done: false }); order.push(l.id + ':' + l.from); }
    if (l.op === 'move' && l.status === 'done') { const k = order.filter((x) => x.startsWith(l.id + ':')).pop(); if (k) moves.get(k).done = true; }
  }
  let back = 0; const conflicts = [];
  for (const k of [...order].reverse()) {
    const m = moves.get(k); const fromAbs = fromRel(root, m.from); const toAbs = fromRel(root, m.to);
    if (!m.done && !(exists(toAbs) && !exists(fromAbs))) continue; // the move never happened
    if (!exists(toAbs) && exists(fromAbs) && sigMatches(m.sig, fromAbs)) continue; // already put back by an earlier undo
    if (!exists(toAbs)) { conflicts.push(`${m.to}: no longer there (moved or deleted after the run)`); continue; }
    if (!sigMatches(m.sig, toAbs)) { conflicts.push(`${m.to}: a different file is there now (replaced or saved as a new file since the run); left where it is`); continue; }
    if (exists(fromAbs)) { conflicts.push(`${m.from}: something new is in that place now; ${m.to} left where it is`); continue; }
    try { fs.mkdirSync(path.dirname(fromAbs), { recursive: true }); if (exists(fromAbs)) throw new Error('the place was taken a moment ago'); fs.renameSync(toAbs, fromAbs); back++; } catch (err) { conflicts.push(`${m.to}: ${err.message}`); }
  }
  // Remove only the empty folders this run created, deepest first, then the empty quarantine tree.
  for (const d of dirs.reverse()) { try { fs.rmdirSync(fromRel(root, d)); } catch { /* not empty or gone: kept */ } }
  const qDir = path.join(runAbs, 'quarantine');
  const pruneEmpty = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) pruneEmpty(path.join(d, e.name)); try { fs.rmdirSync(d); } catch { /* not empty */ } };
  pruneEmpty(qDir);
  // A run counts as undone only when nothing is left behind; otherwise it can be undone again after the conflicts are solved.
  fs.writeFileSync(path.join(runAbs, conflicts.length ? 'UNDO-CONFLICTS.txt' : 'UNDONE'), `${new Date().toISOString()} back: ${back}, conflicts: ${conflicts.length}\n${conflicts.join('\n')}\n`, 'utf8');
  console.log(`Undo of run ${id}: ${back} item(s) put back, ${conflicts.length} conflict(s).`);
  for (const c of conflicts) console.log(' - ' + c);
  process.exit(conflicts.length ? 1 : 0);
}

function cmdRuns(args) {
  const target = args._[1]; if (!target) die('usage: runs <folder>');
  const root = path.resolve(target); const runs = listRuns(root);
  if (!runs.length) { console.log('No runs.'); return; }
  for (const r of runs) {
    const dir = path.join(root, RUN_DIR, r);
    const lines = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"status":"done"')).length;
    const q = path.join(dir, 'quarantine'); const qs = fs.existsSync(q) ? treeStats(q) : { files: 0, bytes: 0 };
    console.log(`${r}: ${lines} moved, quarantine ${qs.files} files (${fmtBytes(qs.bytes)})${fs.existsSync(path.join(dir, 'UNDONE')) ? ', UNDONE' : ''}`);
  }
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const cmds = { scan: cmdScan, plan: cmdPlan, check: cmdCheck, apply: cmdApply, undo: cmdUndo, runs: cmdRuns };
if (!cmds[cmd]) {
  console.log('usage: node tidy.mjs scan|plan|check|apply|undo|runs ... (see the header of this file)');
  process.exit(cmd ? 2 : 0);
}
await cmds[cmd](args);
