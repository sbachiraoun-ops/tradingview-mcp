# Phone Signals via Telegram

Push live signals from your TradingView chart straight to your phone. Telegram
is free, instant, and works on any phone — no per-message cost, no extra app to
build.

The bridge (`scripts/signal_bot.js`) reuses the same CDP layer as the MCP
server, so it reads **your real chart**: real-time price, RSI (and other
studies), and the horizontal price levels your custom Pine indicators draw.

## Why it runs on your machine

The signal bot reads TradingView Desktop over CDP at `localhost:9222`. That
"localhost" is the computer where TradingView is running. So the bot must run on
that same machine (or anything with network access to it). A cloud session
cannot see your local chart.

> Keep that computer on with a chart open for signals to flow. That's inherent —
> there's no way to read your chart while the machine is off.

## Setup (2 minutes, one time)

1. **Create a bot.** In Telegram, message [@BotFather](https://t.me/BotFather) →
   `/newbot` → pick a name → copy the **token** it gives you
   (looks like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxx`).
2. **Start your bot.** Open the new bot in Telegram and tap **Start** (or send
   any message). This is what lets the bot message you back — Telegram blocks
   bots from messaging users who haven't opted in. The chat id is auto-detected
   from this message.
3. **Run it** on the machine where TradingView is open (CDP on port 9222):

   ```bash
   export TELEGRAM_BOT_TOKEN=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxx
   npm run signals
   ```

You'll get a `✅ Signal bot online` message on your phone. Done — leave it
running.

## What it sends (defaults)

| Trigger | Example message |
|---------|-----------------|
| RSI overbought (≥70) / oversold (≤30) | 🔴 `ES1!` RSI overbought: **72.4** @ 5341.25 |
| Price reaches a level drawn by a Pine indicator | 🎯 `ES1!` testing level **5350** (Profiler) — price 5349.5 |
| Sharp move since last poll (≥0.5%) | 📈 `ES1!` moved **+0.61%** → 5362.00 |

Each signal has a 15-minute cooldown so you don't get spammed.

## Tuning (optional env vars)

| Variable | Default | Meaning |
|----------|---------|---------|
| `SIGNAL_INTERVAL_MS` | `60000` | poll cadence (ms) |
| `SIGNAL_RSI_OB` / `SIGNAL_RSI_OS` | `70` / `30` | RSI thresholds |
| `SIGNAL_MOVE_PCT` | `0.5` | % move since last poll that fires |
| `SIGNAL_LEVEL_PCT` | `0.05` | how close to a Pine level (% of price) fires |
| `SIGNAL_COOLDOWN_MS` | `900000` | min gap before re-firing the same signal |
| `SIGNAL_CHAT_ID` → `TELEGRAM_CHAT_ID` | auto | override the auto-detected chat |
| `SIGNAL_HEARTBEAT` | unset | set `1` to get a snapshot every poll (debug) |

## Write your own signals

Open `scripts/signal_bot.js` and edit `evaluateSignals(snap)`. You get
`{ symbol, price, rsi, levels }` and return `{ key, text }` entries. `key` drives
de-duplication; `text` is the Telegram message (HTML formatting allowed).

## Keep it running

- **macOS/Linux:** `nohup npm run signals > signals.log 2>&1 &`
- **Survives reboots:** wrap it in a `launchd` (mac) / `systemd` (linux) /
  Task Scheduler (win) service.
