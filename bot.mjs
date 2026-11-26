// Coin Trend Radar
// One GitHub Actions job loops for ~4.5 minutes, checking every ~60 seconds; each job starts the next one.
// Every loop:
//  - handles Telegram buttons (🎨 make art, 👍, 👎)
//  - reads viral sources outside crypto + public Telegram channels
//  - Gemini compares every trend to a library of past winning meme coins and keeps only ones that match a winner pattern
//  - sends ideas with picture, closest past winner, REAL existing coins (mc, liq, volume, age, buys/sells, CA) or OPEN tickers
//  - 🔴 live movers: new coins on Solana / Robinhood Chain / Elysium that are taking off, with safety check
//  - 📰 crypto news that matters for meme coin launchers, as it comes out
//  - race watch, hourly chain/meta digest, weekly scorecard + weekly library refresh
// No npm packages (Node 20+).

import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const STATE_FILE = new URL('./state/seen.json', import.meta.url);
const LIB_FILE = new URL('./library.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
// DexScreener chain id -> short label, and the GeckoTerminal network id for the same chain
const CHAINS = { solana: 'SOL', robinhood: 'RH', elysium: 'ELY', base: 'BASE', bsc: 'BNB', ethereum: 'ETH', hyperevm: 'HL' };
const GECKO = { solana: 'solana', robinhood: 'robinhood', elysium: 'elysium', base: 'base', bsc: 'bsc', ethereum: 'eth', hyperevm: 'hyperevm' };
const CHAIN_NAME = { SOL: 'Solana', RH: 'Robinhood', ELY: 'Elysium', BASE: 'Base', BNB: 'BNB', ETH: 'Ethereum', HL: 'Hyperliquid' };
// minimum market cap / 1h volume for a "live mover" on each chain
const MOVER_MIN = { solana: [50000, 30000], ethereum: [100000, 50000], base: [50000, 25000], bsc: [50000, 25000], hyperevm: [30000, 10000], robinhood: [20000, 10000], elysium: [20000, 10000] };
// tokens that are not meme coins (stablecoins, wrapped/majors, big DeFi/infra) - kept out of chain lists
const NOT_MEME = /^(W|U|K|ST|C)?(USD[A-Z0-9]*|USDT|USDC|DAI|ETH|BTC|SOL|HYPE|BNB|WBNB|WETH|CBBTC|ONDO|LINK|UNI|AERO|VVV|VIRTUAL|JUP|RAY|PUMP|ENA|PIEVERSE|EURC|PYUSD|FDUSD|USD1|CRVUSD|CRV|KNTQ|MONTRA|PONS|NEST)$/i;
// every message starts with a clear label so you know what it is at a glance
const head = (label, sub = '') => `<b>${label}</b>${sub ? ' · ' + sub : ''}\n━━━━━━━━━━━━━━\n`;
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LOUD_SCORE = 9;
const LOOP_MS = +(process.env.LOOP_MS || 270000); // how long one job keeps looping
const TICK_MS = 60000;                              // one check per minute
// public Telegram channels to copy (read via t.me/s/<name>)
const DEFAULT_CHANNELS = [
  'WatcherGuru', 'TreeNewsFeed', 'BWEnews', 'wublockchainenglish',          // fast crypto news
  'binance_announcements', 'hyperliquid_announcements',                      // listings
  'LookOnChainChannel',                                                      // on-chain / whales
  'memecoins', 'pumpfun',                                                    // meme coin scene
].join(',');
const TG_CHANNELS = (process.env.TG_CHANNELS || DEFAULT_CHANNELS).split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FORCE = process.argv.includes('--force');
const ONCE = process.argv.includes('--once') || FORCE;

// ---------- helpers ----------
async function get(url, asJson = false, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status);
    return asJson ? await r.json() : await r.text();
  } catch (e) {
    console.error('skip', url.replace(/key=[^&]+/, 'key=***').slice(0, 120), e.message);
    return null;
  }
}
const decode = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };
const items = xml => (xml || '').split(/<item[\s>]/).slice(1);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = s => crypto.createHash('sha1').update(key(s)).digest('hex').slice(0, 10);
const money = n => !n ? '?' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
const ago = ms => ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}d`;
const chg = x => x.created && Date.now() - x.created < 86400000 ? `🆕 ${ago(Date.now() - x.created)} old` : pct(x.ch24);
const pct = n => n == null || isNaN(n) ? '?' : `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
const bingImg = u => u ? decode(u).replace(/^http:/, 'https:') + '&w=800' : '';
const stripHtml = s => decode(String(s || '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();

// ---------- viral sources (outside crypto) ----------
async function xTrends(region, label) {
  const html = await get(`https://trends24.in/${region}/`);
  if (html) {
    const firstCard = html.split(/<ol[^>]*trend-card__list/)[1] || html; // newest hour is the first list
    return [...firstCard.matchAll(/class=trend-link>([^<]+)/g)].slice(0, 30)
      .map((m, i) => ({ title: decode(m[1]), src: `X trending ${label}`, rank: i + 1 }));
  }
  const alt = await get(`https://getdaytrends.com/${region}/`);
  if (!alt) return [];
  return [...new Set([...alt.matchAll(/href="\/[a-z-]+\/trend\/([^"\/]+)\/"/g)].map(m => decodeURIComponent(m[1])))].slice(0, 30)
    .map((t, i) => ({ title: t, src: `X trending ${label}`, rank: i + 1 }));
}
async function googleTrends(geo) {
  const xml = await get(`https://trends.google.com/trending/rss?geo=${geo}`);
  return items(xml).map(it => ({
    title: tag(it, 'title'),
    detail: `${tag(it, 'ht:approx_traffic')} Google searches. ${tag(it, 'ht:news_item_title')}`,
    link: tag(it, 'ht:news_item_url'), image: tag(it, 'ht:picture'),
    started: Date.parse(tag(it, 'pubDate')) || 0, src: `Google Trends ${geo}`,
  }));
}
const NEWS_QUERIES = ['viral animal', 'zoo baby animal', 'goes viral', 'viral meme', 'viral tiktok', 'viral video', 'game trailer leak', 'mascot viral', 'internet obsessed'];
async function bingNews(q) {
  const xml = await get(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&qft=sortbydate%3d%221%22&format=rss`);
  return items(xml).slice(0, 10).map(it => ({
    title: tag(it, 'title'), detail: tag(it, 'description').slice(0, 200),
    link: tag(it, 'link'), image: bingImg(tag(it, 'News:Image')),
    started: Date.parse(tag(it, 'pubDate')) || 0, src: 'News',
  }));
}
// Google News search limited to the last few hours (fresher than Bing)
async function googleNews(q, window = '2h') {
  const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:' + window)}&hl=en-US&gl=US&ceid=US:en`);
  return items(xml).slice(0, 15).map(it => ({ title: tag(it, 'title'), link: tag(it, 'link'), started: Date.parse(tag(it, 'pubDate')) || 0, src: 'Google News' }));
}
async function knowYourMeme() {
  const xml = await get('https://knowyourmeme.com/newsfeed.rss');
  return items(xml).slice(0, 15).map(it => {
    const desc = tag(it, 'description');
    const img = (desc.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    return { title: tag(it, 'title'), detail: stripHtml(desc).slice(0, 250), link: tag(it, 'link'), image: img || '', started: Date.parse(tag(it, 'pubDate')) || 0, src: 'Know Your Meme' };
  });
}
async function bluesky() {
  const j = await get('https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrends', true);
  return (j?.trends || []).slice(0, 20).map(t => ({ title: t.displayName, src: 'Bluesky trending', started: t.startedAt ? Date.parse(t.startedAt) : 0 }));
}
async function wikipedia() {
  const d = new Date(Date.now() - DAY);
  const p = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  const j = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${p}`, true);
  const arts = j?.items?.[0]?.articles || [];
  return arts.filter(a => !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Deaths_in)/.test(a.article)).slice(0, 25)
    .map(a => ({ title: a.article.replace(/_/g, ' '), detail: `${a.views.toLocaleString()} Wikipedia views yesterday`, src: 'Wikipedia' }));
}
// public Telegram channel -> new posts since last time
async function tgChannel(name, state) {
  const html = await get(`https://t.me/s/${name}`);
  if (!html) return [];
  const last = state.tgSeen[name] || 0;
  const out = [];
  for (const block of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = +(block.match(/data-post="[^"\/]+\/(\d+)"/) || [])[1];
    if (!post || post <= last) continue;
    const text = stripHtml((block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    if (!text) continue;
    const img = (block.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/) || [])[1];
    const when = Date.parse((block.match(/datetime="([^"]+)"/) || [])[1]) || 0;
    out.push({ post, title: text.split('\n')[0].slice(0, 200), detail: text.slice(0, 400), link: `https://t.me/${name}/${post}`, image: img || '', started: when, src: `TG @${name}` });
  }
  if (out.length) state.tgSeen[name] = Math.max(last, ...out.map(o => o.post));
  // first time we see a channel: only keep the last 3 posts, not its whole history
  return last ? out : out.slice(-3);
}

// ---------- crypto sources ----------
let lastGecko = 0;
async function gecko(path) { // GeckoTerminal free API allows ~30 calls/min
  const wait = 2200 - (Date.now() - lastGecko); if (wait > 0) await sleep(wait);
  for (let a = 0; a < 2; a++) {
    lastGecko = Date.now();
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/${path}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      console.error('gecko', r.status, path);
      if (r.status !== 429) return null;
    } catch (e) { console.error('gecko', e.message); }
    if (a === 0) await sleep(8000);
  }
  return null;
}
function poolInfo(p, net) {
  const a = p.attributes;
  return {
    net, chain: CHAINS[net], name: a.name.split(' / ')[0], address: a.address,
    token: (p.relationships?.base_token?.data?.id || '').replace(/^[^_]+_/, ''),
    mc: +(a.market_cap_usd || a.fdv_usd) || 0, liq: +a.reserve_in_usd || 0,
    vol1h: +a.volume_usd?.h1 || 0, vol24: +a.volume_usd?.h24 || 0,
    ch1h: +a.price_change_percentage?.h1, ch24: +a.price_change_percentage?.h24,
    buys1h: a.transactions?.h1?.buys || 0, sells1h: a.transactions?.h1?.sells || 0,
    created: Date.parse(a.pool_created_at) || 0,
    link: `https://dexscreener.com/${net}/${a.address}`,
  };
}
async function chainTrending(net, duration = '24h') {
  const j = await gecko(`networks/${GECKO[net]}/trending_pools?duration=${duration}`);
  return (j?.data || []).map(p => poolInfo(p, net));
}
const CRYPTO_FEEDS = ['https://decrypt.co/feed', 'https://cointelegraph.com/rss', 'https://www.coindesk.com/arc/outboundfeeds/rss', 'https://www.theblock.co/rss.xml'];
// Tree of Alpha: fastest free crypto news, includes posts from key X accounts
async function treeOfAlpha() {
  const j = await get('https://news.treeofalpha.com/api/news?limit=40', true);
  return (Array.isArray(j) ? j : []).map(n => ({ title: n.title, link: n.url || n.link, started: n.time || 0, image: n.image || '', src: `Tree of Alpha (${n.source || 'news'})` })).filter(n => n.title);
}
// exchange listing announcements (Upbit, Bybit, OKX)
async function listings() {
  const out = [];
  const up = await get('https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=15&category=trade', true);
  for (const n of up?.data?.notices || []) out.push({ title: `Upbit: ${n.title}`, link: `https://upbit.com/service_center/notice?id=${n.id}`, started: Date.parse(n.listed_at) || 0, src: 'Upbit' });
  const by = await get('https://api.bybit.com/v5/announcements/index?locale=en-US&limit=15&type=new_crypto', true);
  for (const n of by?.result?.list || []) out.push({ title: `Bybit: ${n.title}`, link: n.url, started: n.dateTimestamp || n.publishTime || 0, src: 'Bybit' });
  const ok = await get('https://www.okx.com/api/v5/support/announcements?annType=announcements-new-listings', true);
  for (const g of ok?.data || []) for (const n of g.details || []) out.push({ title: `OKX: ${n.title}`, link: n.url, started: +n.pTime || 0, src: 'OKX' });
  return out;
}
// DexScreener's own trending meme categories (real numbers, all chains)
// brand-new coin pages on DexScreener: the creator's own description of the meme (crypto-native idea source)
async function dexProfiles() {
  const j = await get('https://api.dexscreener.com/token-profiles/latest/v1', true);
  return (Array.isArray(j) ? j : []).filter(p => CHAINS[p.chainId] && p.description)
    .map(p => ({ title: `New ${CHAINS[p.chainId]} coin: ${p.description.split('\n')[0].slice(0, 160)}`, detail: p.description.slice(0, 300), link: p.url, image: p.icon || '', src: 'DexScreener new coin' }));
}
// ---------- 🔥 launchpad radar: every new coin on the big launchpads ----------
async function launchpadFeed(slowDue) {
  const out = [];
  // Solana: pump.fun, LetsBonk, Believe... (Jupiter's list of the newest Solana tokens)
  const jup = await get('https://lite-api.jup.ag/tokens/v2/recent?limit=100', true);
  for (const x of Array.isArray(jup) ? jup : []) out.push({ k: 'SOL:' + x.id, name: x.name, symbol: x.symbol, pad: x.launchpad || 'Solana other', chain: 'SOL', t: Date.parse(x.createdAt || x.firstPool?.createdAt) || Date.now() });
  if (slowDue) {
    // BNB: four.meme newest
    try {
      const r = await fetch('https://four.meme/meme-api/v1/public/token/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ type: 'NEW', listType: 'NOR', pageIndex: 1, pageSize: 50 }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      for (const x of j?.data || []) out.push({ k: 'BNB:' + x.tokenAddress, name: x.name, symbol: x.shortName || x.symbol, pad: 'four.meme', chain: 'BNB', t: +x.createDate || Date.now() });
    } catch (e) { console.error('four.meme', e.message); }
    // Base: Clanker + Zora newest
    const cl = await get('https://clanker.world/api/tokens?sort=desc&limit=50', true);
    for (const x of cl?.data || []) out.push({ k: 'BASE:' + x.contract_address, name: x.name, symbol: x.symbol, pad: 'Clanker', chain: 'BASE', t: Date.parse(x.created_at) || Date.now() });
    const zo = await get('https://api-sdk.zora.engineering/explore?listType=NEW&count=50', true);
    for (const e of zo?.exploreList?.edges || []) { const x = e.node || {}; if (x.address) out.push({ k: 'BASE:' + x.address, name: x.name, symbol: x.symbol, pad: 'Zora', chain: 'BASE', t: Date.parse(x.createdAt) || Date.now() }); }
    // Robinhood (Pons), Elysium (Montra), Hyperliquid: newest pools
    for (const net of ['robinhood', 'elysium', 'hyperevm']) {
      const j = await gecko(`networks/${GECKO[net]}/new_pools`);
      for (const p of (j?.data || []).map(x => poolInfo(x, net))) out.push({ k: `${CHAINS[net]}:${p.token}`, name: p.name, symbol: p.name, pad: { robinhood: 'Robinhood', elysium: 'Elysium', hyperevm: 'Hyperliquid' }[net], chain: CHAINS[net], t: p.created || Date.now() });
    }
  }
  return out.filter(x => x.name);
}
const STOP = new Set('the,and,for,coin,token,official,meme,memes,inu,new,just,this,that,you,your,with,from,are,its,not,one,all,get,our,who,what,big,real,first,best,super,mega,baby,little,mini,king,lord,mr,mrs,sol,solana,bnb,base,eth,pump,fun,bonk,launch,community,cto,dev,ceo,based,degen,moon,gem,100x,1000x'.split(','));
const wordsOf = s => [...new Set(String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-zÀ-ɏ一-鿿]+/).filter(w => w.length >= 3 && !STOP.has(w)))];
// characters showing up in far more new launches than usual
function launchpadSpikes(state, now) {
  const recent = state.launches.filter(l => now - l.t < HOUR), before = state.launches.filter(l => now - l.t >= HOUR && now - l.t < 3 * HOUR);
  const count = list => { const c = {}; for (const l of list) for (const w of wordsOf(`${l.name} ${l.symbol}`)) (c[w] ||= []).push(l); return c; };
  const cur = count(recent), prev = count(before);
  return Object.entries(cur).map(([w, ls]) => ({ w, n: ls.length, base: (prev[w]?.length || 0) / 2, ls }))
    .filter(x => x.n >= 6 && x.n >= 3 * (x.base + 1)).sort((a, b) => b.n - a.n).slice(0, 12);
}
// sources that count as "crypto is talking about it"
const isCryptoSrc = s => /^(TG @|Tree of Alpha|Crypto news|DexScreener)/.test(String(s || ''));
async function dexMetas() {
  const j = await get('https://api.dexscreener.com/metas/trending/v1', true);
  return (Array.isArray(j) ? j : []).map(m => ({ name: m.name, mc: m.marketCap, ch1h: m.marketCapChange?.h1, ch24: m.marketCapChange?.h24, n: m.tokenCount }));
}
async function cryptoRss() {
  return (await Promise.all(CRYPTO_FEEDS.map(u => get(u)))).flatMap(items)
    .map(it => ({ title: tag(it, 'title'), link: tag(it, 'link'), started: Date.parse(tag(it, 'pubDate')) || 0, src: 'Crypto news' }));
}

// ---------- winners library ----------
const loadLibrary = () => { try { return JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch { return []; } };
const libraryText = lib => [...lib].sort((a, b) => (b.peak || 0) - (a.peak || 0))
  .map(x => `${x.ticker} (${x.chain}${x.peak ? ', peak ' + money(x.peak) : ''}): ${x.type}${x.meme ? ' — ' + x.meme : ''}${x.origin || x.story ? ' | origin: ' + (x.origin || x.story) : ''}${x.why ? ' | why it won: ' + x.why : ''}`).join('\n');
// lessons from coins that flopped and copycat fights
const LESSONS = (() => { try { return JSON.parse(fs.readFileSync(new URL('./lessons.json', import.meta.url), 'utf8')); } catch { return { rules: [], cases: [] }; } })();
const lessonsText = () => (LESSONS.rules.length ? `RULES LEARNED FROM FLOPS AND COPYCAT FIGHTS:\n${LESSONS.rules.map(r => '- ' + r).join('\n')}\n` : '') +
  (LESSONS.cases.length ? `FLOP / COPY CASES:\n${LESSONS.cases.map(c => `- ${c.name} (${c.kind}): ${c.lesson}`).join('\n')}` : '');

async function refreshLibrary(lib) {
  const have = new Set(lib.map(x => x.ticker.toUpperCase()));
  const cands = [];
  for (const net of Object.keys(CHAINS)) {
    const j = await gecko(`networks/${GECKO[net]}/pools?sort=h24_volume_usd_desc&page=1`);
    for (const p of (j?.data || []).map(x => poolInfo(x, net))) if (p.mc >= 5e6 && !have.has(p.name.toUpperCase())) cands.push(p);
  }
  if (!cands.length) return 0;
  const list = cands.slice(0, 40).map((c, i) => `${i}. ${c.name} on ${c.chain}, market cap ${money(c.mc)}, 24h volume ${money(c.vol24)}`).join('\n');
  const res = await geminiJSON(`These are the biggest coins by volume on Solana, Robinhood Chain and Elysium right now. Keep ONLY real MEME coins (not stablecoins, L1/L2 tokens, DeFi, wrapped assets, launchpad or exchange tokens).
For each meme coin, write what the meme is and where its story came from (if you are not sure, say "unclear origin").
Return JSON array: [{"i": index, "type": "short meme category e.g. viral zoo animal / internet relic face / chain lore cat", "story": "one line origin"}]
${list}`);
  let added = 0;
  for (const r of Array.isArray(res) ? res : []) {
    const c = cands[r.i]; if (!c || have.has(c.name.toUpperCase())) continue;
    lib.push({ ticker: c.name, chain: c.chain, peak: c.mc, type: String(r.type).slice(0, 80), story: String(r.story).slice(0, 170), src: 'auto', added: new Date().toISOString().slice(0, 10) });
    have.add(c.name.toUpperCase()); added++;
  }
  if (added) fs.writeFileSync(LIB_FILE, JSON.stringify(lib, null, 1));
  return added;
}

// ---------- Gemini ----------
async function gemini(prompt, model = MODEL, extra = {}) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }], ...extra }),
        signal: AbortSignal.timeout(180000),
      });
      const j = await r.json();
      const parts = j?.candidates?.[0]?.content?.parts;
      if (parts) return parts;
      console.error('gemini empty', JSON.stringify(j).slice(0, 300));
    } catch (e) { console.error('gemini', e.message); }
    await sleep(5000);
  }
  return null;
}
async function geminiJSON(prompt) {
  const parts = await gemini(prompt, MODEL, { generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } });
  if (!parts) return null;
  try { return JSON.parse(parts.map(p => p.text || '').join('')); } catch { return null; }
}

function learningNotes(state) {
  const ideas = Object.values(state.ideas).filter(i => !i.mover);
  const hits = ideas.filter(i => i.bestMc >= 250000).sort((a, b) => b.bestMc - a.bestMc).slice(0, 10).map(i => `${i.topic} (a coin hit ${money(i.bestMc)})`);
  const flops = ideas.filter(i => i.coins > 0 && (i.bestMc || 0) < 50000 && Date.now() - i.first > DAY).slice(-10).map(i => i.topic);
  const ignored = ideas.filter(i => !i.coins && Date.now() - i.first > 2 * DAY).slice(-15).map(i => i.topic);
  const liked = state.feedback.filter(f => f.r === 'up').slice(-20).map(f => f.topic);
  const disliked = state.feedback.filter(f => f.r === 'dn').slice(-20).map(f => f.topic);
  let s = '';
  if (liked.length) s += `\nThe user LIKED these (find more like them): ${liked.join('; ')}`;
  if (disliked.length) s += `\nThe user DISLIKED these (avoid ideas like them): ${disliked.join('; ')}`;
  if (hits.length) s += `\nPast ideas where crypto traders really made a coin that ran (strong signal): ${hits.join('; ')}`;
  if (flops.length) s += `\nPast ideas that got coins but went nowhere: ${flops.join('; ')}`;
  if (ignored.length) s += `\nPast ideas crypto ignored completely (nobody made a coin - avoid this kind): ${ignored.join('; ')}`;
  return s;
}

const CHAIN_NOTES = `BASE = Base: Coinbase crowd, Farcaster/Zora culture, blue-themed and onchain-culture memes (BRETT, TOSHI).
BNB = BNB Chain/four.meme: Binance/CZ-related memes, Chinese-language memes, CZ's dog Broccoli style.
ETH = Ethereum: older, bigger-money memes, high gas - only for strong ideas (PEPE, MOG, SPX).
HL = Hyperliquid (HyperEVM): Hyperliquid community, Hypurr cat lore, trader culture.
SOL = Solana/pump.fun: biggest crowd, fast news coins, rewards low-effort real photos and ultra-simple drawings.
RH = Robinhood Chain/Pons: US retail crowd, Robinhood/stock/finance lore, stock-paired memes and cats did well; past its peak.
ELY = Elysium/Montra: new Hyperliquid L2 (launched Nov 9 2026), early window, Hyperliquid lore (Hypurr cat, "Hype" prefix, slash-tickers) does well.`;

async function aiFilter(cands, metas, state, lib) {
  if (!cands.length) return [];
  const recent = Object.values(state.ideas).filter(i => !i.mover && Date.now() - i.first < 3 * DAY).map(i => i.topic);
  const list = cands.map((c, i) => `${i}. [${c.src}] ${c.title}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
  const prompt = `You are a meme coin scout. You find NEW viral things that crypto traders will turn into meme coins. Now: ${new Date().toUTCString()}.

LIBRARY OF PAST WINNING MEME COINS (learn the patterns: what the meme was and where the story came from):
${libraryText(lib)}

${lessonsText()}

The patterns that win: viral animal with a name (MOODENG, PNUT, WIF, FIONA, PENGUIN); internet relic/meme character (TROLL, CHILLGUY, GIGA, POPCAT); object or moment from a huge event (GTA 6 trailer -> DACITY); celebrity/founder/brand/government post (BINANCELIFE, PENGUIN, SHRUB, SI); AI/tech news-jack (O, GOAT, FARTCOIN); self-aware joke (USELESS, FARTCOIN); chain lore (CASHCAT, ROBIN, Hypurr cats on Elysium); stock/brand corporate drama (MEME vs AMC).
NEVER pick politics, elections, politicians, government, war or military news unless a coin about it is already trading.
Prefer things CRYPTO people are already noticing: items from crypto sources (TG channels, Tree of Alpha, DexScreener new coins) count most.
The patterns that lose: sports results, plain political news, deaths/tragedies/crime/disasters, holidays, regional celebrity gossip, TV drama plots, generic news with no character, things already old. Never pick tragedies, real private people or children.
${learningNotes(state)}
Already sent recently (do NOT return these again, even under another name): ${recent.join('; ') || 'none'}

CHAINS right now:
${metas}
${CHAIN_NOTES}

RULES: Only return an item if it clearly MATCHES a winner pattern from the library - you must name the closest past winner and say why it is similar. If you cannot name a convincing match, leave it out. A crypto trader must look at it and think "that's a coin". Ask: would CT (crypto twitter) actually meme this? If not, leave it out.
Score honestly: 9-10 only if it is exploding right now AND strongly matches a big winner. Most good ideas are 6-8.
Return a JSON array (empty if nothing qualifies):
{"i": index of the best source item, "topic": "short name", "tickers": ["BEST", "ALT1", "ALT2"] (3-8 letters, no $, the exact word people will search first),
 "score": 1-10, "why": "one plain line: what it is and why CT would meme it",
 "like": "TICKER of the closest past winner", "like_why": "short: how it is similar",
 "chain": "SOL|RH|ELY|BASE|BNB|ETH|HL", "chain_why": "short reason",
 "art": "one line simple art idea (one character on a plain background, style)",
 "fresh": "rising|peaking|old"}
Only include score 6 or higher.

${list}`;
  const res = await geminiJSON(prompt);
  if (!Array.isArray(res)) return null;
  return res.filter(x => x.score >= 6 && cands[x.i] && x.like)
    .map(x => ({ ...x, tickers: (x.tickers || []).map(t => String(t).replace(/^\$/, '').toUpperCase()).filter(Boolean).slice(0, 3), cand: cands[x.i] }));
}

// crypto news that matters to someone launching meme coins
async function newsFilter(newsItems, lib) {
  if (!newsItems.length) return [];
  const list = newsItems.map((n, i) => `${i}. [${n.src}] ${n.title}${n.detail && n.detail !== n.title ? ' — ' + n.detail.slice(0, 250) : ''}`).join('\n');
  const res = await geminiJSON(`You filter breaking news for someone who LAUNCHES meme coins on Solana (pump.fun), Robinhood Chain (Pons) and Elysium (Montra, Hyperliquid L2).
Keep ONLY news that could change what they launch or when: a meme coin running or crashing hard; a new chain/launchpad/meme platform or big change to pump.fun, Pons, Montra, Hyperliquid, Robinhood Chain; a celebrity, brand, government or big account doing something with a coin or a meme; exchange listings of meme coins; a viral moment crypto twitter is already memeing; rules/hacks that hit meme coins.
Drop: generic Bitcoin/ETH price moves, ETFs, macro, stocks, company earnings, adverts, giveaways, anything unrelated to meme coins.
ALWAYS drop politics, elections, government, war, military, crime and disasters - UNLESS the story is directly about a meme coin (e.g. a president or government launching or posting a coin).
Return JSON array (empty if none): [{"i": index, "why": "one short line: why this matters for launching a meme coin", "urgent": true/false}]
${list}`);
  if (!Array.isArray(res)) return null;
  return res.filter(r => newsItems[r.i]).map(r => ({ ...newsItems[r.i], why: r.why, urgent: !!r.urgent }));
}

// what meme is a fast-moving new coin, and does it fit a winner pattern
async function moverFilter(movers, lib) {
  if (!movers.length) return [];
  const list = movers.map((m, i) => `${i}. $${m.name} on ${m.chain}, ${ago(Date.now() - m.created)} old, mc ${money(m.mc)}, 1h volume ${money(m.vol1h)}`).join('\n');
  const res = await geminiJSON(`These brand-new coins are taking off right now. Using the library of past winners below, say what each one's meme probably is and whether it fits a winning pattern.
LIBRARY:
${libraryText(lib).split('\n').slice(0, 40).join('\n')}

Return JSON array ONLY for coins that look like a real meme with a specific story or character (drop random letters, generic words like DOG/CAT/PEPE/AI with no specific hook, scams copying big tokens, clones of an existing coin):
[{"i": index, "meme": "one line: what the meme probably is (say 'probably' if unsure)", "like": "closest past winner ticker", "score": 1-10}]
${list}`);
  if (!Array.isArray(res)) return null;
  return res.filter(r => movers[r.i] && r.score >= 7).map(r => ({ ...movers[r.i], meme: r.meme, like: r.like, score: r.score }));
}

// ---------- DexScreener: real coins ----------
const dexCache = {};
async function dexSearch(q) {
  const k = q.toLowerCase();
  if (!(k in dexCache)) dexCache[k] = (await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, true))?.pairs || [];
  return dexCache[k];
}
const symOf = p => p.baseToken.symbol.toLowerCase().replace(/^\$/, '');
// all real coins on our 3 chains that match the tickers or the topic name, one per token
async function findCoins(tickers, topic) {
  const pairs = [];
  for (const q of [...new Set([...tickers, topic])]) pairs.push(...await dexSearch(q));
  const tks = tickers.map(t => t.toLowerCase());
  const best = {};
  for (const p of pairs) {
    if (!CHAINS[p.chainId]) continue;
    if (!tks.includes(symOf(p)) && key(p.baseToken.name) !== key(topic)) continue;
    const a = p.baseToken.address;
    if (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0)) best[a] = p;
  }
  return Object.values(best);
}
const isLive = p => (p.liquidity?.usd || 0) >= 1000 && (p.volume?.h24 || 0) >= 1000;
function coinLine(p) {
  const mc = p.marketCap || p.fdv || 0;
  const t = p.txns?.h1 || {};
  return `• <b>$${esc(p.baseToken.symbol)}</b> ${CHAINS[p.chainId]} · mc ${money(mc)} · liq ${money(p.liquidity?.usd)} · vol24 ${money(p.volume?.h24)} · ${p.pairCreatedAt ? ago(Date.now() - p.pairCreatedAt) + ' old' : 'age ?'}\n` +
    `   1h ${pct(p.priceChange?.h1)} · ${t.buys ?? '?'} buys / ${t.sells ?? '?'} sells · <a href="${esc(p.url)}">chart</a> · <code>${esc(p.baseToken.address)}</code>`;
}

// SOL safety via RugCheck (free)
// Base / BNB / Ethereum safety via GoPlus (free)
const GOPLUS_ID = { base: 8453, bsc: 56, ethereum: 1 };
async function goplus(net, addr) {
  const j = await get(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_ID[net]}?contract_addresses=${addr}`, true);
  const r = j?.result?.[addr.toLowerCase()];
  if (!r) return '';
  const bad = [], warn = [];
  if (r.is_honeypot === '1') bad.push('honeypot (cannot sell)');
  if (r.cannot_sell_all === '1') bad.push('cannot sell all');
  if (+r.sell_tax > 0.1) bad.push(`sell tax ${Math.round(r.sell_tax * 100)}%`);
  if (r.is_mintable === '1') warn.push('mintable');
  if (r.owner_change_balance === '1') bad.push('owner can change balances');
  if (r.hidden_owner === '1') warn.push('hidden owner');
  if (r.is_open_source === '0') warn.push('code not verified');
  const top = (r.holders || []).slice(0, 10).reduce((s, h) => s + (+h.percent || 0), 0);
  if (top > 0.5) warn.push(`top 10 hold ${Math.round(top * 100)}%`);
  return `${bad.length ? '🔴' : warn.length ? '🟡' : '🟢'} GoPlus${bad.length || warn.length ? '' : ' clean'}${bad.length ? ' · DANGER: ' + bad.join(', ') : ''}${warn.length ? ' · warn: ' + warn.join(', ') : ''}`;
}
async function rugcheck(mint) {
  const j = await get(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, true);
  if (!j) return '';
  const bad = (j.risks || []).filter(r => r.level === 'danger').map(r => r.name);
  const warn = (j.risks || []).filter(r => r.level === 'warn').map(r => r.name);
  return `${bad.length ? '🔴' : warn.length ? '🟡' : '🟢'} RugCheck${bad.length || warn.length ? '' : ' clean'}${bad.length ? ' · DANGER: ' + bad.slice(0, 3).join(', ') : ''}${warn.length ? ' · warn: ' + warn.slice(0, 3).join(', ') : ''}`;
}

// ---------- Telegram ----------
const CHAT = () => process.env.TELEGRAM_CHAT_ID;
const printMode = () => !process.env.TELEGRAM_TOKEN || !CHAT();
async function tg(method, body, isForm = false) {
  if (printMode()) { if (method !== 'getUpdates') console.log(`\n[${method}]`, isForm ? '(file)' : JSON.stringify(body).slice(0, 300)); return { ok: true, result: [] }; }
  for (let a = 0; a < 4; a++) {
    if (a) await sleep(8000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, isForm
        ? { method: 'POST', body }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      console.error('telegram', method, r.status, JSON.stringify(j).slice(0, 200));
      if (r.status === 429) { await sleep(((j.parameters?.retry_after) || 5) * 1000); continue; }
      if (r.status === 400 || r.status === 403) return { ok: false, bad: true };
    } catch (e) { console.error('telegram', e.message); }
  }
  return null;
}
async function sendText(text, { loud = false, markup } = {}) {
  if (printMode()) { console.log('\n' + text.replace(/<[^>]+>/g, '') + '\n'); return true; }
  const parts = []; let cur = '';
  for (const block of text.split('\n\n')) { if ((cur + block).length > 3900) { parts.push(cur); cur = ''; } cur += block + '\n\n'; }
  if (cur.trim()) parts.push(cur);
  for (let i = 0; i < parts.length; i++) {
    const body = { chat_id: CHAT(), text: parts[i], parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: !loud };
    if (markup && i === parts.length - 1) body.reply_markup = markup;
    if (!(await tg('sendMessage', body))?.ok) return false;
  }
  return true;
}
const ideaButtons = id => ({ inline_keyboard: [[{ text: '🎨 Make art', callback_data: `art:${id}` }, { text: '👍', callback_data: `up:${id}` }, { text: '👎', callback_data: `dn:${id}` }]] });
const rateButtons = id => ({ inline_keyboard: [[{ text: '👍', callback_data: `up:${id}` }, { text: '👎', callback_data: `dn:${id}` }]] });
async function sendWithPhoto(caption, image, markup, loud) {
  if (printMode()) { console.log('\n[photo: ' + (image || 'none') + ']\n' + caption.replace(/<[^>]+>/g, '') + '\n'); return true; }
  if (image) {
    if (caption.length <= 1024) {
      const r = await tg('sendPhoto', { chat_id: CHAT(), photo: image, caption, parse_mode: 'HTML', reply_markup: markup, disable_notification: !loud });
      if (r?.ok) return true;
      if (r === null) return false;
    } else {
      const r = await tg('sendPhoto', { chat_id: CHAT(), photo: image, disable_notification: !loud });
      if (r === null) return false;
    }
  }
  return sendText(caption, { loud, markup });
}

async function findImage(topic, cand) {
  if (cand?.image) return cand.image;
  const n = [...await bingNews(topic), ...(cand ? await bingNews(cand.title.slice(0, 80)) : [])];
  const withImg = n.find(x => x.image);
  if (withImg) return withImg.image;
  const w = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic.replace(/ /g, '_'))}`, true);
  return w?.thumbnail?.source || '';
}

// ---------- 🎨 art ----------
async function makeArt(idea) {
  const parts = [];
  if (idea.image) {
    try {
      const r = await fetch(idea.image, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      const type = (r.headers.get('content-type') || '').split(';')[0];
      if (r.ok && type.startsWith('image/')) parts.push({ inline_data: { mime_type: type, data: Buffer.from(await r.arrayBuffer()).toString('base64') } });
    } catch { /* no reference */ }
  }
  parts.push({ text: `Make a meme coin mascot image for $${idea.tickers[0]} (${idea.topic}).
Idea: ${idea.art}
${parts.length ? 'Use the attached photo only as a reference for what the subject looks like - keep the features that make it instantly recognisable. Do not copy the photo itself.' : ''}
Rules: ONE character only, centered, on a plain solid-colour background. Simple and bold, readable at tiny thumbnail size. No text, no letters, no logos, no watermarks, no extra characters. Square image.` });
  const out = await gemini(parts, IMAGE_MODEL, { generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
  const img = out?.find(p => p.inlineData || p.inline_data);
  const d = img?.inlineData || img?.inline_data;
  return d ? { buf: Buffer.from(d.data, 'base64'), mime: d.mimeType || d.mime_type || 'image/png' } : null;
}

// ---------- button presses ----------
async function handleButtons(state) {
  if (printMode()) return;
  const u = await tg('getUpdates', { offset: state.tgOffset || 0, timeout: 0, allowed_updates: ['callback_query', 'message'] });
  for (const up of u?.result || []) {
    state.tgOffset = up.update_id + 1;
    const cq = up.callback_query;
    if (!cq || String(cq.message?.chat?.id) !== String(CHAT())) continue;
    const [act, id] = String(cq.data).split(':');
    const idea = state.ideas[id];
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: act === 'art' ? 'Making art…' : 'Saved' });
    if (!idea) { await sendText('That one is too old, sorry.'); continue; }
    if (act === 'up' || act === 'dn') {
      state.feedback = state.feedback.filter(f => f.id !== id);
      state.feedback.push({ id, topic: idea.mover ? `new coin $${idea.topic} (${idea.why || ''})` : idea.topic, r: act, t: Date.now() });
      await sendText(act === 'up' ? `👍 Got it — more like <b>${esc(idea.topic)}</b>.` : `👎 Got it — fewer like <b>${esc(idea.topic)}</b>.`);
    } else if (act === 'art' && !idea.mover) {
      await sendText(head('🎨 MAKING ART') + `For <b>$${esc(idea.tickers[0])}</b> (${esc(idea.topic)})… about 30 seconds.`);
      const art = await makeArt(idea);
      if (!art) { await sendText(`Couldn't make art for ${esc(idea.topic)} this time — press 🎨 again to retry.`); continue; }
      const fd = new FormData();
      fd.append('chat_id', CHAT());
      fd.append('caption', `🎨 TEST ART\n━━━━━━━━━━━━━━\n$${idea.tickers[0]} — ${idea.topic}. Press 🎨 again for another version.`);
      fd.append('reply_markup', JSON.stringify(ideaButtons(id)));
      fd.append('photo', new Blob([art.buf], { type: art.mime }), 'art.png');
      await tg('sendPhoto', fd, true);
    }
  }
}

// ---------- 🚨 race watch ----------
async function raceWatch(state, now) {
  const alerts = [];
  for (const idea of Object.values(state.ideas)) {
    if (idea.mover) continue;
    const age = now - idea.first;
    if (age > 7 * DAY || (age > DAY && now - (idea.lastRace || 0) < HOUR)) continue;
    idea.lastRace = now;
    // only the best ticker + exact topic name, so generic words don't over-count
    const coins = await findCoins(idea.tickers.slice(0, 1), idea.topic);
    idea.seenPairs ||= []; idea.raceAlerts ||= 0;
    for (const p of coins) {
      const mc = p.marketCap || p.fdv || 0;
      if (!p.pairCreatedAt || p.pairCreatedAt < idea.first - 10 * MIN) continue;
      // ignore dead junk tokens (no liquidity, no volume) - they can still count later if they come alive
      if ((p.liquidity?.usd || 0) < 2000 && (p.volume?.h24 || 0) < 2000) continue;
      if (mc > (idea.bestMc || 0)) { idea.bestMc = mc; idea.bestUrl = p.url; idea.bestChain = CHAINS[p.chainId]; }
      if (idea.seenPairs.includes(p.baseToken.address)) continue;
      idea.seenPairs.push(p.baseToken.address);
      idea.coins = (idea.coins || 0) + 1;
      if (age < 2 * DAY && idea.raceAlerts < 3) { idea.raceAlerts++; alerts.push(head('🚨 RACE ALERT', CHAIN_NAME[CHAINS[p.chainId]]) + `Someone launched <b>$${esc(p.baseToken.symbol)}</b> for your idea "<b>${esc(idea.topic)}</b>"\n${coinLine(p)}`); }
    }
  }
  return alerts;
}

async function weeklyScorecard(state, now) {
  const week = Object.values(state.ideas).filter(i => !i.mover && now - i.first < 7 * DAY);
  if (!week.length) return '';
  const withCoin = week.filter(i => i.coins > 0);
  const big = week.filter(i => i.bestMc >= 250000), huge = week.filter(i => i.bestMc >= 1e6);
  const bySrc = {};
  for (const i of week) { const s = (bySrc[i.src] ||= { n: 0, coin: 0, big: 0 }); s.n++; if (i.coins) s.coin++; if (i.bestMc >= 250000) s.big++; }
  const byScore = {};
  for (const i of week) { const b = i.score >= 9 ? '9-10' : i.score >= 8 ? '8' : i.score >= 7 ? '7' : '6'; const s = (byScore[b] ||= { n: 0, big: 0 }); s.n++; if (i.bestMc >= 250000) s.big++; }
  const top = week.filter(i => i.bestMc).sort((a, b) => b.bestMc - a.bestMc).slice(0, 5);
  const fb = state.feedback.filter(f => now - f.t < 7 * DAY);
  return `${head('📊 WEEKLY SCORECARD')}Ideas sent: ${week.length} · got a coin made: ${withCoin.length} · coin passed $250K: ${big.length} · passed $1M: ${huge.length}
👍 ${fb.filter(f => f.r === 'up').length} · 👎 ${fb.filter(f => f.r === 'dn').length}

<b>By source</b> (ideas / got coin / $250K+)
${Object.entries(bySrc).sort((a, b) => b[1].n - a[1].n).map(([s, v]) => `${esc(s)}: ${v.n} / ${v.coin} / ${v.big}`).join('\n')}

<b>By score</b> (ideas / $250K+)
${Object.entries(byScore).map(([s, v]) => `${s}/10: ${v.n} / ${v.big}`).join('\n')}

<b>Best coins made from your ideas</b>
${top.map(i => `• ${esc(i.topic)}: ${money(i.bestMc)} on ${i.bestChain} · <a href="${esc(i.bestUrl)}">chart</a>`).join('\n') || 'none yet'}`;
}

// ---------- 🎨 what characters and art styles are trending ----------
async function artTrends(state, now) {
  const coins = Object.entries(state.chainTop || {}).flatMap(([c, l]) => l.map(x => ({ ...x, chain: c })));
  const movers = Object.values(state.ideas).filter(i => i.mover && now - i.first < 6 * HOUR).map(i => `$${i.topic}: ${i.why}`);
  const ideas = Object.values(state.ideas).filter(i => !i.mover && now - i.first < 12 * HOUR).map(i => i.topic);
  if (!coins.length) return null;
  // coin logos so the AI can actually SEE the art styles
  const parts = [];
  const byNet = {};
  for (const x of coins) if (x.token) (byNet[x.net] ||= []).push(x);
  let n = 0;
  for (const [net, list] of Object.entries(byNet)) {
    const j = await get(`https://api.dexscreener.com/tokens/v1/${net}/${list.slice(0, 6).map(x => x.token).join(',')}`, true);
    const seen = new Set();
    for (const p of Array.isArray(j) ? j : []) {
      const img = p.info?.imageUrl; const a = p.baseToken?.address;
      if (!img || seen.has(a) || n >= 16) continue; seen.add(a);
      try {
        const r = await fetch(img, { signal: AbortSignal.timeout(15000) });
        const type = (r.headers.get('content-type') || '').split(';')[0];
        if (!r.ok || !type.startsWith('image/')) continue;
        parts.push({ text: `Logo of $${p.baseToken.symbol} (${CHAINS[net]}):` }, { inline_data: { mime_type: type, data: Buffer.from(await r.arrayBuffer()).toString('base64') } });
        n++;
      } catch { /* skip */ }
    }
  }
  parts.push({ text: `Above are logos of the top trending meme coins right now. Full trending list:
${coins.map(x => `$${x.name} (${x.chain}) ${money(x.mc)} ${chg(x)}`).join(', ')}
New coins taking off in the last 6h: ${movers.join('; ') || 'none'}
Viral coin ideas found in the last 12h: ${ideas.join('; ') || 'none'}

For a meme coin creator, say what is TRENDING right now:
1. characters/subjects (e.g. hippos, raccoons, Pepe variants, cats in hoods, real people) - only ones that appear 2+ times or are clearly hot
2. art styles you can SEE in the logos (e.g. real animal photo, MS-Paint drawing, 3D render, anime, pixel art, cartoon with thick outline, AI-cinematic)
3. one short tip: what to make next.
Return JSON: {"characters": [{"name": "...", "examples": ["TICKER", ...], "note": "short"}], "art": [{"style": "...", "examples": ["TICKER"], "note": "short"}], "tip": "..."}` });
  const out = await gemini(parts, MODEL, { generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } });
  if (!out) return null;
  let j; try { j = JSON.parse(out.map(p => p.text || '').join('')); } catch { return null; }
  const chars = j.characters || [], art = j.art || [];
  if (!chars.length && !art.length) return null;
  const sig = [...chars.map(c => key(c.name)), '|', ...art.map(a => key(a.style))].join(',');
  if (sig === state.lastArt) return null; // nothing changed since last report
  const msg = new String(head('🎨 TRENDING CHARACTERS & ART') +
    `<b>Characters:</b>\n${chars.map(c => `• <b>${esc(c.name)}</b> — ${(c.examples || []).map(t => '$' + esc(String(t).replace(/^\$+/, ''))).join(' ')}${c.note ? ' · ' + esc(c.note) : ''}`).join('\n') || '• nothing clear'}\n\n` +
    `<b>Art styles:</b>\n${art.map(a => `• <b>${esc(a.style)}</b> — ${(a.examples || []).map(t => '$' + esc(String(t).replace(/^\$+/, ''))).join(' ')}${a.note ? ' · ' + esc(a.note) : ''}`).join('\n') || '• nothing clear'}` +
    (j.tip ? `\n\n💡 <b>Make next:</b> ${esc(j.tip)}` : ''));
  msg.sig = sig;
  return msg;
}

// ---------- one check ----------
const NEWS_SLOT = s => NEWS_QUERIES[s % NEWS_QUERIES.length];
async function tick(state, lib, n) {
  const now = Date.now();
  const save = () => { fs.mkdirSync(new URL('./state/', import.meta.url), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state)); };
  let failed = false;

  await handleButtons(state); save();

  // --- sources (fast ones every tick, slow ones less often) ---
  const due = (k, ms) => FORCE || now - (state.due[k] || 0) >= ms ? (state.due[k] = now, true) : false;
  // 3 of the news searches per minute (all 9 every 3 minutes), Google News limited to the last 2 hours
  const slot = state.newsSlot = ((state.newsSlot || 0) + 1) % 3;
  const newsQ = FORCE ? NEWS_QUERIES : NEWS_QUERIES.filter((_, i) => i % 3 === slot);
  const [viralLists, tgLists] = await Promise.all([
    Promise.all([
      due('x', 5 * MIN) ? Promise.all([xTrends('united-states', 'US'), xTrends('united-kingdom', 'UK')]).then(a => a.flat()) : [],
      googleTrends('US'), googleTrends('GB'), knowYourMeme(), bluesky(),
      (async () => { const o = []; for (const q of newsQ) { o.push(...await googleNews(q)); await sleep(400); } return o.filter(x => !x.started || now - x.started < 6 * HOUR); })(),
      due('wiki', HOUR) ? wikipedia() : [],
    ]),
    Promise.all([...TG_CHANNELS.map(c => tgChannel(c, state)), treeOfAlpha(), dexProfiles()]),
  ]);
  const toa = tgLists[TG_CHANNELS.length].filter(n => n.started && now - n.started < 2 * HOUR);
  const profiles = tgLists[TG_CHANNELS.length + 1];
  const tgPosts = tgLists.slice(0, TG_CHANNELS.length).flat();
  console.error('sources:', ['X', 'GoogleUS', 'GoogleGB', 'KYM', 'Bluesky', 'News', 'Wiki'].map((s, i) => `${s}=${viralLists[i].length}`).join(' '), `TG=${tgPosts.length} TreeOfAlpha=${toa.length} NewCoins=${profiles.length}`);
  const viral = [...viralLists.flat(), ...tgPosts, ...toa, ...profiles].filter(c => c.title);

  for (const c of viral) {
    const k = key(c.title); if (!k) continue;
    const t = state.trends[k] ||= { first: now, srcs: [] };
    t.last = now;
    if (!t.srcs.includes(c.src)) t.srcs.push(c.src);
  }
  const fresh = []; const dup = new Set();
  for (const c of viral) {
    const k = key(c.title); if (!k || state.judged[k] || dup.has(k)) continue;
    dup.add(k);
    if (c.started && now - c.started > 12 * HOUR) { state.judged[k] = now; continue; } // only NEW stories
    fresh.push(c);
  }

  // chain context (every 10 min)
  if (due('chains', 15 * MIN) || !state.metas) {
    state.chainTop = {};
    for (const net of Object.keys(CHAINS)) {
      const seen = new Set();
      // memes only: drop stablecoins, wrapped/major tokens and repeat pools of the same coin
      state.chainTop[CHAINS[net]] = (await chainTrending(net))
        .filter(x => !NOT_MEME.test(x.name) && !seen.has(x.name.toUpperCase()) && seen.add(x.name.toUpperCase()))
        .slice(0, 6);
    }
    state.dexMetas = (await dexMetas()).slice(0, 10);
    state.metas = Object.entries(state.chainTop).map(([n, l]) => `${n}: ${l.map(x => `${x.name} ${money(x.mc)} ${chg(x)}`).join(', ')}`).join('\n') +
      (state.dexMetas.length ? `\nMETAS (DexScreener meme categories, all chains): ${state.dexMetas.map(m => `${m.name} ${money(m.mc)} 1h ${pct(m.ch1h)} 24h ${pct(m.ch24)}`).join('; ')}` : '');
  }

  // --- ideas ---
  const judgedOk = [];
  const picks = [];
  for (let i = 0; i < fresh.length; i += 120) {
    const chunk = fresh.slice(i, i + 120);
    const r = await aiFilter(chunk, state.metas + (state.padNow ? `
WORDS SPIKING IN NEW LAUNCHES ON LAUNCHPADS RIGHT NOW (launches/hour): ${state.padNow}` : ''), state, lib);
    if (r === null) { console.error('AI failed for', chunk.length, 'items - retry next tick'); continue; }
    picks.push(...r); judgedOk.push(...chunk);
  }
  // ideas still waiting for crypto to notice them (kept up to 12h, re-checked every tick)
  const waiting = Object.values(state.pending).filter(x => now - x.at < 12 * HOUR).map(x => x.p);
  const seenIds = new Set();
  const newPicks = [...picks, ...waiting].filter(p => !state.ideas[idOf(p.topic)] && p.fresh !== 'old' && !seenIds.has(idOf(p.topic)) && seenIds.add(idOf(p.topic))).sort((a, b) => b.score - a.score);
  for (const p of newPicks) {
    const id = idOf(p.topic);
    const tr = state.trends[key(p.cand.title)] || {};
    const coins = (await findCoins(p.tickers, p.topic)).filter(isLive).sort((a, b) => (b.marketCap || b.fdv || 0) - (a.marketCap || a.fdv || 0));
    // CRYPTO SIGNAL: only send if crypto pages are talking about it, or real coins for it are trading with volume
    const words = [key(p.topic), ...p.tickers.map(key)].filter(w => w.length >= 4);
    const mentions = new Set([p.cand.src, ...Object.entries(state.trends)
      .filter(([k, t]) => now - t.last < DAY && words.some(w => k.includes(w))).flatMap(([, t]) => t.srcs)].filter(isCryptoSrc));
    const trading = coins.filter(c => (c.volume?.h24 || 0) >= 10000 && c.pairCreatedAt && now - c.pairCreatedAt < 7 * DAY);
    if (!mentions.size && !trading.length) {
      const { cand, ...rest } = p;
      state.pending[id] = { at: state.pending[id]?.at || now, p: { ...rest, cand: { title: cand.title, src: cand.src, link: cand.link, image: cand.image, started: cand.started } } };
      continue;
    }
    delete state.pending[id];
    const signal = [mentions.size ? `talked about by ${[...mentions].slice(0, 3).join(', ')}` : '', trading.length ? `${trading.length} coin${trading.length > 1 ? 's' : ''} already trading (vol ${money(trading.reduce((s, c) => s + (c.volume?.h24 || 0), 0))}/24h)` : ''].filter(Boolean).join(' · ');
    const recentBig = coins.find(c => c.pairCreatedAt && now - c.pairCreatedAt < 3 * DAY && (c.marketCap || c.fdv || 0) >= 300000);
    const taken = new Set(coins.map(c => `${symOf(c)}|${c.chainId}`));
    const open = p.tickers.map(t => ({ t, chains: Object.entries(CHAINS).filter(([id]) => !taken.has(`${t.toLowerCase()}|${id}`)).map(([, l]) => l) })).filter(o => o.chains.length);
    const firstSeen = Math.min(tr.first || now, p.cand.started || now);
    let badge = p.fresh === 'rising' ? '🚀 RISING' : p.fresh === 'peaking' ? '⏳ PEAKING' : '🐢 OLD';
    if (badge.includes('RISING') && now - firstSeen > 12 * HOUR && (tr.srcs || []).length < 2) badge = '⏳ PEAKING';
    if (recentBig) badge = '⚠️ LATE';
    const loud = p.score >= LOUD_SCORE && !recentBig;
    const icon = recentBig ? '⚠️' : loud ? '🚨' : p.score >= 8 ? '🔥' : '👀';
    const src = p.cand.link ? `<a href="${esc(p.cand.link)}">${esc(p.cand.src)}</a>` : esc(p.cand.src);
    let cap = head('💡 COIN IDEA', `${icon} ${p.score}/10 · ${badge}`) +
      `🔗 <b>Crypto signal:</b> ${esc(signal)}\n\n<b>${esc(p.topic)}</b>\n${esc(p.why)}\n🧬 Like <b>$${esc(p.like)}</b> — ${esc(p.like_why)}\n\n`;
    if (coins.length) cap += `<b>Live coins already out:</b>\n${coins.slice(0, 3).map(coinLine).join('\n')}\n`;
    else cap += `<b>No live coin yet — you could be first.</b>\n`;
    if (open.length) cap += `<b>Open tickers:</b> ${open.map(o => `$${esc(o.t)} (${o.chains.join(' ')})`).join(' · ')}\n`;
    cap += `<b>Best chain:</b> ${esc(p.chain)} — ${esc(p.chain_why)}\n<b>Art:</b> ${esc(p.art)}\n`;
    cap += `\n${src} · first seen ${ago(now - firstSeen)} ago · in ${(tr.srcs || [p.cand.src]).length} source(s)`;
    const image = await findImage(p.topic, p.cand);
    state.ideas[id] = { first: now, topic: p.topic, tickers: p.tickers, art: p.art, why: p.why, like: p.like, score: p.score, src: p.cand.src, image, srcs: (tr.srcs || []).length };
    if (!await sendWithPhoto(cap, image, ideaButtons(id), loud)) { delete state.ideas[id]; failed = true; break; }
    save();
  }

  // spreading
  if (!failed) for (const idea of Object.values(state.ideas)) {
    if (idea.mover || idea.rerun || now - idea.first > DAY) continue;
    const words = [key(idea.topic), ...idea.tickers.map(key)].filter(w => w.length >= 4);
    const srcs = new Set(Object.entries(state.trends).filter(([k, t]) => t.last === now && words.some(w => k.includes(w))).flatMap(([, t]) => t.srcs));
    if (srcs.size >= Math.max(3, (idea.srcs || 1) + 2)) {
      if (await sendText(head('📣 TREND SPREADING') + `<b>${esc(idea.topic)}</b>\nNow in ${srcs.size} places: ${esc([...srcs].join(', '))}\nTickers: ${idea.tickers.map(t => '$' + esc(t)).join(' ')}`, { loud: true })) idea.rerun = true;
    }
  }

  // --- 📰 crypto news as it comes out (RSS every 3 min + Telegram channel posts every tick) ---
  if (!failed) {
    const slow = due('rss', 3 * MIN);
    const [rss, lst] = await Promise.all([slow ? cryptoRss() : [], slow ? listings() : []]);
    const newsNew = [...rss, ...toa, ...lst, ...tgPosts].filter(n => n.started && now - n.started < 2 * HOUR && !state.news[key(n.title)]);
    const kept = await newsFilter(newsNew, lib);
    if (kept !== null) {
      for (const n of kept) {
        const msg = head('📰 NEWS', n.urgent ? '⚡ important' : '') + `<b>${esc(n.title)}</b>\n<i>Why it matters: ${esc(n.why)}</i>\n<a href="${esc(n.link)}">${esc(n.src)}</a>${n.started ? ` · ${ago(now - n.started)} ago` : ''}`;
        if (!await sendText(msg, { loud: n.urgent })) { failed = true; break; }
        state.news[key(n.title)] = now;
      }
      if (!failed) for (const n of newsNew) state.news[key(n.title)] ||= now;
    }
  }

  // --- 🔴 live movers (every 2 min) ---
  if (!failed && due('movers', 3 * MIN)) {
    const cand = [];
    for (const net of Object.keys(CHAINS)) {
      for (const p of await chainTrending(net, '5m')) {
        const age = now - p.created;
        const [minMc, minVol] = MOVER_MIN[net];
        if (age > 12 * HOUR || p.mc < minMc || p.mc > 20e6 || p.vol1h < minVol || p.liq < 5000 || p.buys1h <= p.sells1h) continue;
        if (state.movers[p.token]) continue;
        cand.push(p);
      }
    }
    const kept = await moverFilter(cand, lib);
    if (kept !== null) {
      for (const m of cand) state.movers[m.token] ||= now;
      for (const m of kept) {
        const id = idOf('mover ' + m.token);
        const safety = m.net === 'solana' ? await rugcheck(m.token) : GOPLUS_ID[m.net] ? await goplus(m.net, m.token) : '';
        const msg = head('🪙 LIVE COIN MOVING', `${CHAIN_NAME[m.chain]} · ${m.score}/10`) +
          `<b>$${esc(m.name)}</b> · ${ago(now - m.created)} old\n${esc(m.meme)}\n🧬 Like <b>$${esc(m.like)}</b>\n` +
          `mc ${money(m.mc)} · liq ${money(m.liq)} · 1h vol ${money(m.vol1h)} · 1h ${pct(m.ch1h)}\n1h: ${m.buys1h} buys / ${m.sells1h} sells\n` +
          (safety ? safety + '\n' : '') + `<a href="${m.link}">chart</a> · <code>${esc(m.token)}</code>`;
        state.ideas[id] = { first: now, topic: m.name, tickers: [m.name], why: m.meme, mover: true, score: m.score, src: 'Live mover' };
        if (!await sendText(msg, { loud: m.score >= LOUD_SCORE, markup: rateButtons(id) })) { failed = true; break; }
      }
    }
  }

  // --- race watch (every 5 min) ---
  if (!failed && due('race', 5 * MIN)) for (const a of await raceWatch(state, now)) if (!await sendText(a, { loud: true })) { failed = true; break; }

  // --- hourly chain + metas digest ---
  // only when at least 2 coins are new to the top lists since the last update
  const topNames = Object.values(state.chainTop || {}).flat().map(x => `${x.chain}:${x.name}`);
  const newInTop = topNames.filter(n => !(state.lastTop || []).includes(n));
  if (!failed && newInTop.length >= 2 && (FORCE || now - (state.due.digest || 0) >= 30 * MIN)) {
    state.due.digest = now; state.lastTop = topNames;
    const top = state.chainTop || {};
    const themes = await geminiJSON(`Trending meme coins right now per chain:\n${state.metas}\nIn max 3 short lines, what themes/metas are forming on each chain (e.g. "hippo coins", "slash tickers", "stock-paired memes")? Only say what is visible in the list. Return JSON: {"lines": ["..."]}`);
    let d = head('📈 CHAIN UPDATE', `${newInTop.length} new in the top lists`) +
      Object.entries(top).map(([n, l]) => `<b>${CHAIN_NAME[n] || n}:</b> ` + ((l || []).slice(0, 5).map(x => `<a href="${x.link}">${esc(x.name)}</a> ${money(x.mc)} ${chg(x)}`).join(', ') || 'no data')).join('\n');
    const lines = (Array.isArray(themes) ? themes : themes?.lines || []).map(l => typeof l === 'string' ? l : Object.values(l || {}).join(': ')).filter(l => l && l.trim());
    if (lines.length) d += `\n\n<b>🧭 Metas forming:</b>\n${lines.map(l => '• ' + esc(l)).join('\n')}`;
    const hot = (state.dexMetas || []).filter(m => m.ch1h != null).sort((a, b) => (b.ch1h || 0) - (a.ch1h || 0)).slice(0, 6);
    if (hot.length) d += `\n\n<b>🔥 Hottest meme categories (DexScreener):</b>\n${hot.map(m => `• ${esc(m.name)} — ${money(m.mc)} · 1h ${pct(m.ch1h)} · 24h ${pct(m.ch24)} · ${m.n} coins`).join('\n')}`;
    if (!await sendText(d)) failed = true;
  }

  // --- 🔥 launchpad radar: collect every new launch, alert when a character spikes ---
  if (!failed) {
    const feed = await launchpadFeed(due('pads', 2 * MIN));
    const have = new Set(state.launches.map(l => l.k));
    for (const l of feed) if (!have.has(l.k)) { have.add(l.k); state.launches.push({ k: l.k, t: Math.min(l.t, now), name: String(l.name).slice(0, 40), symbol: String(l.symbol).slice(0, 15), pad: l.pad, chain: l.chain }); }
    state.launches = state.launches.filter(l => now - l.t < 3 * HOUR).slice(-6000);
    state.padSince ||= now; // needs ~2h of history to know what 'normal' looks like before alerting
    const spikes = now - state.padSince < 2 * HOUR ? [] : launchpadSpikes(state, now).filter(s => now - (state.padTrends[s.w] || 0) > 6 * HOUR);
    if (spikes.length && due('padcheck', 5 * MIN)) {
      const res = await geminiJSON(`These words suddenly appear in many NEW meme coin launches in the last hour (count now vs normal per hour), with example coin names.
Keep only words that are a real CHARACTER, animal, person, meme, object or story people are launching coins about. Drop generic words (moon, pump, ai, cat or dog with no specific hook, chain names, filler words, numbers).
${spikes.map((s, i) => `${i}. "${s.w}" — ${s.n} launches (normal ~${Math.round(s.base)}/h). Examples: ${s.ls.slice(0, 8).map(l => `${l.symbol} "${l.name}"`).join(', ')}`).join('\n')}
Return JSON array: [{"i": index, "character": "short name", "why": "one line: what it is and why it is being launched now (say 'unclear' if you don't know)"}]`);
      for (const r of Array.isArray(res) ? res : []) {
        const s = spikes[r.i]; if (!s) continue;
        state.padTrends[s.w] = now;
        const pads = {}; for (const l of s.ls) pads[l.pad] = (pads[l.pad] || 0) + 1;
        const live = (await dexSearch(s.w)).filter(p => CHAINS[p.chainId] && isLive(p) && p.pairCreatedAt && now - p.pairCreatedAt < 2 * DAY)
          .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0)).filter((p, i, a) => a.findIndex(q => q.baseToken.address === p.baseToken.address) === i).slice(0, 3);
        const msg = head('🔥 LAUNCHPAD TREND', `${s.n} new coins in 1h`) +
          `<b>${esc(r.character)}</b> — ${s.n} launches in the last hour (normally ~${Math.max(1, Math.round(s.base))}/h)\n${esc(r.why)}\n\n` +
          `<b>Where:</b> ${Object.entries(pads).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${esc(p)} ${n}`).join(' · ')}\n` +
          `<b>Examples:</b> ${s.ls.slice(-6).map(l => `$${esc(l.symbol)}`).join(' ')}\n` +
          (live.length ? `\n<b>Top live coins (last 2 days):</b>\n${live.map(coinLine).join('\n')}` : `\nNo coin with real volume yet.`);
        if (!await sendText(msg, { loud: s.n >= 20 })) { failed = true; break; }
      }
    }
    state.padNow = launchpadSpikes(state, now).slice(0, 8).map(s => `${s.w} ${s.n}/h`).join(', ');
  }

  // --- 🎨 trending characters & art styles (every 2h, only if something changed) ---
  if (!failed && due('art', 2 * HOUR)) {
    const rep = await artTrends(state, now);
    if (rep) { if (await sendText(rep)) state.lastArt = rep.sig; else failed = true; }
  }

  // --- weekly: scorecard + library refresh ---
  if (!failed && now - (state.lastScorecard || now) > 7 * DAY) {
    const sc = await weeklyScorecard(state, now);
    const added = await refreshLibrary(lib);
    if (!sc || await sendText(sc + (added ? `\n\n📚 Added ${added} new winning coins to the library.` : ''), { loud: true })) state.lastScorecard = now;
  }
  state.lastScorecard ||= now;

  if (!failed) for (const c of judgedOk) state.judged[key(c.title)] = now;
  save();
  console.error(`tick ${n}: ${viral.length} items, ${fresh.length} new, ${newPicks.length} ideas${failed ? ', TELEGRAM FAILED' : ''}`);
  return !failed;
}

// ---------- main ----------
async function main() {
  const start = Date.now();
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  for (const k of ['trends', 'ideas', 'news', 'judged', 'movers', 'tgSeen', 'due', 'pending', 'padTrends']) state[k] ||= {};
  if (!Array.isArray(state.launches)) state.launches = [];
  for (const [x, v] of Object.entries(state.pending)) if (Date.now() - v.at > 12 * HOUR) delete state.pending[x];
  if (!Array.isArray(state.feedback)) state.feedback = [];
  const now = Date.now();
  for (const k of ['trends', 'news', 'judged', 'movers']) for (const [x, v] of Object.entries(state[k])) if (now - (v.last || v.first || v) > 3 * DAY) delete state[k][x];
  for (const [x, v] of Object.entries(state.ideas)) { if (now - v.first > 30 * DAY) delete state.ideas[x]; else { v.score ??= 7; v.src ??= 'older version'; v.tickers ||= [v.topic]; } }
  state.feedback = state.feedback.slice(-300);
  const lib = loadLibrary();

  let n = 0, ok = true;
  do {
    const t0 = Date.now();
    ok = await tick(state, lib, ++n) && ok;
    if (ONCE) break;
    const rest = TICK_MS - (Date.now() - t0);
    if (Date.now() - start + Math.max(rest, 0) + 30000 > LOOP_MS) break;
    if (rest > 0) await sleep(rest);
  } while (true);
  if (!ok) { console.error('Telegram failed at least once - unsent items retry next run'); process.exit(1); }
}

// sources are exported so tools/check_sources.mjs can test them; the bot only runs when started directly
export { get, xTrends, googleTrends, bingNews, googleNews, knowYourMeme, bluesky, wikipedia, tgChannel, chainTrending, cryptoRss, treeOfAlpha, listings, dexMetas, goplus, launchpadFeed, launchpadSpikes, wordsOf, dexSearch, rugcheck, CHAINS, GECKO, TG_CHANNELS, NEWS_QUERIES };
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(e => { console.error(e); process.exit(1); });
