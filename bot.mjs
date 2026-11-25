// Coin Trend Radar
// Every run (every ~5 min on GitHub Actions):
//  1. handles Telegram button presses (🎨 make art, 👍, 👎)
//  2. scans viral sources outside crypto, Gemini keeps only coin-worthy characters/animals/objects
//  3. sends each new idea with a picture, 3 tickers checked on Solana / Robinhood Chain / Elysium,
//     best chain, art idea, freshness, LATE warning. 9-10/10 = loud, others silent.
//  4. race watch: alerts when someone launches a coin for an idea you were sent
//  5. hourly chain digest, weekly scorecard; past hits + your ratings are fed back to the AI.
// No npm packages (Node 20+).
// Env: GEMINI_API_KEY (needed), TELEGRAM_TOKEN + TELEGRAM_CHAT_ID (optional: prints instead),
// YOUTUBE_API_KEY / REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET (optional).

import fs from 'node:fs';
import crypto from 'node:crypto';

const STATE_FILE = new URL('./state/seen.json', import.meta.url);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const CHAINS = { solana: 'SOL', robinhood: 'RH', elysium: 'ELY' };
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LOUD_SCORE = 9;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FORCE = process.argv.includes('--force');

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
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;|&#x27;/g, "'").trim();
const tag = (xml, t) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? decode(m[1]) : ''; };
const items = xml => (xml || '').split(/<item[\s>]/).slice(1);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const idOf = s => crypto.createHash('sha1').update(key(s)).digest('hex').slice(0, 10);
const money = n => !n ? '?' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`;
const ago = ms => ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} min` : ms < DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}d`;
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
    link: tag(it, 'ht:news_item_url'), image: tag(it, 'ht:picture'),
    started: Date.parse(tag(it, 'pubDate')) || 0, src: `Google Trends ${geo}`,
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
async function rotatingNews(now) {
  // 3 of the 9 searches per run, so all are covered every 3 runs (~15 min) without getting rate-limited
  const slot = Math.floor(now / (5 * MIN)) % 3;
  const qs = FORCE ? NEWS_QUERIES : NEWS_QUERIES.filter((_, i) => i % 3 === slot);
  const out = [];
  for (const q of qs) { out.push(...await bingNews(q)); await sleep(700); }
  return out.filter(n => !n.started || now - n.started < 2 * DAY);
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
  try { return JSON.parse(parts.map(p => p.text || '').join('')); } catch { return []; }
}

function learningNotes(state) {
  const ideas = Object.values(state.ideas);
  const hits = ideas.filter(i => i.bestMc >= 250000).sort((a, b) => b.bestMc - a.bestMc).slice(0, 10)
    .map(i => `${i.topic} (a coin hit ${money(i.bestMc)})`);
  const flops = ideas.filter(i => i.coins > 0 && (i.bestMc || 0) < 50000 && Date.now() - i.first > DAY).slice(-10).map(i => i.topic);
  const liked = state.feedback.filter(f => f.r === 'up').slice(-15).map(f => f.topic);
  const disliked = state.feedback.filter(f => f.r === 'dn').slice(-15).map(f => f.topic);
  let s = '';
  if (liked.length) s += `\nThe user LIKED these past ideas (find more like them): ${liked.join('; ')}`;
  if (disliked.length) s += `\nThe user DISLIKED these (avoid ideas like them): ${disliked.join('; ')}`;
  if (hits.length) s += `\nPast ideas where a real coin later ran (good signal): ${hits.join('; ')}`;
  if (flops.length) s += `\nPast ideas where coins were made but went nowhere: ${flops.join('; ')}`;
  return s;
}

async function aiFilter(cands, metas, state) {
  if (!cands.length) return [];
  const recent = Object.values(state.ideas).filter(i => Date.now() - i.first < 3 * DAY).map(i => i.topic);
  const list = cands.map((c, i) => `${i}. [${c.src}] ${c.title}${c.detail ? ' — ' + c.detail : ''}`).join('\n');
  const prompt = `You pick viral trends that could become a successful MEME COIN. Now: ${new Date().toUTCString()}.

WHAT WINS (2025-2026 research): a CHARACTER, ANIMAL or OBJECT that normal people OUTSIDE crypto know or are suddenly talking about; recognisable at thumbnail size; easy to draw simply; funny/cute/absurd/ironic; riding a FRESH attention wave (viral zoo animal like Moo Deng or Fiona the hippo; an item shown in a GTA 6 trailer; a White House penguin post; an internet-relic face like Troll face; a self-aware joke like USELESS). The exact word people will search is the best ticker. Being FIRST matters more than art.
WHAT LOSES: sports results/players, elections and politicians as plain news, deaths/tragedies/disasters/crime, holidays, stock/finance news, celebrities with no meme angle, generic dog/cat with no hook, things already old. Never pick tragedies, real private people or children.
${learningNotes(state)}
Already sent recently (do NOT return these again, even under another name): ${recent.join('; ') || 'none'}

CHAINS right now (what is trending on each):
${metas}
SOL = Solana/pump.fun: biggest crowd, fast news coins, rewards low-effort real photos and ultra-simple drawings.
RH = Robinhood Chain/Pons: US retail crowd, Robinhood/stock/finance lore and cats did well; past its peak.
ELY = Elysium/Montra: new Hyperliquid L2 (launched Nov 9 2026), early window, Hyperliquid lore (Hypurr cat, "Hype" prefix, slash-tickers) does well.

Score honestly: 9-10 only for something genuinely exploding right now with an obvious character and ticker. Most good ideas are 6-8.
From the list, return ONLY items that are good coin ideas (usually 0-5). Merge duplicates of the same thing.
Return a JSON array of:
{"i": index of the best source item, "topic": "short name", "tickers": ["BEST", "ALT1", "ALT2"] (3-8 letters, no $, exact search word first),
 "score": 1-10, "why": "one plain line: what it is and why it could work",
 "chain": "SOL|RH|ELY", "chain_why": "short reason",
 "art": "one line simple art idea (one character on a plain background, style)",
 "fresh": "rising|peaking|old"}
Only include score 6 or higher.

${list}`;
  const res = await geminiJSON(prompt);
  return (Array.isArray(res) ? res : []).filter(x => x.score >= 6 && cands[x.i])
    .map(x => ({ ...x, tickers: (x.tickers || []).map(t => String(t).replace(/^\$/, '').toUpperCase()).filter(Boolean).slice(0, 3), cand: cands[x.i] }));
}

// ---------- DexScreener ----------
const dexCache = {};
async function dexSearch(q) {
  if (!(q in dexCache)) dexCache[q] = (await get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, true))?.pairs || [];
  return dexCache[q];
}
const matches = (p, tickers, topic) => {
  const sym = p.baseToken.symbol.toLowerCase().replace(/^\$/, '');
  return tickers.some(t => t.toLowerCase() === sym) || key(p.baseToken.name) === key(topic);
};
async function tickerCheck(ticker, topic) {
  const pairs = [...await dexSearch(ticker), ...await dexSearch(topic)];
  const res = { line: [], late: null };
  for (const [id, label] of Object.entries(CHAINS)) {
    const hits = pairs.filter(p => p.chainId === id && matches(p, [ticker], topic));
    const seen = new Set(); const uniq = hits.filter(p => !seen.has(p.baseToken.address) && seen.add(p.baseToken.address));
    const live = uniq.filter(p => (p.liquidity?.usd || 0) >= 1000 && (p.volume?.h24 || 0) >= 1000);
    if (!uniq.length) res.line.push(`${label} ✅`);
    else if (!live.length) res.line.push(`${label} 🟡dead`);
    else {
      const best = live.sort((a, b) => (b.marketCap || b.fdv || 0) - (a.marketCap || a.fdv || 0))[0];
      const mc = best.marketCap || best.fdv || 0;
      const recent = best.pairCreatedAt && Date.now() - best.pairCreatedAt < 3 * DAY;
      res.line.push(`${label} ⚠️${money(mc)}${recent ? " new" : " old coin"}`);
      if (recent && mc >= 300000 && (!res.late || mc > res.late.mc)) res.late = { mc, chain: label, url: best.url, age: best.pairCreatedAt ? Date.now() - best.pairCreatedAt : 0 };
    }
  }
  return res;
}

// ---------- Telegram ----------
const CHAT = () => process.env.TELEGRAM_CHAT_ID;
const printMode = () => !process.env.TELEGRAM_TOKEN || !CHAT();
async function tg(method, body, isForm = false) {
  if (printMode()) { console.log(`\n[${method}]`, isForm ? '(file)' : JSON.stringify(body).slice(0, 1500)); return { ok: true, result: [] }; }
  for (let a = 0; a < 4; a++) {
    if (a) await sleep(10000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, isForm
        ? { method: 'POST', body }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      console.error('telegram', method, r.status, JSON.stringify(j).slice(0, 200));
      if (r.status === 400 || r.status === 403) return { ok: false, bad: true };
    } catch (e) { console.error('telegram', e.message); }
  }
  return null; // network/server failure
}
async function sendText(text, { loud = false } = {}) {
  if (printMode()) { console.log('\n' + text.replace(/<[^>]+>/g, '') + '\n'); return true; }
  const parts = []; let cur = '';
  for (const block of text.split('\n\n')) { if ((cur + block).length > 3900) { parts.push(cur); cur = ''; } cur += block + '\n\n'; }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) if (!(await tg('sendMessage', { chat_id: CHAT(), text: p, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: !loud }))?.ok) return false;
  return true;
}
const buttons = id => ({ inline_keyboard: [[{ text: '🎨 Make art', callback_data: `art:${id}` }, { text: '👍', callback_data: `up:${id}` }, { text: '👎', callback_data: `dn:${id}` }]] });
async function sendIdea(caption, image, id, loud) {
  if (printMode()) { console.log('\n[photo: ' + (image || 'none') + ']\n' + caption.replace(/<[^>]+>/g, '') + '\n'); return true; }
  const base = { chat_id: CHAT(), parse_mode: 'HTML', reply_markup: buttons(id), disable_notification: !loud };
  if (image) {
    const r = await tg('sendPhoto', { ...base, photo: image, caption: caption.slice(0, 1024) });
    if (r?.ok) return true;
    if (r === null) return false;
  }
  return !!(await tg('sendMessage', { ...base, text: caption, disable_web_page_preview: true }))?.ok;
}

// picture for an idea: source image, else Bing News search, else Wikipedia thumbnail
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
    } catch { /* no reference, fine */ }
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
    if (!idea) { await sendText('That idea is too old, sorry.'); continue; }
    if (act === 'up' || act === 'dn') {
      state.feedback = state.feedback.filter(f => f.id !== id);
      state.feedback.push({ id, topic: idea.topic, r: act, t: Date.now() });
      await sendText(act === 'up' ? `👍 Got it — more like <b>${esc(idea.topic)}</b>.` : `👎 Got it — fewer like <b>${esc(idea.topic)}</b>.`);
    } else if (act === 'art') {
      await sendText(`🎨 Making art for <b>$${esc(idea.tickers[0])}</b> (${esc(idea.topic)})… about 30 seconds.`);
      const art = await makeArt(idea);
      if (!art) { await sendText(`Couldn't make art for ${esc(idea.topic)} this time — press 🎨 again to retry.`); continue; }
      const fd = new FormData();
      fd.append('chat_id', CHAT());
      fd.append('caption', `$${idea.tickers[0]} — test art for ${idea.topic}. Press 🎨 again for another version.`);
      fd.append('reply_markup', JSON.stringify(buttons(id)));
      fd.append('photo', new Blob([art.buf], { type: art.mime }), 'art.png');
      await tg('sendPhoto', fd, true);
    }
  }
}

// ---------- 🚨 race watch + scorecard data ----------
async function raceWatch(state, now) {
  const alerts = [];
  const hourly = new Date(now).getUTCMinutes() < 5 || FORCE;
  for (const [id, idea] of Object.entries(state.ideas)) {
    const age = now - idea.first;
    if (age > 7 * DAY || (age > 2 * DAY && !hourly)) continue;
    const pairs = [];
    for (const q of [...new Set([idea.tickers[0], idea.topic])]) pairs.push(...await dexSearch(q));
    idea.seenPairs ||= []; idea.raceAlerts ||= 0;
    for (const p of pairs) {
      if (!CHAINS[p.chainId] || !matches(p, idea.tickers, idea.topic)) continue;
      const mc = p.marketCap || p.fdv || 0;
      const addr = p.baseToken.address;
      // track the best coin made AFTER the alert (for the scorecard)
      if (p.pairCreatedAt && p.pairCreatedAt > idea.first - 10 * MIN) {
        if (mc > (idea.bestMc || 0)) { idea.bestMc = mc; idea.bestUrl = p.url; idea.bestChain = CHAINS[p.chainId]; }
        if (!idea.seenPairs.includes(addr)) {
          idea.seenPairs.push(addr);
          idea.coins = (idea.coins || 0) + 1;
          if (age < 2 * DAY && (idea.raceAlerts || 0) < 3 && ++idea.raceAlerts) alerts.push(`🚨 <b>RACE: $${esc(p.baseToken.symbol)} launched on ${CHAINS[p.chainId]}</b> ${ago(now - p.pairCreatedAt)} ago — now ${money(mc)}, liquidity ${money(p.liquidity?.usd)}\nFor your idea: <b>${esc(idea.topic)}</b> · <a href="${esc(p.url)}">chart</a>`);
        }
      }
    }
  }
  return alerts;
}

async function weeklyScorecard(state, now) {
  const week = Object.values(state.ideas).filter(i => now - i.first < 7 * DAY);
  if (!week.length) return '';
  const withCoin = week.filter(i => i.coins > 0);
  const big = week.filter(i => i.bestMc >= 250000), huge = week.filter(i => i.bestMc >= 1e6);
  const bySrc = {};
  for (const i of week) { const s = (bySrc[i.src] ||= { n: 0, coin: 0, big: 0 }); s.n++; if (i.coins) s.coin++; if (i.bestMc >= 250000) s.big++; }
  const byScore = {};
  for (const i of week) { const b = i.score >= 9 ? '9-10' : i.score >= 8 ? '8' : i.score >= 7 ? '7' : '6'; const s = (byScore[b] ||= { n: 0, big: 0 }); s.n++; if (i.bestMc >= 250000) s.big++; }
  const top = week.filter(i => i.bestMc).sort((a, b) => b.bestMc - a.bestMc).slice(0, 5);
  const liked = state.feedback.filter(f => now - f.t < 7 * DAY);
  return `<b>📊 Weekly scorecard</b>
Ideas sent: ${week.length} · got a coin made: ${withCoin.length} · coin passed $250K: ${big.length} · passed $1M: ${huge.length}
👍 ${liked.filter(f => f.r === 'up').length} · 👎 ${liked.filter(f => f.r === 'dn').length}

<b>By source</b> (ideas / got coin / $250K+)
${Object.entries(bySrc).sort((a, b) => b[1].n - a[1].n).map(([s, v]) => `${esc(s)}: ${v.n} / ${v.coin} / ${v.big}`).join('\n')}

<b>By score</b> (ideas / $250K+)
${Object.entries(byScore).map(([s, v]) => `${s}/10: ${v.n} / ${v.big}`).join('\n')}

<b>Best coins made from your ideas</b>
${top.map(i => `• ${esc(i.topic)}: ${money(i.bestMc)} on ${i.bestChain} · <a href="${esc(i.bestUrl)}">chart</a>`).join('\n') || 'none yet'}`;
}

// ---------- main ----------
async function main() {
  const now = Date.now();
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  state.trends ||= {}; state.ideas ||= {}; state.news ||= {}; state.judged ||= {}; state.feedback ||= [];
  if (!Array.isArray(state.feedback)) state.feedback = [];
  for (const k of ['trends', 'news', 'judged']) for (const [x, v] of Object.entries(state[k])) if (now - (v.last || v.first || v) > 3 * DAY) delete state[k][x];
  for (const [x, v] of Object.entries(state.ideas)) if (now - v.first > 30 * DAY) delete state.ideas[x];
  state.feedback = state.feedback.slice(-200);
  const save = () => { fs.mkdirSync(new URL('./state/', import.meta.url), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state)); };

  // 1. buttons first, so art/ratings come back as fast as possible
  await handleButtons(state);
  save();

  // 2. scan
  const doWiki = FORCE || now - (state.lastWiki || 0) > HOUR;
  const viral = (await Promise.all([
    xTrends('united-states', 'US'), xTrends('united-kingdom', 'UK'),
    googleTrends('US'), googleTrends('GB'), rotatingNews(now), knowYourMeme(), bluesky(),
    doWiki ? wikipedia() : [], youtube(), reddit(),
  ])).flat().filter(c => c.title);
  if (doWiki) state.lastWiki = now;

  for (const c of viral) {
    const k = key(c.title); if (!k) continue;
    const t = state.trends[k] ||= { first: now, runs: 0, srcs: [], bestRank: 999 };
    if (t.last !== now) t.runs++;
    t.last = now;
    if (!t.srcs.includes(c.src)) t.srcs.push(c.src);
    if (c.rank) t.bestRank = Math.min(t.bestRank, c.rank);
  }
  const fresh = []; const dup = new Set();
  for (const c of viral) { const k = key(c.title); if (!k || state.judged[k] || dup.has(k)) continue; dup.add(k); fresh.push(c); }
  console.error(`${viral.length} trend items, ${fresh.length} new to judge`);

  const [sol, rh, ely] = await Promise.all([chainTrending('solana'), chainTrending('robinhood'), chainTrending('elysium')]);
  const metas = [['SOL', sol], ['RH', rh], ['ELY', ely]].map(([n, l]) => `${n}: ${l.map(x => `${x.name} ${money(x.mc)} ${Math.round(x.ch || 0)}%`).join(', ')}`).join('\n');

  const picks = [];
  for (let i = 0; i < fresh.length; i += 150) picks.push(...await aiFilter(fresh.slice(i, i + 150), metas, state));

  // 3. send new ideas
  let failed = false;
  const newPicks = picks.filter(p => !state.ideas[idOf(p.topic)]).sort((a, b) => b.score - a.score).slice(0, 6);
  for (const p of newPicks) {
    const id = idOf(p.topic);
    const tr = state.trends[key(p.cand.title)] || {};
    const checks = [];
    for (const t of p.tickers) checks.push([t, await tickerCheck(t, p.topic)]);
    const late = checks.map(c => c[1].late).filter(Boolean).sort((a, b) => b.mc - a.mc)[0];
    const firstSeen = Math.min(tr.first || now, p.cand.started || now);
    let badge = p.fresh === 'rising' ? '🚀 RISING' : p.fresh === 'peaking' ? '⏳ PEAKING' : '🐢 OLD';
    if (late) badge = '⚠️ LATE';
    const loud = p.score >= LOUD_SCORE && !late;
    const icon = late ? '⚠️' : loud ? '🚨' : p.score >= 8 ? '🔥' : '👀';
    const src = p.cand.link ? `<a href="${esc(p.cand.link)}">${esc(p.cand.src)}</a>` : esc(p.cand.src);
    let cap = `${icon} <b>${p.score}/10 ${esc(p.topic)}</b>  ${badge}\n${esc(p.why)}\n\n`;
    cap += `<b>Tickers:</b>\n${checks.map(([t, c]) => `$${esc(t)}  ${c.line.join(' ')}`).join('\n')}\n`;
    cap += `<b>Best chain:</b> ${esc(p.chain)} — ${esc(p.chain_why)}\n`;
    cap += `<b>Art:</b> ${esc(p.art)}\n`;
    if (late) cap += `<b>Late:</b> a coin for this is already ${money(late.mc)} on ${late.chain}${late.age ? `, made ${ago(late.age)} ago` : ''} — <a href="${esc(late.url)}">chart</a>\n`;
    cap += `\n${src} · first seen ${ago(now - firstSeen)} ago · in ${(tr.srcs || [p.cand.src]).length} source(s)`;
    const image = await findImage(p.topic, p.cand);
    state.ideas[id] = { first: now, topic: p.topic, tickers: p.tickers, art: p.art, why: p.why, score: p.score, src: p.cand.src, image, srcs: (tr.srcs || []).length };
    if (!await sendIdea(cap, image, id, loud)) { delete state.ideas[id]; failed = true; break; }
    save();
  }

  // spreading: an idea already sent has reached more places
  if (!failed) for (const [id, idea] of Object.entries(state.ideas)) {
    if (idea.rerun || now - idea.first > DAY) continue;
    const words = [key(idea.topic), ...idea.tickers.map(key)].filter(w => w.length >= 4);
    const srcs = new Set(viral.filter(c => words.some(w => key(c.title).includes(w))).map(c => c.src));
    if (srcs.size >= Math.max(3, (idea.srcs || 1) + 2)) {
      if (await sendText(`📣 <b>STILL SPREADING: ${esc(idea.topic)}</b>\nNow in ${srcs.size} places: ${esc([...srcs].join(', '))}\nTickers: ${idea.tickers.map(t => '$' + esc(t)).join(' ')}`, { loud: true })) idea.rerun = true;
    }
  }

  // 4. race watch
  if (!failed) {
    const alerts = await raceWatch(state, now);
    for (const a of alerts) if (!await sendText(a, { loud: true })) { failed = true; break; }
  }

  // 5. hourly digest (chains + crypto news), weekly scorecard
  if (!failed && (FORCE || now - (state.lastDigest || 0) > 55 * MIN)) {
    const [news, cg] = await Promise.all([cryptoNews(), geckoTrending()]);
    const freshNews = news.filter(n => !state.news[key(n.title)]).slice(0, 5);
    if (freshNews.length || now - (state.lastDigest || 0) > 4 * HOUR || FORCE) {
      let digest = `<b>📈 Trending on chains — ${new Date(now).toISOString().slice(11, 16)} UTC</b>\n` +
        [['Solana', sol], ['Robinhood', rh], ['Elysium', ely]].map(([n, l]) => `<b>${n}:</b> ` + (l.length ? l.slice(0, 5).map(x => `<a href="${x.link}">${esc(x.name)}</a> ${money(x.mc)} ${x.ch >= 0 ? '+' : ''}${Math.round(x.ch || 0)}%`).join(', ') : 'no data')).join('\n');
      if (cg.length) digest += `\n\n<b>🌍 CoinGecko trending:</b> ${cg.map(esc).join(', ')}`;
      if (freshNews.length) digest += `\n\n<b>📰 Crypto news</b>\n${freshNews.map(n => `• <a href="${esc(n.link)}">${esc(n.title)}</a>`).join('\n')}`;
      if (await sendText(digest)) { freshNews.forEach(n => state.news[key(n.title)] = now); state.lastDigest = now; } else failed = true;
    }
  }
  if (!failed && now - (state.lastScorecard || now) > 7 * DAY) {
    const sc = await weeklyScorecard(state, now);
    if (!sc || await sendText(sc, { loud: true })) state.lastScorecard = now;
  }
  state.lastScorecard ||= now;

  if (!failed) for (const c of fresh) state.judged[key(c.title)] = now;
  save();
  if (failed) { console.error('Telegram failed - will retry next run'); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
