#!/usr/bin/env node
/**
 * Entry point for the Telegram bridge.
 *
 *   npm run telegram             start the bridge
 *   npm run telegram -- --whoami print the chat ID of whoever messages the bot
 */

import { loadConfig, loadTokenOnly } from './config.js';
import { TelegramApi } from './telegram-api.js';
import { runBot } from './bot.js';

async function whoami() {
  const { token } = loadTokenOnly();
  const api = new TelegramApi(token);
  const me = await api.getMe();
  console.log(`Bot: @${me.username}`);
  console.log('Send your bot a message now — waiting 30 seconds...\n');

  const updates = await api.getUpdates({ offset: undefined, timeout: 30 });
  if (updates.length === 0) {
    console.log('Nothing arrived. Message the bot in Telegram, then run this again.');
    return;
  }
  const seen = new Set();
  for (const update of updates) {
    const chat = update.message?.chat;
    if (!chat || seen.has(chat.id)) continue;
    seen.add(chat.id);
    const who = chat.username ? `@${chat.username}` : chat.title || chat.first_name || 'unknown';
    console.log(`${who}  ->  chat ID ${chat.id}`);
  }
  console.log('\nExport it:  export TELEGRAM_ALLOWED_CHAT_IDS=<id>');
}

async function main() {
  if (process.argv.includes('--whoami')) {
    await whoami();
    return;
  }
  await runBot(loadConfig());
}

main().catch(err => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
