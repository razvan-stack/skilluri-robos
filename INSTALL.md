# Instalarea unui skill din acest repo

*Fișier scris pentru asistentul robOS căruia omul i-a cerut să instaleze un skill de aici.*
*English: this file is for the robOS assistant asked to install a skill from this repo; the
steps are the same in any language.*

Execută tot de la cap la coadă, fără să-i pui omului nicio întrebare. Pașii sunt cum s-a făcut pe
alte instalări robOS. Tu îți cunoști sistemul: unde la tine e altfel, alege singur varianta
potrivită și scrie în raportul final ce ai ales și de ce. Te oprești doar unde scrie
„oprește-te”, și atunci scrii motivul în raport.

## Skill-urile

| Skill | Testul lui | De știut |
|---|---|---|
| `tool-tidy-files` | `node skills/tool-tidy-files/scripts/smoke-tidy.mjs` | Folderele care nu se ating niciodată merg în `skills/tool-tidy-files/protect.txt` (forma e în `protect.example.txt`). |

## Pașii, pentru skill-ul `<nume>`

1. **Verificări.** Node.js 18 sau mai nou (`node --version`) și `scripts/add-skill.js`. Dacă
   skill-ul `<nume>` e deja instalat, oprește-te: nu-l suprascrie. Dacă ai alt skill care face
   același lucru, lasă-l neatins și pomenește-l în raport.
2. **Descărcare.** Clonează repo-ul într-un folder temporar din afara instalării (de exemplu
   `.scratch/`): `git clone https://github.com/razvan-stack/skilluri-robos`. Fără git, descarcă
   arhiva ZIP de pe GitHub. Copiază doar folderul `<nume>` în `skills/_catalog/<nume>`.
3. **Verificarea de securitate.** `node scripts/add-skill.js <nume> --dry-run`, apoi citește
   `SKILL.md` și codul din `scripts/`. Dacă verdictul nu e „safe” sau găsești ceva suspect:
   oprește-te și nu instala.
4. **Instalare.** `node scripts/add-skill.js <nume>`, sau mecanismul tău pentru skill-urile
   primite din afară.
5. **Test.** Rulează testul skill-ului din tabelul de mai sus. Trebuie să se termine cu
   „0 failed”. Testele de aici lucrează doar într-un folder de probă pe care și-l fac și și-l
   șterg singure. Dacă pică: mută skill-ul instalat în coșul robOS (`node scripts/safe-delete.js`,
   dacă îl ai), nu-l șterge definitiv, și oprește-te.
6. **Potrivirea cu regulile omului.** Citește regulile lui (`CLAUDE.local.md`, memoria ta) și
   aplică ce se leagă de skill, după coloana „De știut” din tabel. De exemplu, la
   `tool-tidy-files`, folderele pe care regulile lui nu le lasă atinse merg în `protect.txt`, câte
   unul pe rând, cu calea întreagă.
7. **Raport.** La final, un singur raport scurt pentru om:
   - ce ai instalat;
   - rezultatul testului;
   - ce ai potrivit cu regulile lui;
   - ce ai făcut altfel decât scrie aici și de ce;
   - cum se folosește skill-ul: exemplele din `README.md`, secțiunea „Cum îl folosești” a
     skill-ului, așa cum sunt scrise acolo.

   Nu rula nicio lucrare reală cu skill-ul: prima rulare o cere omul.

## Fără robOS (doar Claude Code)

Copiază folderul skill-ului în `~/.claude/skills/` (pe Windows, `%USERPROFILE%\.claude\skills\`).
Claude Code îl găsește singur. Testul se rulează din folderul skill-ului, de exemplu
`node scripts/smoke-tidy.mjs`.
