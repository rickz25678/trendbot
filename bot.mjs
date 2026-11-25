// Coin Trend Radar: finds viral characters/animals/objects that could work as meme coins,
// tracks whether each trend is still rising, gives coin advice (tickers, chain, art idea),
// checks if tickers are open on Solana / Robinhood Chain / Elysium, and sends each idea
// to Telegram with a picture. No npm packages (Node 20+).
//
// Env: GEMINI_API_KEY (needed), TELEGRAM_TOKEN + TELEGRAM_CHAT_ID (optional: prints instead),
// YOUTUBE_API_KEY (optional), REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (optional).

import fs from 'node:fs';

const STATE_FILE = new URL('./state/seen.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const CHAINS = { solana: 'SOL', robinhood: 'RH', elysium: 'ELY' };
const HOUR = 3600000, DAY = 24 * HOUR;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- helpers ----------
async function get(url, asJson = false, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status);
    return asJson ? await r.json() : await r.text();
  } catch (e) {
    console.error('skip', url.replace(/key=[^&]+/, 'key=***'), e.message);
    return null;
  }
}
const decode = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };
const items = xml => (xml || '').split(/<item[\s>]/).slice(1);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const money = n => !n ? '?' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
const ago = ms => ms < HOUR ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}d`;
const bingImg = u => u ? decode(u).replace(/^http:/, 'https:') + '&w=800' : '';

// ---------- viral sources (outside crypto) ----------
async function xTrends(region, label) {
  const html = await get(`https://trends24.in/${region}/`);
  if (html) {
    const firstCard = html.split('trend-card__list')[1] || html; // latest hour only
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
    link: tag(it, 'ht:news_item_url'),
    image: tag(it, 'ht:picture'),
    started: Date.parse(tag(it, 'pubDate')) || 0,
    src: `Google Trends ${geo}`,
  }));
}
const NEWS_QUERIES = ['viral animal', 'zoo baby animal', 'goes viral', 'viral meme', 'viral tiktok', 'viral video', 'game trailer leak', 'mascot viral', 'internet obsessed'];
async function bingNews(q) {
  const xml = await get(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&qft=interval%3d%227%22&format=rss`);
  return items(xml).slice(0, 10).map(it => ({
    title: tag(it, 'title'), detail: tag(it, 'description').slice(0, 200),
    link: tag(it, 'link'), image: bingImg(tag(it, 'News:Image')),
    started: Date.parse(tag(it, 'pubDate')) || 0, src: 'News',
  }));
}
async function allNews() {
  const out = [];
  for (const q of NEWS_QUERIES) { out.push(...await bingNews(q)); await sleep(800); }
  return out.filter(n => !n.started || Date.now() - n.started < 2 * DAY);
}
async function knowYourMeme() {
  const xml = await get('https://knowyourmeme.com/newsfeed.rss');
  return items(xml).slice(0, 15).map(it => {
    const desc = tag(it, 'description');
    const img = (desc.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    return { title: tag(it, 'title'), detail: decode(desc.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').slice(0, 250), link: tag(it, 'link'), image: img || '', started: Date.parse(tag(it, 'pubDate')) || 0, src: 'Know Your Meme' };
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
async function youtube() {
  const k = process.env.YOUTUBE_API_KEY; if (!k) return [];
  const out = [];
  for (const region of ['US', 'GB']) {
    const j = await get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&maxResults=25&regionCode=${region}&key=${k}`, true);
    for (const v of j?.items || []) out.push({
      title: v.snippet.title, detail: `${(+v.statistics.viewCount).toLocaleString()} views, channel ${v.snippet.channelTitle}`,
      link: `https://youtu.be/${v.id}`, image: v.snippet.thumbnails?.high?.url || '', started: Date.parse(v.snippet.publishedAt) || 0, src: `YouTube trending ${region}`,
    });
  }
  return out;
}
const SUBREDDITS = ['aww', 'AnimalsBeingDerps', 'Damnthatsinteresting', 'memes', 'OutOfTheLoop', 'GamingLeaksAndRumours', 'nextfuckinglevel', 'interestingasfuck', 'BrandNewSentence'];
async function reddit() {
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: sec } = process.env; if (!id || !sec) return [];
  try {
    const t = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST', body: 'grant_type=client_credentials',
      headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'coin-trend-radar/1.0' },
    }).then(r => r.json());
    const out = [];
    for (const sub of SUBREDDITS) {
      const j = await get(`https://oauth.reddit.com/r/${sub}/rising?limit=8`, true, { Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'coin-trend-radar/1.0' });
      for (const c of j?.data?.children || []) {
        const p = c.data; if (p.over_18) continue;
        const img = p.preview?.images?.[0]?.source?.url;
        out.push({ title: p.title, detail: `r/${sub}, ${p.ups} upvotes`, link: `https://reddit.com${p.permalink}`, image: img ? decode(img) : '', started: p.created_utc * 1000, src: `Reddit r/${sub}` });
      }
    }
    return out;
  } catch (e) { console.error('reddit', e.message); return []; }
}

// ---------- crypto sources ----------
async function chainTrending(net) {
  const j = await get(`https://api.geckoterminal.com/api/v2/networks/${net}/trending_pools`, true);
  return (j?.data || []).slice(0, 6).map(p => {
    const a = p.attributes;
    return { name: a.name.split(' / ')[0], mc: +(a.market_cap_usd || a.fdv_usd), ch: +a.price_change_percentage?.h24, link: `https://www.geckoterminal.com/${net}/pools/${a.address}` };
  });
}
const CRYPTO_FEEDS = ['https://decrypt.co/feed', 'https://cointelegraph.com/rss', 'https://www.coindesk.com/arc/outboundfeeds/rss'];
const CRYPTO_WORDS = /meme|memecoin|pump\.?fun|solana|robinhood chain|hyperliquid|elysium|montra|launchpad|dogecoin|pepe|bonk|new chain|mainnet/i;
async function cryptoNews() {
  return (await Promise.all(CRYPTO_FEEDS.map(u => get(u)))).flatMap(items)
    .map(it => ({ title: tag(it, 'title'), link: tag(it, 'link') }))
    .filter(n => CRYPTO_WORDS.test(n.title));
}
async function geckoTrending() {
  const j = await get('https://api.coingecko.com/api/v3/search/trending', true);
  return (j?.coins || []).slice(0, 7).map(c => `${c.item.name} ($${c.item.symbol})`);
}

// ---------- AI coin advice ----------
async function gemini(prompt) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } }),
        signal: AbortSignal.timeout(150000),
      });
      const j = await r.json();
      const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
      if (txt) return JSON.parse(txt);
      console.error('gemini empty', JSON.stringify(j).slice(0, 200));
    } catch (e) { console.error('gemini', e.message); }
    await sleep(5000);
  }
  return [];
}
async function aiFilter(cands, metas) {
  if (!cands.length) return [];
  const list = cands.map((c, i) => `${i}. [${c.src}] ${c.title}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
  const prompt = `You pick viral trends that could become a successful MEME COIN. Now: ${new Date().toUTCString()}.

WHAT WINS (2025-2026 research): a CHARACTER, ANIMAL or OBJECT that normal people OUTSIDE crypto know or are suddenly talking about; recognisable at thumbnail size; easy to draw simply; funny/cute/absurd/ironic; riding a FRESH attention wave (viral zoo animal like Moo Deng or Fiona the hippo; an item shown in a GTA 6 trailer; a White House penguin post; an internet-relic face like Troll face; a self-aware joke like USELESS). The exact word people will search is the best ticker. Being FIRST matters more than art.
WHAT LOSES: sports results/players, elections and politicians as plain news, deaths/tragedies/disasters/crime, holidays, stock/finance news, celebrities with no meme angle, generic dog/cat with no hook, things already old. Never pick tragedies, real private people or children.

CHAINS right now (what is trending on each):
${metas}
SOL = Solana/pump.fun: biggest crowd, fast news coins, rewards low-effort real photos and ultra-simple drawings.
RH = Robinhood Chain/Pons: US retail crowd, Robinhood/stock/finance lore and cats did well; past its peak.
ELY = Elysium/Montra: new Hyperliquid L2 (launched Nov 9 2026), early window, Hyperliquid lore (Hypurr cat, "Hype" prefix, slash-tickers) does well.

From the list, return ONLY items that are good coin ideas (usually 0-6). Merge duplicates of the same thing.
Return a JSON array of:
{"i": index of the best source item, "topic": "short name", "tickers": ["BEST", "ALT1", "ALT2"] (3-8 letters, no $, exact search word first),
 "score": 1-10, "why": "one plain line: what it is and why it could work",
 "chain": "SOL|RH|ELY", "chain_why": "short reason",
 "art": "one line simple art idea (character on plain background, style)",
 "fresh": "rising|peaking|old" (your guess from the source and time)}
Only include score 6 or higher.

${list}`;
  const res = await gemini(prompt);
  return (Array.isArray(res) ? res : []).filter(x => x.score >= 6 && cands[x.i])
    .map(x => ({ ...x, tickers: (x.tickers || []).map(t => String(t).replace(/^\$/, '').toUpperCase()).filter(Boolean).slice(0, 3), cand: cands[x.i] }));
}

// ---------- ticker check on the 3 chains ----------
const dexCache = {};
async function dexSearch(q) {
  if (!(q in dexCache)) dexCache[q] = (await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, true))?.pairs || [];
  return dexCache[q];
}
async function tickerCheck(ticker, topic) {
  const pairs = [...await dexSearch(ticker), ...await dexSearch(topic)];
  const tk = ticker.toLowerCase(), tp = key(topic);
  const res = { line: [], late: null };
  for (const [id, label] of Object.entries(CHAINS)) {
    const hits = pairs.filter(p => p.chainId === id && (p.baseToken.symbol.toLowerCase().replace(/^\$/, '') === tk || key(p.baseToken.name) === tp));
    const seen = new Set(); const uniq = hits.filter(p => !seen.has(p.baseToken.address) && seen.add(p.baseToken.address));
    const live = uniq.filter(p => (p.liquidity?.usd || 0) >= 1000 && (p.volume?.h24 || 0) >= 1000);
    if (!uniq.length) res.line.push(`${label} ✅`);
    else if (!live.length) res.line.push(`${label} 🟡dead`);
    else {
      const best = live.sort((a, b) => (b.marketCap || b.fdv || 0) - (a.marketCap || a.fdv || 0))[0];
      const mc = best.marketCap || best.fdv || 0;
      res.line.push(`${label} ⚠️${money(mc)}`);
      if (mc >= 300000 && (!res.late || mc > res.late.mc)) res.late = { mc, chain: label, url: best.url, age: best.pairCreatedAt ? Date.now() - best.pairCreatedAt : 0 };
    }
  }
  return res;
}

// ---------- Telegram ----------
async function tg(method, body) {
  const { TELEGRAM_TOKEN: t } = process.env;
  for (let a = 0; a < 4; a++) {
    if (a) await sleep(15000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return true;
      const txt = await r.text();
      console.error('telegram', method, r.status, txt.slice(0, 200));
      if (r.status === 400) return false; // bad photo etc. - no point retrying
    } catch (e) { console.error('telegram', e.message); }
  }
  return null; // network/server failure
}
const printMode = () => !process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID;
async function sendText(text) {
  if (printMode()) { console.log('\n' + text.replace(/<[^>]+>/g, '') + '\n'); return true; }
  const parts = []; let cur = '';
  for (const block of text.split('\n\n')) { if ((cur + block).length > 3900) { parts.push(cur); cur = ''; } cur += block + '\n\n'; }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) if (!await tg('sendMessage', { chat_id: process.env.TELEGRAM_CHAT_ID, text: p, parse_mode: 'HTML', disable_web_page_preview: true })) return false;
  return true;
}
async function sendIdea(caption, image) {
  if (printMode()) { console.log('\n[photo: ' + (image || 'none') + ']\n' + caption.replace(/<[^>]+>/g, '') + '\n'); return true; }
  if (image) {
    const ok = await tg('sendPhoto', { chat_id: process.env.TELEGRAM_CHAT_ID, photo: image, caption: caption.slice(0, 1024), parse_mode: 'HTML' });
    if (ok) return true;
    if (ok === null) return false;
  }
  return sendText(caption);
}

// picture for an idea: source image, else Bing News search, else Wikipedia thumbnail
async function findImage(idea) {
  if (idea.cand.image) return idea.cand.image;
  const n = [...await bingNews(idea.topic), ...await bingNews(idea.cand.title.slice(0, 80))];
  const withImg = n.find(x => x.image);
  if (withImg) return withImg.image;
  const w = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(idea.topic.replace(/ /g, '_'))}`, true);
  return w?.thumbnail?.source || '';
}

// ---------- main ----------
async function main() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const now = Date.now();
  state.trends ||= {}; state.ideas ||= {}; state.news ||= {}; state.judged ||= {};
  for (const k of ['trends', 'ideas', 'news', 'judged']) for (const [x, v] of Object.entries(state[k])) if (now - (v.last || v.first || v) > 3 * DAY) delete state[k][x];

  const viral = (await Promise.all([
    xTrends('united-states', 'US'), xTrends('united-kingdom', 'UK'),
    googleTrends('US'), googleTrends('GB'), allNews(), knowYourMeme(), bluesky(), wikipedia(), youtube(), reddit(),
  ])).flat().filter(c => c.title);

  // momentum tracking: how many runs/sources has each trend shown up in
  for (const c of viral) {
    const k = key(c.title); if (!k) continue;
    const t = state.trends[k] ||= { first: now, runs: 0, srcs: [], bestRank: 999 };
    if (t.last !== now) t.runs++;
    t.last = now;
    if (!t.srcs.includes(c.src)) t.srcs.push(c.src);
    if (c.rank) t.bestRank = Math.min(t.bestRank, c.rank);
  }

  // AI only judges trends it hasn't judged before
  const fresh = []; const dup = new Set();
  for (const c of viral) { const k = key(c.title); if (!k || state.judged[k] || dup.has(k)) continue; dup.add(k); fresh.push(c); }
  console.error(`${viral.length} trend items, ${fresh.length} new to judge`);

  const [sol, rh, ely, news, cg] = await Promise.all([chainTrending('solana'), chainTrending('robinhood'), chainTrending('elysium'), cryptoNews(), geckoTrending()]);
  const metas = [['SOL', sol], ['RH', rh], ['ELY', ely]].map(([n, l]) => `${n}: ${l.map(x => `${x.name} ${money(x.mc)} ${Math.round(x.ch || 0)}%`).join(', ')}`).join('\n');

  const picks = [];
  for (let i = 0; i < fresh.length; i += 150) picks.push(...await aiFilter(fresh.slice(i, i + 150), metas));

  // spreading check for ideas already sent: has the trend reached more places since?
  const spreading = [];
  for (const [k, idea] of Object.entries(state.ideas)) {
    if (idea.rerun || now - idea.first > DAY) continue;
    const words = [key(idea.topic), ...idea.tickers.map(key)].filter(w => w.length >= 4);
    const srcs = new Set(viral.filter(c => words.some(w => key(c.title).includes(w))).map(c => c.src));
    if (srcs.size >= Math.max(3, idea.srcs + 2)) spreading.push({ k, idea, srcs: [...srcs] });
  }

  const outbox = [];
  const newPicks = picks.filter(p => !state.ideas[key(p.topic)]).sort((a, b) => b.score - a.score).slice(0, 8);
  for (const p of newPicks) {
    const tk = key(p.cand.title); const tr = state.trends[tk] || {};
    const checks = [];
    for (const t of p.tickers) checks.push([t, await tickerCheck(t, p.topic)]);
    const late = checks.map(c => c[1].late).filter(Boolean).sort((a, b) => b.mc - a.mc)[0];
    const firstSeen = Math.min(tr.first || now, p.cand.started || now);
    let badge = p.fresh === 'rising' ? '🚀 RISING' : p.fresh === 'peaking' ? '⏳ PEAKING' : '🐢 OLD';
    if (late) badge = '⚠️ LATE';
    const icon = late ? '⚠️' : p.score >= 8 ? '🔥' : '👀';
    const src = p.cand.link ? `<a href="${esc(p.cand.link)}">${esc(p.cand.src)}</a>` : esc(p.cand.src);
    let cap = `${icon} <b>${p.score}/10 ${esc(p.topic)}</b>  ${badge}\n${esc(p.why)}\n\n`;
    cap += `<b>Tickers:</b>\n${checks.map(([t, c]) => `$${esc(t)}  ${c.line.join(' ')}`).join('\n')}\n`;
    cap += `<b>Best chain:</b> ${esc(p.chain)} — ${esc(p.chain_why)}\n`;
    cap += `<b>Art:</b> ${esc(p.art)}\n`;
    if (late) cap += `<b>Late warning:</b> a coin for this is already ${money(late.mc)} on ${late.chain}${late.age ? `, made ${ago(late.age)} ago` : ''} — <a href="${esc(late.url)}">chart</a>\n`;
    cap += `\n${src} · first seen ${ago(now - firstSeen)} ago · in ${(tr.srcs || [p.cand.src]).length} source(s)`;
    outbox.push({ cap, image: await findImage(p), save: () => { state.ideas[key(p.topic)] = { first: now, last: now, topic: p.topic, tickers: p.tickers, srcs: (tr.srcs || []).length }; } });
  }
  for (const s of spreading) {
    const cap = `📣 <b>STILL SPREADING: ${esc(s.idea.topic)}</b>\nNow in ${s.srcs.length} places: ${esc(s.srcs.join(', '))}\nTickers: ${s.idea.tickers.map(t => '$' + esc(t)).join(' ')} — check if still open.`;
    outbox.push({ cap, image: '', save: () => { state.ideas[s.k].rerun = true; state.ideas[s.k].last = now; } });
  }

  const freshNews = news.filter(n => !state.news[key(n.title)]).slice(0, 5);
  const showChains = outbox.length || freshNews.length || new Date().getUTCHours() % 4 === 0 || process.argv.includes('--force');
  let digest = '';
  if (showChains) {
    digest = `<b>📈 Trending on chains — ${new Date().toISOString().slice(11, 16)} UTC</b>\n` +
      [['Solana', sol], ['Robinhood', rh], ['Elysium', ely]].map(([n, l]) => `<b>${n}:</b> ` + (l.length ? l.slice(0, 5).map(x => `<a href="${x.link}">${esc(x.name)}</a> ${money(x.mc)} ${x.ch >= 0 ? '+' : ''}${Math.round(x.ch || 0)}%`).join(', ') : 'no data')).join('\n');
    if (cg.length) digest += `\n\n<b>🌍 CoinGecko trending:</b> ${cg.map(esc).join(', ')}`;
    if (freshNews.length) digest += `\n\n<b>📰 Crypto news</b>\n${freshNews.map(n => `• <a href="${esc(n.link)}">${esc(n.title)}</a>`).join('\n')}`;
  }

  // send; on network failure stop without saving so nothing is lost
  let failed = false;
  if (!outbox.length && showChains) await sendText('🛰 No new coin-worthy trends this time.');
  for (const m of outbox) { if (await sendIdea(m.cap, m.image)) m.save(); else { failed = true; break; } }
  if (!failed && digest) { if (await sendText(digest)) freshNews.forEach(n => state.news[key(n.title)] = now); else failed = true; }
  if (!failed) for (const c of fresh) state.judged[key(c.title)] = now;

  fs.mkdirSync(new URL('./state/', import.meta.url), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  if (failed) { console.error('Telegram failed - will retry next run'); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
