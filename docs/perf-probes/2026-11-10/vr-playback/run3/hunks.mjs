// Parse a unified diff of one file into [{old, neu}] text blocks.
import fs from 'node:fs';
export function hunks(diffPath) {
  const out = []; let cur = null;
  for (const line of fs.readFileSync(diffPath, 'utf8').split('\n')) {
    if (line.startsWith('@@')) { if (cur) out.push(cur); cur = { old: [], neu: [] }; continue; }
    if (!cur || line.startsWith('\\')) continue;
    const c = line[0], t = line.slice(1);
    if (c === ' ') { cur.old.push(t); cur.neu.push(t); } else if (c === '-') cur.old.push(t); else if (c === '+') cur.neu.push(t);
  }
  if (cur) out.push(cur);
  return out.map(h => ({ old: h.old.join('\n'), neu: h.neu.join('\n') }));
}
// Swap each hunk into whichever inline script holds its old text exactly once.
export function applyToPlayerInline(json, hs) {
  const report = [];
  hs.forEach((h, i) => {
    let hit = -1, n = 0;
    json.scripts.forEach((s, j) => { if (typeof s === 'string') { const c = s.split(h.old).length - 1; if (c) { hit = j; n += c; } } });
    if (n === 1) json.scripts[hit] = json.scripts[hit].replace(h.old, () => h.neu);
    report.push({ i, n, script: hit });
  });
  return report;
}
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) {
  const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(applyToPlayerInline(j, hunks(process.argv[3]))));
}
