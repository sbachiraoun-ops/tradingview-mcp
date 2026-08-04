/**
 * Configuration for the Telegram bridge.
 *
 * Everything comes from environment variables so no secrets live in the repo.
 * Required:
 *   TELEGRAM_BOT_TOKEN         token from @BotFather
 *   TELEGRAM_ALLOWED_CHAT_IDS  comma-separated chat IDs allowed to talk to the bot
 * Optional:
 *   ANTHROPIC_API_KEY          enables free-form conversation (falls back to commands without it)
 *   TELEGRAM_MODEL             model id, default claude-opus-5
 *   TELEGRAM_EFFORT            low | medium | high | xhigh | max, default medium
 *   TELEGRAM_MAX_TURNS         max tool-use rounds per message, default 12
 *   TELEGRAM_HISTORY           conversation messages kept per chat, default 40
 */

function parseChatIds(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and export the token.'
    );
  }

  const allowedChatIds = parseChatIds(env.TELEGRAM_ALLOWED_CHAT_IDS);
  if (allowedChatIds.length === 0) {
    throw new Error(
      'TELEGRAM_ALLOWED_CHAT_IDS is not set. Without it anyone who finds your bot could drive your chart.\n' +
      'Message your bot once, then run: npm run telegram -- --whoami  to print your chat ID.'
    );
  }

  return {
    token,
    allowedChatIds,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    model: env.TELEGRAM_MODEL || 'claude-opus-5',
    effort: env.TELEGRAM_EFFORT || 'medium',
    maxTurns: Number(env.TELEGRAM_MAX_TURNS) || 12,
    historyLimit: Number(env.TELEGRAM_HISTORY) || 40,
  };
}

/** Config for --whoami, which only needs the token. */
export function loadTokenOnly(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set.');
  return { token };
}
