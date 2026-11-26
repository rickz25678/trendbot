// Tests every information source the bot uses: does it answer, how many items, how fresh,
// and do the coin numbers agree with a second site. Run:  node tools/check_sources.mjs
import * as B from '../bot.mjs';

const now = Date.now();
const ago = ms => !ms ? 'no time' : ms < 3600000 ? `${Math.round(ms / 60000)}m` : ms < 86400000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`;
const rows = [];
async function check(name, fn) {
  const t0 = Date.now();
  let list = [], err = '';
  try { list = (await fn()) || []; } catch (e) { err = e.message; }
  const times = list.map(x => x.started || x.created).filter(Boolean);
  const newest = times.length ? now - Math.max(...times) : 0;
  const sample = list.slice(0, 2).map(x => String(x.title || x.name || '').slice(0, 50)).join(' | ');
  rows.push({ name, n: list.length, newest: ago(newest), ms: Date.now() - t0, ok: list.length > 0 && !err, sample: err || sample });
  return list;
}

// --- viral sources ---
await check('X trends US', () => B.xTrends('united-states', 'US'));
await check('X trends UK', () => B.xTrends('united-kingdom', 'UK'));
await check('Google Trends US', () => B.googleTrends('US'));
await check('Google Trends GB', () => B.googleTrends('GB'));
for (const q of B.NEWS_QUERIES.slice(0, 3)) await check(`Bing News "${q}"`, () => B.bingNews(q));
for (const q of ["viral animal","goes viral"]) await check(`Google News "${q}" (2h)`, () => B.googleNews(q));
await check('Tree of Alpha', () => B.treeOfAlpha());
await check('Listings Upbit/Bybit/OKX', () => B.listings());
await check('DexScreener metas', () => B.dexMetas());
await check('GoPlus (Base BRETT)', async () => { const r = await B.goplus("base", "0x532f27101965dd16442e59d40670faf5ebb142e4"); return r ? [{ name: r }] : []; });
await check('Know Your Meme', () => B.knowYourMeme());
await check('Bluesky trends', () => B.bluesky());
await check('Wikipedia top', () => B.wikipedia());
for (const c of B.TG_CHANNELS) await check(`Telegram @${c}`, () => B.tgChannel(c, { tgSeen: {} }));
await check('Crypto RSS (all)', () => B.cryptoRss());

// --- coin data, per chain, with a cross-check against DexScreener ---
const mismatches = [];
for (const net of Object.keys(B.CHAINS)) {
  const pools = await check(`GeckoTerminal ${B.CHAINS[net]}`, () => B.chainTrending(net));
  for (const p of pools.slice(0, 2)) {
    if (!p.token) continue;
    const j = await B.get(`https://api.dexscreener.com/tokens/v1/${net}/${p.token}`, true);
    const d = (Array.isArray(j) ? j : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    const dmc = d ? (d.marketCap || d.fdv || 0) : 0;
    const diff = dmc && p.mc ? Math.abs(dmc - p.mc) / Math.max(dmc, p.mc) : null;
    mismatches.push(`${B.CHAINS[net]} $${p.name}: Gecko mc ${Math.round(p.mc)} vs Dex mc ${Math.round(dmc)} ${diff === null ? '(no compare)' : diff > 0.25 ? `⚠️ ${Math.round(diff * 100)}% apart` : '✅ match'}; 24h change Gecko ${Math.round(p.ch24)}% vs Dex ${Math.round(d?.priceChange?.h24 ?? NaN)}%`);
  }
}
await check('DexScreener search', async () => (await B.dexSearch('pepe')).map(p => ({ name: p.baseToken.symbol, created: p.pairCreatedAt })));
await check('RugCheck (BONK)', async () => { const r = await B.rugcheck('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'); return r ? [{ name: r }] : []; });

console.log('\nSOURCE CHECK ' + new Date().toISOString());
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(28)} ${String(r.n).padStart(3)} items · newest ${r.newest.padEnd(7)} · ${String(r.ms).padStart(5)}ms · ${r.sample}`);
console.log('\nNUMBER CROSS-CHECK (GeckoTerminal vs DexScreener):');
for (const m of mismatches) console.log('  ' + m);
