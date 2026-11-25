// Trend Bot: finds viral characters/things that could work as meme coins,
// checks if the ticker is open on Solana / Robinhood Chain / Elysium,
// and sends a report to Telegram. No npm packages needed (Node 20+).
//
// Env: GEMINI_API_KEY (needed), TELEGRAM_TOKEN + TELEGRAM_CHAT_ID (optional:
// without them the report is printed instead of sent).

import fs from 'node:fs';

const STATE_FILE = new URL('./state/seen.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const CHAINS = { solana: 'Solana', robinhood: 'Robinhood', elysium: 'Elysium' };
const DAY = 86400000;

// ---------- helpers ----------
async function get(url, asJson = false) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status);
    return asJson ? await r.json() : await r.text();
  } catch (e) {
    console.error('skip', url, e.message);
    return null;
  }
}
const decode = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };
const items = xml => (xml || '').split(/<item[\s>]/).slice(1);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const key = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const money = n => !n ? '?' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;

// ---------- viral sources (outside crypto) ----------
async function xTrends(region, label) {
  const html = await get(`https://trends24.in/${region}/`);
  if (!html) {
    const alt = await get(`https://getdaytrends.com/${region}/`);
    if (!alt) return [];
    return [...new Set([...alt.matchAll(/href="\/[a-z-]+\/trend\/([^"\/]+)\/"/g)].map(m => decodeURIComponent(m[1])))].slice(0, 25)
      .map(t => ({ title: t, src: `X trending ${label}` }));
  }
  const firstCard = html.split('trend-card__list')[1] || html; // latest hour only
  return [...firstCard.matchAll(/class=trend-link>([^<]+)/g)].slice(0, 25)
    .map(m => ({ title: decode(m[1]), src: `X trending ${label}` }));
}
async function googleTrends(geo) {
  const xml = await get(`https://trends.google.com/trending/rss?geo=${geo}`);
  return items(xml).map(it => ({
    title: tag(it, 'title'),
    detail: `${tag(it, 'ht:approx_traffic')} searches. ${tag(it, 'ht:news_item_title')}`,
    link: tag(it, 'ht:news_item_url'),
    src: `Google Trends ${geo}`,
  }));
}
const NEWS_QUERIES = ['viral', 'goes viral animal', 'zoo baby animal', 'viral meme', 'viral tiktok', 'trailer leak game', 'mascot viral'];
async function googleNews(q) {
  const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=en-US&gl=US&ceid=US:en`);
  return items(xml).slice(0, 10).map(it => ({ title: tag(it, 'title'), link: tag(it, 'link'), src: 'Google News' }));
}
async function newsSequential() {
  const out = [];
  for (const q of NEWS_QUERIES) { out.push(...await googleNews(q)); await new Promise(r => setTimeout(r, 1500)); }
  return out;
}
async function knowYourMeme() {
  const xml = await get('https://knowyourmeme.com/newsfeed.rss');
  return items(xml).slice(0, 15).map(it => ({ title: tag(it, 'title'), link: tag(it, 'link'), src: 'Know Your Meme' }));
}
async function bluesky() {
  const j = await get('https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrends', true);
  return (j?.trends || []).slice(0, 20).map(t => ({ title: t.displayName, src: 'Bluesky trending' }));
}
async function wikipedia() {
  const d = new Date(Date.now() - DAY);
  const p = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  const j = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${p}`, true);
  const arts = j?.items?.[0]?.articles || [];
  return arts.filter(a => !/^(Main_Page|Special:|Wikipedia:|Portal:|File:|Deaths_in|Cleopatra)/.test(a.article)).slice(0, 25)
    .map(a => ({ title: a.article.replace(/_/g, ' '), detail: `${a.views.toLocaleString()} Wikipedia views yesterday`, src: 'Wikipedia' }));
}

// ---------- crypto sources ----------
async function chainTrending(net) {
  const j = await get(`https://api.geckoterminal.com/api/v2/networks/${net}/trending_pools`, true);
  return (j?.data || []).slice(0, 5).map(p => {
    const a = p.attributes;
    return { name: a.name.split(' / ')[0], mc: +(a.market_cap_usd || a.fdv_usd), ch: +a.price_change_percentage?.h24, link: `https://www.geckoterminal.com/${net}/pools/${a.address}` };
  });
}
const CRYPTO_FEEDS = ['https://decrypt.co/feed', 'https://cointelegraph.com/rss', 'https://www.coindesk.com/arc/outboundfeeds/rss'];
const CRYPTO_WORDS = /meme|memecoin|pump\.?fun|solana|robinhood chain|hyperliquid|elysium|montra|launchpad|dogecoin|pepe|bonk|airdrop|new chain|mainnet/i;
async function cryptoNews() {
  const all = (await Promise.all(CRYPTO_FEEDS.map(u => get(u)))).flatMap(items)
    .map(it => ({ title: tag(it, 'title'), link: tag(it, 'link') }))
    .filter(n => CRYPTO_WORDS.test(n.title));
  return all;
}
async function geckoTrending() {
  const j = await get('https://api.coingecko.com/api/v3/search/trending', true);
  return (j?.coins || []).slice(0, 7).map(c => ({ name: `${c.item.name} ($${c.item.symbol})`, ch: c.item.data?.price_change_percentage_24h?.usd }));
}

// ---------- AI coin filter ----------
async function aiFilter(cands) {
  if (!cands.length) return [];
  const list = cands.map((c, i) => `${i}. [${c.src}] ${c.title}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
  const prompt = `You pick viral trends that could become a successful MEME COIN. Today is ${new Date().toUTCString()}.
What wins (from research on 2025-2026 meme coins): a CHARACTER, ANIMAL or OBJECT that normal people outside crypto know or are suddenly talking about; instantly recognisable, easy to draw simply, funny/cute/absurd/ironic; tied to a fresh attention wave (viral animal like Moo Deng or Fiona the hippo, an item shown in a GTA 6 trailer, a White House penguin post, an internet-relic face like Troll face, a self-aware joke like USELESS). The exact word people will search is the best ticker.
What loses: sports results and players, elections and politicians as plain news, deaths/tragedies/disasters, holidays everyone already knows, generic stock/finance news, celebrities with no meme angle, generic dog/cat with no hook. Never pick tragedies or real private people.

From the list below, return ONLY the items that are good coin ideas (usually 0-6). Merge duplicates of the same thing.
Return JSON array: [{"i": <index>, "topic": "short name", "ticker": "3-8 letters, no $", "score": 1-10, "why": "one plain-English line: what it is and why it could work"}]. Only include score 6 or higher.

${list}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '[]';
  try {
    return JSON.parse(txt).filter(x => x.score >= 6).map(x => ({ ...x, cand: cands[x.i] })).filter(x => x.cand);
  } catch { console.error('AI reply not JSON:', txt.slice(0, 300)); return []; }
}

// ---------- ticker check on the 3 chains ----------
async function tickerCheck(ticker, topic) {
  const out = {};
  const pairs = [];
  for (const q of [ticker, topic]) {
    const j = await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, true);
    pairs.push(...(j?.pairs || []));
  }
  const tk = ticker.toLowerCase(), tp = key(topic);
  for (const [id, label] of Object.entries(CHAINS)) {
    const hits = pairs.filter(p => p.chainId === id && (p.baseToken.symbol.toLowerCase().replace(/^\$/, '') === tk || key(p.baseToken.name) === tp));
    if (!hits.length) { out[label] = 'OPEN'; continue; }
    const live = hits.filter(p => (p.liquidity?.usd || 0) >= 1000 && (p.volume?.h24 || 0) >= 1000);
    if (!live.length) { out[label] = `DEAD ${hits.length} old cop${hits.length > 1 ? "ies" : "y"}`; continue; }
    const best = live.sort((a, b) => (b.marketCap || b.fdv || 0) - (a.marketCap || a.fdv || 0))[0];
    out[label] = `TAKEN ${money(best.marketCap || best.fdv)} live${live.length > 1 ? ` (${live.length} live copies)` : ""}`;
  }
  return out;
}

// ---------- Telegram ----------
async function send(text) {
  const { TELEGRAM_TOKEN: t, TELEGRAM_CHAT_ID: c } = process.env;
  if (!t || !c) { console.log('\n' + text.replace(/<[^>]+>/g, '') + '\n'); return; }
  // split under Telegram's 4096 limit, on blank lines
  const parts = []; let cur = '';
  for (const block of text.split('\n\n')) {
    if ((cur + block).length > 3900) { parts.push(cur); cur = ''; }
    cur += block + '\n\n';
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 15000));
      const r = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: c, text: p, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
      ok = r.ok;
      if (!ok) console.error('telegram error', r.status, await r.text());
    }
    if (!ok) return false;
  }
  return true;
}

// ---------- main ----------
async function main() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { seen: {}, alerted: {}, news: {} };
  const now = Date.now();
  for (const k of ['seen', 'alerted', 'news']) for (const [x, t] of Object.entries(state[k] || {})) if (now - t > 3 * DAY) delete state[k][x];
  state.seen ||= {}; state.alerted ||= {}; state.news ||= {};

  const viral = (await Promise.all([
    xTrends('united-states', 'US'), xTrends('united-kingdom', 'UK'),
    googleTrends('US'), googleTrends('GB'),
    newsSequential(), knowYourMeme(), bluesky(), wikipedia(),
  ])).flat().filter(c => c.title);

  // only things not seen in the last 3 days
  const fresh = []; const dup = new Set();
  for (const c of viral) { const k = key(c.title); if (!k || state.seen[k] || dup.has(k)) continue; dup.add(k); fresh.push(c); }
  console.error(`${viral.length} trends, ${fresh.length} new`);

  const picks = [];
  for (let i = 0; i < fresh.length; i += 150) picks.push(...await aiFilter(fresh.slice(i, i + 150)));
  for (const c of fresh) state.seen[key(c.title)] = now;

  const lines = [];
  const newPicks = picks.filter(p => !state.alerted[key(p.topic)]).sort((a, b) => b.score - a.score).slice(0, 8);
  for (const p of newPicks) {
    state.alerted[key(p.topic)] = now;
    const chk = await tickerCheck(p.ticker.replace(/^\$/, ''), p.topic);
    const chains = Object.entries(chk).map(([c, v]) => `${c}: ${v === 'OPEN' ? '✅ OPEN' : v.startsWith('DEAD') ? '🟡 ' + v : '⚠️ ' + v}`).join(' · ');
    const src = p.cand.link ? `<a href="${esc(p.cand.link)}">${esc(p.cand.src)}</a>` : esc(p.cand.src);
    lines.push(`${p.score >= 8 ? '🔥' : '👀'} <b>${p.score}/10  ${esc(p.topic)}  → $${esc(p.ticker.toUpperCase().replace(/^\$/, ''))}</b>\n${esc(p.why)}\nSource: ${src}\n${chains}`);
  }

  // crypto context
  const [sol, rh, ely, news, cg] = await Promise.all([chainTrending('solana'), chainTrending('robinhood'), chainTrending('elysium'), cryptoNews(), geckoTrending()]);
  const chainBlock = [['Solana', sol], ['Robinhood', rh], ['Elysium', ely]].map(([n, list]) =>
    `<b>${n}:</b> ` + (list.length ? list.map(x => `<a href="${x.link}">${esc(x.name)}</a> ${money(x.mc)} ${x.ch >= 0 ? '+' : ''}${Math.round(x.ch || 0)}%`).join(', ') : 'no data')).join('\n');
  const freshNews = news.filter(n => !state.news[key(n.title)]).slice(0, 5);
  for (const n of freshNews) state.news[key(n.title)] = now;

  const hour = new Date().toISOString().slice(11, 16);
  let msg = `<b>🛰 Trend Bot — ${hour} UTC</b>\n\n`;
  msg += lines.length ? `<b>COIN IDEAS (new viral things)</b>\n\n${lines.join('\n\n')}\n\n` : `No new coin-worthy trends this hour.\n\n`;
  msg += `<b>📈 Trending on chains</b>\n${chainBlock}\n\n`;
  if (cg.length) msg += `<b>🌍 CoinGecko trending:</b> ${cg.map(c => esc(c.name)).join(', ')}\n\n`;
  if (freshNews.length) msg += `<b>📰 Crypto news</b>\n${freshNews.map(n => `• <a href="${esc(n.link)}">${esc(n.title)}</a>`).join('\n')}`;

  // send if there is something new to say (always send ideas; chain block only every 4h if nothing else)
  const quiet = !lines.length && !freshNews.length && new Date().getUTCHours() % 4 !== 0;
  if (!quiet || process.argv.includes('--force')) {
    if (!await send(msg)) { console.error('Telegram failed - not saving, will retry next hour'); process.exit(1); }
  } else console.error('quiet hour, nothing sent');

  fs.mkdirSync(new URL('./state/', import.meta.url), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

main().catch(e => { console.error(e); process.exit(1); });
