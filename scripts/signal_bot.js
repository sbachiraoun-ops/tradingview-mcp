#!/usr/bin/env node
/**
 * signal_bot — pushes live TradingView chart signals to your phone via Telegram.
 *
 * It reuses the same CDP layer as the MCP server (src/core), so it reads YOUR
 * actual chart: real-time quote, indicator readings (RSI, etc.) and the
 * horizontal price levels your custom Pine indicators draw with line.new().
 *
 * ── Quick start ────────────────────────────────────────────────────────────
 *   1. Talk to @BotFather on Telegram → /newbot → copy the token.
 *   2. Open your new bot in Telegram and tap "Start" (send any message).
 *   3. Run, from the repo root, on the machine where TradingView is open:
 *        TELEGRAM_BOT_TOKEN=123:abc node scripts/signal_bot.js
 *      (or `npm run signals` after exporting the token)
 *
 * The chat id is auto-detected from your "Start" message — no need to find it
 * manually. Set TELEGRAM_CHAT_ID yourself to override or to broadcast to a group.
 *
 * ── Config (environment variables) ─────────────────────────────────────────
 *   TELEGRAM_BOT_TOKEN   (required)  bot token from @BotFather
 *   TELEGRAM_CHAT_ID     (optional)  override auto-detected chat id
 *   SIGNAL_INTERVAL_MS   (optional)  poll cadence, default 60000 (60s)
 *   SIGNAL_RSI_OB        (optional)  RSI overbought threshold, default 70
 *   SIGNAL_RSI_OS        (optional)  RSI oversold threshold, default 30
 *   SIGNAL_MOVE_PCT      (optional)  % move vs last poll that fires an alert, default 0.5
 *   SIGNAL_LEVEL_PCT     (optional)  proximity (% of price) to a Pine level that fires, default 0.05
 *   SIGNAL_COOLDOWN_MS   (optional)  min gap before re-firing the same signal, default 900000 (15m)
 *   SIGNAL_HEARTBEAT     (optional)  set to "1" to send a snapshot every poll (debug)
 *
 * Edit evaluateSignals() below to plug in your own rules.
 */

import { data, health } from '../src/core/index.js';

// ── Config ──────────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const INTERVAL_MS = int(process.env.SIGNAL_INTERVAL_MS, 60_000);
const RSI_OB = num(process.env.SIGNAL_RSI_OB, 70);
const RSI_OS = num(process.env.SIGNAL_RSI_OS, 30);
const MOVE_PCT = num(process.env.SIGNAL_MOVE_PCT, 0.5);
const LEVEL_PCT = num(process.env.SIGNAL_LEVEL_PCT, 0.05);
const COOLDOWN_MS = int(process.env.SIGNAL_COOLDOWN_MS, 15 * 60_000);
const HEARTBEAT = process.env.SIGNAL_HEARTBEAT === '1';

let chatId = process.env.TELEGRAM_CHAT_ID || null;
const lastFired = new Map();   // signal key -> timestamp (cooldown)
let prevClose = null;          // last poll's close, for move detection

// ── Telegram I/O ──────────────────────────────────────────────────────────────
async function tg(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description || res.status}`);
  return body.result;
}

async function send(text) {
  if (!chatId) { console.error('[signals] no chat id yet — skipping send'); return; }
  try {
    await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error('[signals] send error:', e.message);
  }
}

/** Find the chat id from the most recent person who messaged the bot. */
async function resolveChatId() {
  if (chatId) return chatId;
  const updates = await tg('getUpdates', { offset: -1, timeout: 0 }).catch(() => []);
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].message || updates[i].channel_post;
    if (msg?.chat?.id) { chatId = String(msg.chat.id); return chatId; }
  }
  return null;
}

// ── Signal engine ─────────────────────────────────────────────────────────────
// Edit this function to define your own signals. Each entry: { key, text }.
// `key` controls de-duplication / cooldown; `text` is the Telegram message.
function evaluateSignals(snap) {
  const out = [];
  const { symbol, price, rsi, levels } = snap;
  if (price == null) return out;

  // 1. RSI overbought / oversold
  if (rsi != null) {
    if (rsi >= RSI_OB) out.push({ key: 'rsi-ob', text: `🔴 <b>${symbol}</b> RSI overbought: <b>${rsi.toFixed(1)}</b> @ ${fmt(price)}` });
    else if (rsi <= RSI_OS) out.push({ key: 'rsi-os', text: `🟢 <b>${symbol}</b> RSI oversold: <b>${rsi.toFixed(1)}</b> @ ${fmt(price)}` });
  }

  // 2. Price hugging a level drawn by a Pine indicator (support/resistance test)
  for (const lvl of levels) {
    const distPct = Math.abs(price - lvl.value) / price * 100;
    if (distPct <= LEVEL_PCT) {
      out.push({ key: `lvl-${lvl.value}`, text: `🎯 <b>${symbol}</b> testing level <b>${fmt(lvl.value)}</b> (${lvl.study}) — price ${fmt(price)}` });
    }
  }

  // 3. Sharp move since the previous poll
  if (prevClose != null && prevClose !== 0) {
    const movePct = (price - prevClose) / prevClose * 100;
    if (Math.abs(movePct) >= MOVE_PCT) {
      const arrow = movePct > 0 ? '📈' : '📉';
      out.push({ key: `move-${Math.sign(movePct)}`, text: `${arrow} <b>${symbol}</b> moved <b>${movePct.toFixed(2)}%</b> → ${fmt(price)}` });
    }
  }

  return out;
}

// ── Snapshot: read the live chart through the CDP core ────────────────────────
async function snapshot() {
  const quote = await data.getQuote();
  const symbol = quote.symbol || 'chart';
  const price = quote.last ?? quote.close ?? null;

  // RSI from any visible "Relative Strength Index" study
  let rsi = null;
  try {
    const sv = await data.getStudyValues();
    for (const study of sv.studies || []) {
      if (!/relative strength|rsi/i.test(study.name)) continue;
      for (const [title, val] of Object.entries(study.values || {})) {
        if (/rsi/i.test(title) || /relative strength|rsi/i.test(study.name)) {
          const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
          if (Number.isFinite(n)) { rsi = n; break; }
        }
      }
      if (rsi != null) break;
    }
  } catch { /* studies optional */ }

  // Horizontal levels drawn by custom Pine indicators
  const levels = [];
  try {
    const pl = await data.getPineLines();
    for (const study of pl.studies || []) {
      for (const lvl of study.horizontal_levels || []) levels.push({ value: lvl, study: study.name });
    }
  } catch { /* pine optional */ }

  return { symbol, price, rsi, levels };
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
async function poll() {
  let snap;
  try {
    snap = await snapshot();
  } catch (e) {
    console.error('[signals] chart read failed:', e.message);
    return;
  }

  if (HEARTBEAT) {
    await send(`🫀 <b>${snap.symbol}</b> ${fmt(snap.price)}${snap.rsi != null ? ` · RSI ${snap.rsi.toFixed(1)}` : ''} · ${snap.levels.length} levels`);
  }

  const now = Date.now();
  for (const sig of evaluateSignals(snap)) {
    const last = lastFired.get(sig.key) || 0;
    if (now - last < COOLDOWN_MS) continue;
    lastFired.set(sig.key, now);
    console.error(`[signals] fire ${sig.key}`);
    await send(sig.text);
  }

  prevClose = snap.price;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN) {
    console.error('ERROR: set TELEGRAM_BOT_TOKEN (get one from @BotFather on Telegram).');
    process.exit(1);
  }

  // Confirm the bridge to TradingView is alive before we promise the user signals.
  try {
    const h = await health.healthCheck();
    if (!h.api_available) console.error('[signals] WARNING: TradingView API not ready — is a chart open?');
    console.error(`[signals] connected to TradingView · ${h.chart_symbol} ${h.chart_resolution}`);
  } catch (e) {
    console.error(`[signals] cannot reach TradingView on CDP (localhost:9222): ${e.message}`);
    console.error('[signals] launch TradingView with --remote-debugging-port=9222 and retry.');
    process.exit(2);
  }

  await resolveChatId();
  if (!chatId) {
    console.error('[signals] No chat id yet. Open your bot in Telegram and tap "Start", then restart.');
  } else {
    await send('✅ <b>Signal bot online.</b> Watching your TradingView chart. You\'ll get alerts here.');
    console.error(`[signals] online · chat ${chatId} · polling every ${INTERVAL_MS / 1000}s`);
  }

  // First poll seeds prevClose without firing move alerts.
  await poll();
  setInterval(poll, INTERVAL_MS);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function fmt(n) { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 }); }

main().catch(e => { console.error('[signals] fatal:', e); process.exit(1); });
