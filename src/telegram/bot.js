/**
 * The bridge itself: long-poll Telegram, run each message against the chart,
 * send the answer back.
 */

import { TelegramApi } from './telegram-api.js';
import { Agent } from './agent.js';
import { handleCommand, HELP_NO_AGENT } from './router.js';
import { disconnect } from '../connection.js';

const POLL_TIMEOUT_SECONDS = 30;
const TYPING_INTERVAL_MS = 4000;

export class Bot {
  constructor(config) {
    this.config = config;
    this.api = new TelegramApi(config.token);
    this.agent = null;
    this.offset = undefined;
    this.running = false;
    this.queues = new Map(); // chatId -> tail promise, so one chat's messages stay in order
  }

  async start() {
    const me = await this.api.getMe();
    this.agent = await Agent.create(this.config);

    console.error(`[telegram] connected as @${me.username}`);
    console.error(`[telegram] allowed chats: ${this.config.allowedChatIds.join(', ')}`);
    console.error(
      this.agent
        ? `[telegram] conversation enabled (${this.config.model}, effort ${this.config.effort})`
        : '[telegram] no ANTHROPIC_API_KEY — commands only'
    );

    await this.skipBacklog();
    this.running = true;
    await this.poll();
  }

  stop() {
    this.running = false;
  }

  /** Drop anything Telegram queued while the bot was offline. */
  async skipBacklog() {
    const pending = await this.api.getUpdates({ offset: -1, timeout: 0 });
    if (pending.length > 0) {
      this.offset = pending[pending.length - 1].update_id + 1;
      console.error('[telegram] skipped messages received while offline');
    }
  }

  async poll() {
    while (this.running) {
      let updates;
      try {
        updates = await this.api.getUpdates({ offset: this.offset, timeout: POLL_TIMEOUT_SECONDS });
      } catch (err) {
        if (err.name === 'AbortError' || !this.running) continue;
        if (err.errorCode === 409) {
          console.error('[telegram] another instance is polling this bot — stopping');
          this.running = false;
          return;
        }
        const wait = (err.retryAfter || 5) * 1000;
        console.error(`[telegram] poll failed (${err.message}) — retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }

      for (const update of updates) {
        this.offset = update.update_id + 1;
        if (update.message) this.enqueue(update.message);
      }
    }
  }

  /** Serialize per chat so a follow-up never overtakes the message before it. */
  enqueue(message) {
    const chatId = String(message.chat.id);
    const tail = this.queues.get(chatId) || Promise.resolve();
    const next = tail
      .then(() => this.dispatch(message))
      .catch(err => console.error(`[telegram] unhandled: ${err.stack || err.message}`));
    this.queues.set(chatId, next);
  }

  async dispatch(message) {
    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();

    if (!this.config.allowedChatIds.includes(chatId)) {
      console.error(`[telegram] rejected message from chat ${chatId}`);
      return;
    }
    if (!text) {
      await this.api.sendMessage(chatId, 'Send me text — I can only read messages.');
      return;
    }

    const stopTyping = this.keepTyping(chatId);
    try {
      const reply = await this.respond(chatId, text);
      if (reply) await this.api.sendMessage(chatId, reply);
    } catch (err) {
      await this.api.sendMessage(chatId, `Something broke: ${err.message}`);
      console.error(`[telegram] error handling "${text}": ${err.stack || err.message}`);
    } finally {
      stopTyping();
    }
  }

  async respond(chatId, text) {
    const ctx = {
      hasAgent: Boolean(this.agent),
      reset: () => this.agent?.reset(chatId),
      say: text => this.api.sendMessage(chatId, text),
      typing: () => this.api.sendChatAction(chatId),
      sendPhoto: (filePath, caption) => this.api.sendPhoto(chatId, filePath, caption),
    };

    if (text.startsWith('/')) {
      return handleCommand(text, ctx);
    }
    if (!this.agent) {
      return HELP_NO_AGENT;
    }
    return this.agent.handle(chatId, text, ctx);
  }

  /** Telegram's typing indicator expires after ~5s, so refresh it while we work. */
  keepTyping(chatId) {
    this.api.sendChatAction(chatId);
    const timer = setInterval(() => this.api.sendChatAction(chatId), TYPING_INTERVAL_MS);
    return () => clearInterval(timer);
  }
}

export async function runBot(config) {
  const bot = new Bot(config);

  const shutdown = async () => {
    console.error('\n[telegram] shutting down');
    bot.stop();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
