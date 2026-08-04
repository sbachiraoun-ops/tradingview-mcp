# Telegram Bridge

Chat with your own TradingView chart from your phone.

The bridge runs on the same machine as TradingView Desktop, talks to the chart
over CDP (the same path the MCP server uses), and long-polls Telegram for
messages. There is no public URL, no inbound port, and nothing to expose — the
machine only ever makes outbound HTTPS calls, so it works fine behind NAT.

```
Telegram app  ←→  api.telegram.org  ←──long poll──  bridge  ←→  CDP :9222  ←→  TradingView Desktop
```

You message the bot in plain English; it reads the chart with the same core
functions the MCP tools use, and answers. Screenshots come back as photos.

---

## Setup

### 1. Create a bot

Message [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, follow
the prompts, and copy the token it gives you.

```bash
export TELEGRAM_BOT_TOKEN="123456:AAE..."
```

### 2. Find your chat ID

Send your new bot any message, then:

```bash
npm run telegram -- --whoami
```

It prints the chat ID of whoever messaged it.

```bash
export TELEGRAM_ALLOWED_CHAT_IDS="5551212"
```

**This allowlist is required.** Telegram bot usernames are public and
discoverable — without it, anyone who finds your bot could change your symbol,
add indicators, and screenshot your screen. Messages from any other chat are
dropped and logged.

### 3. Add a Claude API key (optional, but it's the whole point)

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Without it the bridge still runs, but only understands slash commands. With it
you can just talk.

### 4. Start it

TradingView must already be running with `--remote-debugging-port=9222` (see the
main README). Then:

```bash
npm run telegram
```

Leave it running. `Ctrl-C` shuts it down cleanly.

---

## Using it

Plain English, most of the time:

> **you:** what's ES doing
> **bot:** ES1! 6142.25 on the 5m. Up 18.50 (+0.30%) over the last 100 bars, range 6118.00–6151.75.

> **you:** switch to the 15 and show me
> *(chart changes on your desktop, screenshot arrives)*

> **you:** where are my levels
> **bot:** From Session Profiler: 6151.75, 6142.00, 6128.50, 6118.00. Price is sitting just above the 6142 line.

> **you:** is it overbought
> **bot:** RSI 68.4 on the 15m — high but not through 70. MACD histogram still positive.

Follow-ups keep context, so "and the daily?" works. `/reset` clears it.

### Commands

These skip the model entirely, so they're instant and cost no tokens.

| Command | What it does |
|---|---|
| `/state` | Symbol, timeframe, chart type, all indicators with entity IDs |
| `/quote [SYM]` | Latest price snapshot |
| `/values` | Current readings from every visible indicator |
| `/levels [name]` | Price levels drawn by Pine indicators |
| `/labels [name]` | Pine label annotations with prices |
| `/bars [n]` | Price action summary over the last n bars |
| `/symbol SYM` | Switch ticker |
| `/tf TF` | Switch timeframe (`1`, `5`, `15`, `60`, `D`, `W`) |
| `/shot` | Screenshot the chart |
| `/alerts` | List active alerts |
| `/reset` | Forget the conversation so far |
| `/health` | Check the connection to TradingView |

---

## Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | From @BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | yes | — | Comma-separated. Everything else is dropped. |
| `ANTHROPIC_API_KEY` | no | — | Enables free-form conversation |
| `TELEGRAM_MODEL` | no | `claude-opus-5` | |
| `TELEGRAM_EFFORT` | no | `medium` | `low`–`max`. Raise for deeper analysis, lower for snappier replies. |
| `TELEGRAM_MAX_TURNS` | no | `12` | Tool-call rounds allowed per message |
| `TELEGRAM_HISTORY` | no | `40` | Messages kept per chat before trimming |

`medium` effort is a deliberate default for a chat bridge — most questions are
one or two tool calls and latency is felt on a phone. Bump it to `high` if you
ask for multi-step analysis and want more thoroughness.

---

## What the bot can reach

The conversation layer gets a focused subset of the chart, not all 78 MCP tools:

**Read** — chart state, quotes, OHLCV, indicator values, Pine lines/labels/tables/boxes, alerts, connection health
**Write** — symbol, timeframe, add/remove indicator, create alerts
**Send** — chart screenshots straight into the chat

Deliberately left out: Pine Script editing, replay-mode trading, drawing tools,
layout switching. Those are involved enough that a terminal beats a phone. Use
Claude Code with the MCP server for that work.

The bot cannot place real trades. Nothing in this repo can — see the main
README's "What This Tool Does Not Do".

---

## Operational notes

- **One instance per bot token.** Telegram rejects a second poller with a 409;
  the bridge detects this and exits rather than fighting over updates.
- **Messages received while the bridge is down are skipped** on startup, so you
  don't come back to a queue of stale instructions being replayed against a
  live chart.
- **Messages within a chat are processed in order**, so a follow-up never
  overtakes the message it's following up on.
- **Tool errors come back as text**, not silence — if TradingView has gone away
  the bot will say so instead of hanging.
- **Screenshots are written to `screenshots/`** (gitignored) as well as being
  sent, same as the MCP server.

## Troubleshooting

**"another instance is polling this bot"** — a second copy is running, or a
previous run didn't exit. Kill it, or make a second bot for the second machine.

**Every chart tool fails** — TradingView isn't reachable on port 9222. Check with
`/health`, then `npm run tv -- status` on the host, then restart TradingView
with the debugging flag.

**Bot ignores you** — your chat ID isn't in `TELEGRAM_ALLOWED_CHAT_IDS`. The
bridge logs each rejection with the ID that was dropped; copy it from there.

**Replies are commands-only help text** — `ANTHROPIC_API_KEY` isn't set, or
`@anthropic-ai/sdk` wasn't installed (it's an optional dependency; run
`npm install` without `--no-optional`).
