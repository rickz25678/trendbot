// Merges the meme coin research (research_notes/Old meme coin winners/*.json) into library.json + lessons.json.
// Run again whenever new research files are added:  node tools/build_library.mjs
import fs from 'node:fs';
import path from 'node:path';

const RESEARCH = 'C:/Users/johni/research_notes/Old meme coin winners';
const ROOT = new URL('../', import.meta.url);
const cut = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = v => typeof v === 'number' ? v : (+String(v ?? '').replace(/[^0-9.e]/g, '') || 0);

const lib = JSON.parse(fs.readFileSync(new URL('library.json', ROOT), 'utf8'));
const byTicker = new Map(lib.map(x => [x.ticker.toUpperCase(), x]));

let added = 0, updated = 0;
for (const f of fs.readdirSync(RESEARCH).filter(f => f.endsWith('.json') && f !== 'flops_and_copies.json')) {
  for (const c of JSON.parse(fs.readFileSync(path.join(RESEARCH, f), 'utf8'))) {
    if (!c?.ticker) continue;
    const entry = {
      ticker: String(c.ticker).replace(/^\$/, ''),
      chain: c.chain || '?',
      peak: num(c.peak_mcap_usd),
      type: cut(c.meme_type, 40),
      meme: cut(c.what_the_meme_is, 120),
      origin: cut(c.story_origin, 110),
      art: cut(c.art_style, 40),
      why: cut(c.why_it_worked, 160),
      flags: cut(c.red_flags, 80),
      src: 'research ' + f.replace('.json', ''),
    };
    const old = byTicker.get(entry.ticker.toUpperCase());
    if (old) { Object.assign(old, Object.fromEntries(Object.entries(entry).filter(([, v]) => v))); updated++; }
    else { lib.push(entry); byTicker.set(entry.ticker.toUpperCase(), entry); added++; }
  }
}
fs.writeFileSync(new URL('library.json', ROOT), JSON.stringify(lib, null, 1));

// lessons from flops and copycat fights
const flopsFile = path.join(RESEARCH, 'flops_and_copies.json');
if (fs.existsSync(flopsFile)) {
  const all = JSON.parse(fs.readFileSync(flopsFile, 'utf8'));
  const rules = all.find(x => x.rules)?.rules || [];
  const cases = all.filter(x => x.case_name).map(x => ({
    name: cut(x.case_name, 50), kind: x.kind, meme: cut(x.the_meme, 100), lesson: cut(x.lesson, 150),
  }));
  fs.writeFileSync(new URL('lessons.json', ROOT), JSON.stringify({ rules, cases }, null, 1));
  console.log(`lessons: ${rules.length} rules, ${cases.length} cases`);
}
console.log(`library: ${lib.length} coins (${added} added, ${updated} updated)`);
