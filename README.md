# Skill-uri robOS

*Făcute de Răzvan Bordeanu pentru comunitatea robOS.*

Skill-uri gata de pus într-un robOS (merg și în Claude Code fără robOS). Fiecare stă în folderul
lui, cu instrucțiunile (`SKILL.md`), codul și testul lui.

| Skill | Ce face |
|---|---|
| [`tool-tidy-files`](tool-tidy-files/) | Face ordine într-un folder dezordonat și găsește dublurile după conținut. Arată planul înainte, nu șterge nimic și poate anula tot. |

*English summary at the end.*

---

## tool-tidy-files: ordine în fișiere, fără să pierzi nimic

Îi spui robOS-ului „fă ordine în Downloads” sau „găsește fișierele duble din Documente”. Skill-ul
se uită prin folder, îți spune ce a găsit, îți propune un plan și mută fișierele numai după ce
l-ai aprobat.

**Ce face**
- Sortează fișierele după tip (Documente, PDF, Imagini, Capturi de ecran, Fotografii, Video, Arhive,
  Kituri de instalare…), după dată, după tip și an, după metoda PARA sau în **proiectele tale**:
  un fișier ajunge în folderul proiectului cu care are cuvinte în comun.
- Găsește dublurile după **conținutul întreg** al fișierului (amprentă SHA-256), nu după nume sau
  mărime. Chiar înainte să mute o dublură, compară cele două fișiere octet cu octet.
- Pune deoparte copiile identice într-o carantină din același folder (`_tidy/<rulare>/quarantine/`),
  cu o listă care spune ce copie a rămas în locul fiecăreia.
- Recunoaște capturile de ecran, pozele făcute cu telefonul (inclusiv după datele EXIF), fișierele
  din WhatsApp, copiile în conflict lăsate de OneDrive sau Dropbox și descărcările neterminate.
- Citește fișierele neclare și propune un nume pe măsură: de exemplu `2508.09736v1.pdf` devine
  titlul real al lucrării.
- La planurile mari face întâi o probă pe câteva fișiere, apoi continuă cu restul planului.
- Anulează o rulare întreagă cu o singură comandă.

**Ce nu face niciodată**
- Nu șterge niciun fișier al tău. Carantina o golești tu, după ce te-ai uitat prin ea.
- Nu suprascrie nimic, nici măcar o scurtătură stricată.
- Nu desparte un proiect de cod, un site, un program instalat, un pachet de drivere sau un studiu
  medical: le recunoaște și le lasă întregi.
- Nu atinge folderele de sistem, `AppData`, Coșul de reciclare, folderele ascunse, scurtăturile
  către alte foldere (și nici nu iese prin ele din folderul ales), fișierele pe care Windows și
  macOS le țin în fiecare folder (`desktop.ini`, `Thumbs.db`, `.DS_Store`) și nici instalarea
  robOS în care rulează.
- Nu reorganizează subfolderele pe care le ai deja. Implicit mută doar fișierele lăsate direct
  în folder.
- La anulare nu mută înapoi un fișier care nu e cel pe care l-a mutat el: îți spune și îl lasă
  pe loc.

**Folderele tale interzise.** Pune în `tool-tidy-files/protect.txt` câte un folder pe rând, cu
calea întreagă (vezi `protect.example.txt`). Skill-ul nu le atinge niciodată, la nicio rulare. Un
rând greșit (o cale care nu există sau nu e întreagă) oprește skill-ul cu un mesaj, ca să nu crezi
că un folder e protejat când nu e. Pentru un disc extern pe care nu-l ai mereu conectat, începe
rândul cu `?`: e protejat când e conectat și nu oprește nimic când lipsește. Fișierul e al tău, nu
e în repo. Dacă reinstalezi skill-ul, păstrează-ți o copie a lui.

**Foldere sincronizate cu cloud-ul** (OneDrive, Google Drive, Dropbox): fiecare mutare se
sincronizează pe toate dispozitivele. Când fișierele stau doar online, căutarea de dubluri le-ar
descărca, așa că robOS te întreabă înainte.

**Cerințe:** Node.js 18 sau mai nou, pe care robOS îl are deja. Merge pe Windows, macOS și Linux,
fără pachete de instalat.

### Instalare în robOS: lipește promptul acesta în robOS-ul tău

robOS-ul tău face totul singur, fără să te întrebe nimic, și îți dă la final un singur raport.

```text
Instalează skill-ul tool-tidy-files din https://github.com/razvan-stack/skilluri-robos
(făcut de Răzvan Bordeanu pentru comunitatea robOS, licență MIT). Skill-ul face ordine într-un
folder (Downloads, Desktop, Documente) și găsește dublurile după conținut. Arată planul înainte,
nu șterge nimic și poate anula orice rulare.

Execută tot de la cap la coadă, fără să-mi pui nicio întrebare. Pașii de mai jos sunt cum s-a
făcut pe alte instalări robOS. Tu îți cunoști sistemul: unde la tine e altfel, alege singur
varianta potrivită și scrie în raportul final ce ai ales și de ce.

1. Verifică Node.js 18 sau mai nou (node --version) și scripts/add-skill.js. Dacă există deja
   un skill tool-tidy-files, nu-l suprascrie: oprește-te și scrie asta în raport. Dacă ai alt
   skill care organizează fișiere, lasă-l neatins și pomenește-l în raport.
2. Descarcă repo-ul într-un folder temporar din afara instalării (de exemplu .scratch/), cu git
   sau ca arhivă ZIP. Copiază doar folderul tool-tidy-files în skills/_catalog/tool-tidy-files.
3. Rulează node scripts/add-skill.js tool-tidy-files --dry-run și citește SKILL.md și
   scripts/tidy.mjs. Dacă verdictul nu e „safe” sau găsești ceva suspect, nu instala și explică
   în raport de ce.
4. Instalează: node scripts/add-skill.js tool-tidy-files (sau mecanismul tău pentru skill-urile
   primite din afară).
5. Testează: node skills/tool-tidy-files/scripts/smoke-tidy.mjs. Lucrează doar într-un folder de
   probă pe care și-l face și și-l șterge singur și trebuie să se termine cu „0 failed”. Dacă
   pică, mută skill-ul instalat în coșul robOS (node scripts/safe-delete.js, dacă îl ai), nu-l
   șterge definitiv, și scrie în raport ce a picat.
6. Dacă în regulile mele (CLAUDE.local.md, memoria ta) scrie că anumite foldere nu se ating
   niciodată, pune-le câte unul pe rând, cu calea întreagă, în skills/tool-tidy-files/protect.txt
   (forma e în protect.example.txt).
7. La final, un singur raport scurt: ce ai instalat, rezultatul testului, ce ai pus în
   protect.txt, ce ai făcut altfel decât scrie aici și de ce, și cum îl folosesc (de exemplu
   „fă ordine în Downloads”). Nu rula nicio organizare reală.
```

Sau, de mână, din folderul robOS:

```bash
git clone https://github.com/razvan-stack/skilluri-robos ../skilluri-robos
cp -r ../skilluri-robos/tool-tidy-files skills/_catalog/tool-tidy-files
node scripts/add-skill.js tool-tidy-files --dry-run   # verificarea de securitate, fără să instaleze
node scripts/add-skill.js tool-tidy-files
node skills/tool-tidy-files/scripts/smoke-tidy.mjs   # trebuie să se termine cu „0 failed”
```

În PowerShell, pe Windows, copierea se face cu
`Copy-Item -Recurse ..\skilluri-robos\tool-tidy-files skills\_catalog\tool-tidy-files`.

### Fără robOS (doar Claude Code)

Copiază folderul `tool-tidy-files` în `~/.claude/skills/` (pe Windows,
`%USERPROFILE%\.claude\skills\`). Claude Code îl găsește singur. Fișierele de lucru ajung atunci
în folderul temporar al sistemului.

### Cum îl folosești

- „Fă ordine în Downloads.”
- „Găsește fișierele duble din Documente și spune-mi cât spațiu ocupă.”
- „Mută fișierele din Desktop în proiectele mele din D:\Proiecte.”
- „Organizează folderul ăsta după an.”
- „Anulează ultima organizare.”

Pentru fiecare cerere primești întâi un rezumat al folderului, apoi planul, cu fiecare destinație
și fiecare dublură. Abia după ce îl aprobi se mută ceva.

### Cum a fost testat

- **Testul care vine cu skill-ul** (`scripts/smoke-tidy.mjs`): 61 de verificări pe Linux și 62 pe
  Windows. Construiește un folder dezordonat de probă, cu toate capcanele de mai jos, rulează tot
  ciclul și verifică la final că anularea a pus fiecare fișier la loc, octet cu octet.
- **Atacuri dinadins**: 21 de scenarii pe Windows și 26 pe Linux (cinci țin doar de Windows,
  zece doar de Linux, printre ele un stick FAT32 și unul exFAT montate de-adevăratelea),
  fiecare verificat după aceeași regulă:
  niciun fișier pierdut, niciunul suprascris, nimic mutat în afara folderului. Printre ele:
  - un plan editat ca să iasă din folder prin scurtături și joncțiuni;
  - un plan care pune drept „copia păstrată” chiar fișierul mutat, sub alt nume (`RAPORT~1.PDF`,
    alte majuscule);
  - două rulări pornite în aceeași secundă;
  - o rulare întreruptă la mijloc;
  - un fișier deschis în alt program;
  - căi mai lungi de 260 de caractere;
  - nume cu diacritice și emoji;
  - 20.000 de fișiere.
- **Recenzie separată a codului**, în trei runde, făcută de un al doilea agent care avea o singură
  sarcină: să găsească feluri în care s-ar putea pierde date. Ce a găsit e reparat și a intrat în
  test.

Ce nu e testat încă: macOS (codul tratează numele scrise în forma folosită de macOS, dar nu a rulat
pe un Mac), un stick FAT sau exFAT pe Windows și folderele sincronizate cu fișiere doar online.

### De unde vin ideile

Skill-ul e scris de la zero, dar ideile vin din proiectele bune pe care le-am găsit:
[file-organizer de la ComposioHQ](https://github.com/ComposioHQ/awesome-claude-skills/tree/master/file-organizer)
(ideea de bază), [File-Organizer-MCP](https://github.com/kridaydave/File-Organizer-MCP) (planul,
jurnalul, anularea, raportarea fișierelor necomparate),
[declutter](https://github.com/vamgan/declutter) (fără ștergeri, copiile în conflict),
[agent-file-organizer](https://github.com/NerdBlaq/agent-file-organizer) (capturi de ecran și poze
de pe telefon), [tidy-undo](https://github.com/epoko77-ai/tidy-undo) (sortarea pe proiectele tale,
redenumirea după conținut) și metoda PARA a lui Tiago Forte.

Ce adaugă față de ele: dublurile verificate pe tot conținutul, plus o comparare octet cu octet
chiar înainte de mutare; pachetele recunoscute și după numele folderului și după fișierele de
program din el, nu doar după fișierele de proiect; protejarea instalării robOS; anularea care
mută înapoi doar fișierele pe care le-a mutat chiar ea.

---

## English summary

*Made by Răzvan Bordeanu for the robOS community.*

`tool-tidy-files` organizes a messy folder (by type, date, PARA or your own project folders) and
finds duplicates by whole-file content (SHA-256, then a byte-by-byte compare right before each
move). It shows a plan first and moves only after approval. It never deletes your files:
identical copies go to a quarantine folder on the same disk. It never overwrites, never splits
project, site or program folders, never follows links out of the folder, never touches system
folders, `desktop.ini`-type files or the robOS installation, and undoes a whole run with one
command. Your permanent off-limits folders go in `tool-tidy-files/protect.txt`. Node.js 18+, no
dependencies, Windows, macOS and Linux. Tested: 61 checks on Linux, 62 on Windows, 21
adversarial scenarios on Windows and 26 on Linux (including real FAT32 and exFAT disks), and a
three-round separate code review aimed at data loss; not yet run on macOS.

Install in robOS: copy `tool-tidy-files` to `skills/_catalog/`, then
`node scripts/add-skill.js tool-tidy-files`. Without robOS: copy it to `~/.claude/skills/`.
Test: `node scripts/smoke-tidy.mjs` (inside the skill folder) must end with `0 failed`.

## Licență / License

MIT. Vezi [LICENSE](LICENSE).
