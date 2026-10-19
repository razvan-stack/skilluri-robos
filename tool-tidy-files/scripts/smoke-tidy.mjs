#!/usr/bin/env node
// smoke-tidy.mjs - end-to-end test of tidy.mjs on a throwaway folder (os temp dir).
// Made by Răzvan Bordeanu for the robOS community. MIT license.
// Builds a messy folder with the hard cases, then checks: duplicates only by whole content
// (two files that share size, first and last MB but differ in the middle are NOT duplicates),
// packages never split, protected paths never touched, invalid plans refused, the byte
// comparison right before quarantine, and an undo that restores every byte.
//   node smoke-tidy.mjs        exit 0 = all checks passed
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TIDY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tidy.mjs');
let failed = 0; let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log('FAIL: ' + msg); } };
const run = (...a) => spawnSync(process.execPath, [TIDY, ...a], { encoding: 'utf8' });
const put = (root, rel, data) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function jpegWithMake() {
  const tiff = Buffer.concat([Buffer.from('II'), Buffer.from([0x2a, 0, 8, 0, 0, 0, 1, 0, 0x0f, 0x01, 2, 0, 6, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('Canon\0')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([0, 2 + 6 + tiff.length]), Buffer.from('Exif\0\0'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

function build(root) {
  const A = crypto.randomBytes(5000);
  put(root, 'report.pdf', A);
  put(root, 'report (1).pdf', A);
  put(root, 'notes-final.docx', A); // same bytes, different name
  const MB = 1 << 20; const head = crypto.randomBytes(MB); const tail = crypto.randomBytes(MB);
  put(root, 'big1.bin', Buffer.concat([head, Buffer.alloc(MB, 1), tail]));
  put(root, 'big2.bin', Buffer.concat([head, Buffer.alloc(MB, 2), tail])); // differs only in the middle
  put(root, 'Screenshot 2026-10-01 at 10.00.00.png', crypto.randomBytes(300));
  put(root, 'IMG_1234.jpg', crypto.randomBytes(400));
  put(root, 'holiday.jpg', jpegWithMake());
  put(root, 'setup.exe', crypto.randomBytes(700));
  put(root, 'movie.mp4', crypto.randomBytes(800));
  put(root, 'film.mkv.crdownload', crypto.randomBytes(100));
  put(root, '~$letter.docx', crypto.randomBytes(50));
  put(root, 'contract acme 2026.pdf', crypto.randomBytes(900));
  put(root, 'buget beta q3.xlsx', crypto.randomBytes(901));
  put(root, 'random.txt', 'nothing to match');
  put(root, 'proj-site/package.json', '{}');
  put(root, 'proj-site/index.js', 'x');
  put(root, 'proj-site/report.pdf', A); // a duplicate inside a package: never touched
  put(root, 'drivers_Win7_x64/a.txt', 'driver readme');
  for (let i = 0; i < 5; i++) put(root, `libs/l${i}.dll`, crypto.randomBytes(64));
  put(root, 'Private/secret.txt', 'keep out');
  put(root, 'Proiecte/Acme/oferta acme.pdf', crypto.randomBytes(200));
  put(root, 'Proiecte/Beta/beta buget.xlsx', crypto.randomBytes(201));
  put(root, 'Copie/one.txt', 'same folder'); put(root, 'Copie 2/one.txt', 'same folder'); // identical folders
}

function snapshot(root) {
  const out = {}; const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (r === '_tidy') continue;
      if (e.isDirectory()) stack.push(r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, r))).digest('hex');
    }
  }
  return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
}

// On Windows the temp folder is under AppData, which the engine protects: test in the home folder.
const tmpProtected = process.platform === 'win32' && /[\\/]appdata[\\/]/i.test(os.tmpdir());
const base = fs.mkdtempSync(path.join(tmpProtected ? os.homedir() : os.tmpdir(), '.tidy-smoke-'));
try {
  if (tmpProtected) {
    const pa = run('scan', os.tmpdir(), '--out', path.join(base, 'out0'));
    ok(pa.status === 2, 'a folder under AppData is refused on Windows');
  }
  // ---------- scenario 1: scan, plan by type, invalid plans, apply, undo
  const r1 = path.join(base, 's1'); fs.mkdirSync(r1); build(r1);
  const before = snapshot(r1);
  const out1 = path.join(base, 'out1');
  let p = run('scan', r1, '--out', out1, '--protect', path.join(r1, 'Private'));
  ok(p.status === 0, 'scan exits 0: ' + p.stderr);
  const scan = read(path.join(out1, 'scan.json'));
  const groupA = scan.dupes.find((g) => g.files.includes('report.pdf'));
  ok(groupA && groupA.files.length === 3 && groupA.namesDiffer, 'the three identical files form one group with names that differ');
  ok(!scan.dupes.some((g) => g.files.includes('big1.bin')), 'files equal in size, head and tail but not in the middle are not duplicates');
  ok(!scan.dupes.some((g) => g.files.some((f) => f.startsWith('proj-site/'))), 'files inside a package are not duplicate candidates');
  const pk = scan.packages.map((x) => x.p).sort();
  ok(JSON.stringify(pk) === JSON.stringify(['drivers_Win7_x64', 'libs', 'proj-site']), 'three packages detected: ' + pk.join(','));
  ok(scan.skipped.some((s) => s.p === 'Private' && s.reason === 'protected'), 'the --protect folder is skipped');
  const fl = (n) => scan.files.find((f) => f.p === n)?.flags || [];
  ok(fl('Screenshot 2026-10-01 at 10.00.00.png').includes('screenshot'), 'screenshot recognized');
  ok(fl('IMG_1234.jpg').includes('camera') && fl('holiday.jpg').includes('camera'), 'camera photo recognized by name and by EXIF');
  ok(scan.folderDupes.some((g) => g.folders.includes('Copie') && g.folders.includes('Copie 2')), 'identical folders found');

  p = run('plan', path.join(out1, 'scan.json'), '--mode', 'type', '--lang', 'ro');
  ok(p.status === 0, 'plan exits 0: ' + p.stderr);
  const planFile = path.join(out1, 'plan.json'); const plan = read(planFile);
  const q = plan.entries.filter((e) => e.kind === 'quarantine');
  ok(q.length === 2 && q.every((e) => e.keep === 'report.pdf'), 'two copies to quarantine, report.pdf kept');
  ok(!plan.entries.some((e) => e.from.startsWith('proj-site/') || e.from.startsWith('libs/') || e.from.startsWith('Private/')), 'no entry touches a package or a protected folder');
  ok(plan.review.partial.includes('film.mkv.crdownload') && plan.review.lockfiles.includes('~$letter.docx'), 'unfinished download and lock file left for a decision');
  ok(plan.entries.some((e) => e.to === 'Imagini/Capturi de ecran/Screenshot 2026-10-01 at 10.00.00.png'), 'screenshot goes to Imagini/Capturi de ecran');

  p = run('check', planFile); ok(p.status === 0, 'valid plan passes check: ' + p.stdout.slice(0, 300));

  const bad = (mutate, label) => {
    const b = read(planFile); mutate(b); const f = path.join(out1, 'bad.json'); fs.writeFileSync(f, JSON.stringify(b));
    const c = run('check', f); ok(c.status === 2, `check refuses: ${label}`);
  };
  bad((b) => { b.entries.find((e) => e.kind === 'move').to = '../escape.txt'; }, 'a destination outside the folder');
  bad((b) => { b.entries.push({ id: 99, kind: 'move', unit: 'file', from: 'proj-site/index.js', to: 'Cod/index.js' }); }, 'a file taken out of a package');
  bad((b) => { b.entries.find((e) => e.kind === 'move').to = 'big2.bin'; }, 'a destination that exists');
  bad((b) => { const m = b.entries.filter((e) => e.kind === 'move'); m[1].to = m[0].to; }, 'two entries with the same destination');
  bad((b) => { b.entries.push({ id: 98, kind: 'quarantine', unit: 'file', from: 'report.pdf', keep: 'notes-final.docx' }); }, 'every copy of a file sent to quarantine');
  bad((b) => { b.entries.push({ id: 97, kind: 'move', unit: 'file', from: 'Private/secret.txt', to: 'secret.txt' }); }, 'a protected file');
  if (process.platform === 'win32') bad((b) => { b.entries.find((e) => e.kind === 'move').to = 'Altele/con.txt'; }, 'a name Windows cannot hold');

  p = run('apply', planFile); ok(p.status === 2, 'apply without --yes is refused');
  ok(snapshot(r1) === before, 'nothing moved before --yes');

  p = run('apply', planFile, '--yes');
  ok(p.status === 0, 'apply exits 0: ' + p.stdout.slice(-400));
  ok(fs.existsSync(path.join(r1, 'PDF', 'report.pdf')) && !fs.existsSync(path.join(r1, 'report (1).pdf')), 'the kept copy is filed under PDF/, the other copy leaves');
  const runs = fs.readdirSync(path.join(r1, '_tidy'));
  ok(fs.existsSync(path.join(r1, '_tidy', runs[0], 'quarantine', 'report (1).pdf')), 'the copy is in quarantine, not deleted');
  ok(fs.readFileSync(path.join(r1, 'Private/secret.txt'), 'utf8') === 'keep out' && fs.existsSync(path.join(r1, 'proj-site/report.pdf')), 'protected folder and package untouched');
  ok(fs.existsSync(path.join(r1, 'PDF', 'contract acme 2026.pdf')), 'a pdf moved to PDF/');

  p = run('undo', r1); ok(p.status === 0, 'undo exits 0: ' + p.stdout);
  ok(snapshot(r1) === before, 'after undo every file is back, byte for byte');
  ok(!fs.existsSync(path.join(r1, 'PDF')), 'folders created by the run are removed when empty');
  p = run('undo', r1); ok(p.status === 2, 'a second undo is refused');

  // ---------- scenario 2: a file changes after the plan; the kept copy changes in place
  const r2 = path.join(base, 's2'); fs.mkdirSync(r2); build(r2);
  const out2 = path.join(base, 'out2');
  run('scan', r2, '--out', out2); run('plan', path.join(out2, 'scan.json'), '--mode', 'type');
  fs.appendFileSync(path.join(r2, 'random.txt'), ' changed');
  p = run('apply', path.join(out2, 'plan.json'), '--yes');
  ok(p.status === 2 && !fs.existsSync(path.join(r2, '_tidy')), 'a file changed after the scan stops the whole apply');
  fs.writeFileSync(path.join(r2, 'random.txt'), 'nothing to match');
  run('scan', r2, '--out', out2); run('plan', path.join(out2, 'scan.json'), '--mode', 'type');
  const kept = path.join(r2, 'report.pdf'); const buf = fs.readFileSync(kept); buf[10] ^= 0xff; fs.writeFileSync(kept, buf);
  const mid = snapshot(r2);
  p = run('apply', path.join(out2, 'plan.json'), '--yes');
  ok(p.status === 1 && fs.existsSync(path.join(r2, 'report (1).pdf')), 'byte check right before quarantine leaves a no-longer-identical copy in place');
  run('undo', r2); ok(snapshot(r2) === mid, 'undo after a partial run restores the folder');

  // ---------- scenario 3: projects mode
  const r3 = path.join(base, 's3'); fs.mkdirSync(r3); build(r3);
  const out3 = path.join(base, 'out3');
  run('scan', r3, '--out', out3);
  p = run('plan', path.join(out3, 'scan.json'), '--mode', 'projects', '--projects', 'Proiecte');
  const pl3 = read(path.join(out3, 'plan.json'));
  ok(pl3.entries.some((e) => e.from === 'contract acme 2026.pdf' && e.to === 'Proiecte/Acme/contract acme 2026.pdf'), 'a file goes to the project whose name it shares');
  ok(pl3.entries.some((e) => e.from === 'buget beta q3.xlsx' && e.to === 'Proiecte/Beta/buget beta q3.xlsx'), 'second project matched');
  ok(pl3.review.unassigned.includes('random.txt'), 'a file with no match is left for a decision');

  // ---------- scenario 4: the chosen folder is itself a package
  p = run('scan', path.join(r3, 'proj-site'), '--out', path.join(base, 'out4'));
  ok(p.status === 4, 'scanning a project folder stops with exit 4');

  // ---------- scenario 5: installed inside a robOS, the robOS folder is protected
  const r5 = path.join(base, 's5'); const fake = path.join(r5, 'robOS');
  put(fake, 'CLAUDE.md', '# robOS'); put(fake, 'scripts/x.js', ''); put(fake, 'context/notes.md', 'mine');
  const inst = put(fake, 'skills/tool-tidy-files/scripts/tidy.mjs', fs.readFileSync(TIDY));
  put(r5, 'loose.txt', 'loose');
  const runInst = (...a) => spawnSync(process.execPath, [inst, ...a], { encoding: 'utf8' });
  p = runInst('scan', path.join(fake, 'context'), '--out', path.join(base, 'out5a'));
  ok(p.status === 2, 'a folder inside the robOS installation is refused');
  p = runInst('scan', r5, '--out', path.join(base, 'out5b'));
  const s5 = read(path.join(base, 'out5b', 'scan.json'));
  ok(p.status === 0 && s5.skipped.some((s) => s.p === 'robOS' && s.reason === 'protected') && !s5.files.some((f) => f.p.startsWith('robOS/')), 'the robOS installation inside a scanned folder is skipped');
  ok(s5.robosRoot && path.resolve(s5.robosRoot) === path.resolve(fake), 'scan records which robOS it protects');

  // ---------- scenario 6: cases from the adversarial review (2026-10-19)
  const r6 = path.join(base, 's6'); const B = crypto.randomBytes(3000);
  put(r6, 'Scans/a.pdf', B); put(r6, 'Scans/a (1).pdf', B); put(r6, 'other.txt', 'o');
  const o6 = path.join(base, 'out6');
  run('scan', path.join(r6, 'Scans'), '--out', o6); run('plan', path.join(o6, 'scan.json'), '--mode', 'type'); run('apply', path.join(o6, 'plan.json'), '--yes');
  fs.renameSync(path.join(r6, 'Scans', 'PDF', 'a.pdf'), path.join(r6, 'a.pdf')); // the operator moves the kept copy up
  const o6b = path.join(base, 'out6b'); run('scan', r6, '--out', o6b);
  const s6 = read(path.join(o6b, 'scan.json'));
  ok(!s6.files.some((f) => f.p.includes('_tidy/')) && !s6.dupes.some((g) => g.files.some((f) => f.includes('_tidy'))), 'an earlier run folder deeper down is not scanned, so its quarantine never counts as the kept copy');

  put(r6, 'Work/notes.txt', 'n'); put(r6, 'Work/Clients/c.txt', 'c'); put(r6, 'site/index.html', '<p>'); put(r6, 'site/style.css', 'p{}');
  const o6c = path.join(base, 'out6c'); run('scan', r6, '--out', o6c, '--protect', 'Work/Clients');
  const s6c = read(path.join(o6c, 'scan.json'));
  ok(s6c.protect.some((p) => p.endsWith(path.join('Work', 'Clients'))), 'a relative --protect is resolved inside the scanned folder');
  p = run('scan', r6, '--out', o6c, '--protect', 'Nu-Exista'); ok(p.status === 2, 'a --protect path that does not exist stops the scan');
  run('scan', r6, '--out', o6c, '--protect', 'Work/Clients'); run('plan', path.join(o6c, 'scan.json'), '--mode', 'type');
  const plan6 = path.join(o6c, 'plan.json'); const base6 = read(plan6);
  const variant = (mut) => { const b = JSON.parse(JSON.stringify(base6)); mut(b); const f = path.join(o6c, 'v.json'); fs.writeFileSync(f, JSON.stringify(b)); return run('check', f).status; };
  ok(variant((b) => b.entries.push({ id: 501, kind: 'move', unit: 'folder', from: 'Work', to: '1-Proiecte/Work' })) === 2, 'a whole folder that holds a protected folder cannot move');
  ok(variant((b) => { b.packages = []; delete b.scanFile; b.entries.push({ id: 502, kind: 'move', unit: 'file', from: 'site/style.css', to: 'Cod/style.css' }); }) === 2, 'a plan that lost its package list still cannot split a package');
  ok(variant((b) => { b.protect = []; b.entries.push({ id: 503, kind: 'move', unit: 'file', from: 'Work/Clients/c.txt', to: 'c.txt' }); }) === 2, 'a plan cannot drop the scan\'s protected folders');
  let linked = true; try { fs.symlinkSync(r6, path.join(r6, 'mirror'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
  if (linked) {
    ok(variant((b) => b.entries.push({ id: 504, kind: 'quarantine', unit: 'file', from: 'a.pdf', keep: 'mirror/a.pdf', size: fs.statSync(path.join(r6, 'a.pdf')).size, mtime: Math.round(fs.statSync(path.join(r6, 'a.pdf')).mtimeMs) })) === 2, 'the kept copy cannot be the same file under another name');
    fs.unlinkSync(path.join(r6, 'mirror')); // test link created above
  }
  put(r6, 'desktop.ini', '[.ShellClassInfo]');
  const o6d = path.join(base, 'out6d'); run('scan', r6, '--out', o6d); run('plan', path.join(o6d, 'scan.json'), '--mode', 'type');
  ok(!read(path.join(o6d, 'plan.json')).entries.some((e) => e.from === 'desktop.ini'), 'desktop.ini stays where Windows expects it');
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.join(r6, 'Documents'), { recursive: true }); fs.symlinkSync(path.join(r6, 'nowhere'), path.join(r6, 'Documents', 'other.txt'));
    run('scan', r6, '--out', o6d); run('plan', path.join(o6d, 'scan.json'), '--mode', 'type');
    const pl6 = read(path.join(o6d, 'plan.json'));
    ok(pl6.entries.some((e) => e.from === 'other.txt' && e.to === 'Documents/other (2).txt'), 'a broken link at the destination counts as taken, never replaced');
    fs.unlinkSync(path.join(r6, 'Documents', 'other.txt')); // test link created above
  }
  const site = path.join(base, 's6site'); put(site, 'index.html', '<p>'); put(site, 'style.css', 'p{}'); put(site, 'app.js', '');
  p = run('scan', site, '--out', path.join(base, 'out6e')); ok(p.status === 4, 'a website chosen as the folder stops the scan (exit 4)');

  // ---------- scenario 7: second review (2026-10-19)
  // protect.txt, tested on a copy of the skill so the real installation is never touched
  const r8 = path.join(base, 's8'); const skillCopy = path.join(base, 'skillcopy');
  const instB = put(skillCopy, 'scripts/tidy.mjs', fs.readFileSync(TIDY));
  put(r8, 'C#Proiecte/x.txt', 'x'); put(r8, 'loose.pdf', 'l');
  const runB = (...a) => spawnSync(process.execPath, [instB, ...a], { encoding: 'utf8' });
  fs.writeFileSync(path.join(skillCopy, 'protect.txt'), `# my folders\n${path.join(r8, 'C#Proiecte')}\n`);
  p = runB('scan', r8, '--out', path.join(base, 'out8'));
  const s8 = p.status === 0 ? read(path.join(base, 'out8', 'scan.json')) : { files: [] };
  ok(p.status === 0 && !s8.files.some((f) => f.p.startsWith('C#Proiecte/')), 'protect.txt: a folder with "#" in its name is protected');
  fs.writeFileSync(path.join(skillCopy, 'protect.txt'), 'Clienti\n');
  ok(runB('scan', r8, '--out', path.join(base, 'out8')).status === 2, 'protect.txt: a relative line stops the scan instead of protecting nothing');
  fs.writeFileSync(path.join(skillCopy, 'protect.txt'), path.join(r8, 'Nu-Exista') + '\n');
  ok(runB('scan', r8, '--out', path.join(base, 'out8')).status === 2, 'protect.txt: a line that does not exist stops the scan');
  fs.writeFileSync(path.join(skillCopy, 'protect.txt'), '?' + path.join(r8, 'Stick-Lipsa') + '\n');
  ok(runB('scan', r8, '--out', path.join(base, 'out8')).status === 0, 'protect.txt: a "?" line for a drive that is not plugged in does not stop the scan');
  // a Vite or React build chosen as the folder
  const vite = path.join(base, 's8vite'); put(vite, 'index.html', '<div id=app>'); put(vite, 'vite.svg', '<svg/>'); put(vite, 'assets/index.js', '');
  ok(run('scan', vite, '--out', path.join(base, 'out8v')).status === 4, 'a site build (index.html with assets/) stops the scan');
  // a file without extension named like a destination folder
  const r9 = path.join(base, 's9'); put(r9, 'PDF', 'a file, not a folder'); put(r9, 'doc.pdf', 'd');
  run('scan', r9, '--out', path.join(base, 'out9')); p = run('plan', path.join(base, 'out9', 'scan.json'), '--mode', 'type');
  ok(p.status === 0, 'plan does not crash when a file sits where a destination folder would go');
  ok(run('check', path.join(base, 'out9', 'plan.json')).status === 0 && read(path.join(base, 'out9', 'plan.json')).review.unassigned.includes('doc.pdf'), 'a file whose folder name is taken by a file is left for a decision, the plan stays valid');
  // hard links are one file, not duplicates
  const r10 = path.join(base, 's10'); put(r10, 'one.pdf', crypto.randomBytes(2000)); let hl = true;
  try { fs.linkSync(path.join(r10, 'one.pdf'), path.join(r10, 'two.pdf')); } catch { hl = false; }
  if (hl) { run('scan', r10, '--out', path.join(base, 'out10')); ok(read(path.join(base, 'out10', 'scan.json')).dupes.length === 0, 'two hard links to one file are not duplicates'); }

  // undo never moves back a file that is not the one it moved
  const r7 = path.join(base, 's7'); put(r7, 'x.pdf', 'original'); const o7 = path.join(base, 'out7');
  run('scan', r7, '--out', o7); run('plan', path.join(o7, 'scan.json'), '--mode', 'type'); run('apply', path.join(o7, 'plan.json'), '--yes');
  fs.renameSync(path.join(r7, 'PDF', 'x.pdf'), path.join(r7, 'kept-aside.pdf')); put(r7, 'PDF/x.pdf', 'an impostor, much longer');
  p = run('undo', r7);
  ok(p.status === 1 && !fs.existsSync(path.join(r7, 'x.pdf')) && fs.existsSync(path.join(r7, '_tidy', fs.readdirSync(path.join(r7, '_tidy'))[0], 'UNDO-CONFLICTS.txt')), 'undo leaves a different file in place, reports it and keeps the run undoable');
} finally {
  fs.rmSync(base, { recursive: true, force: true }); // throwaway test folder created above
}
console.log(`smoke-tidy: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
