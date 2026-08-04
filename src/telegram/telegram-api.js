/**
 * Minimal Telegram Bot API client over long polling.
 *
 * Long polling means the machine running TradingView only makes outbound HTTPS
 * calls — no public URL, no inbound ports, works behind NAT.
 */

import { readFile } from 'fs/promises';
import { basename } from 'path';

const API_ROOT = 'https://api.telegram.org';
const MAX_MESSAGE_CHARS = 4000; // Telegram's hard limit is 4096; leave headroom.

export class TelegramApi {
  constructor(token) {
    this.token = token;
    this.base = `${API_ROOT}/bot${token}`;
  }

  async call(method, params = {}, { timeoutMs = 60000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const body = await resp.json();
      if (!body.ok) {
        const err = new Error(`Telegram ${method} failed: ${body.description}`);
        err.errorCode = body.error_code;
        err.retryAfter = body.parameters?.retry_after;
        throw err;
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe() {
    return this.call('getMe', {}, { timeoutMs: 15000 });
  }

  /**
   * Long-poll for updates. `timeout` is seconds Telegram holds the connection
   * open when there is nothing new.
   */
  async getUpdates({ offset, timeout = 30 }) {
    return this.call(
      'getUpdates',
      { offset, timeout, allowed_updates: ['message'] },
      { timeoutMs: (timeout + 15) * 1000 }
    );
  }

  /** Send text, splitting anything over Telegram's per-message limit. */
  async sendMessage(chatId, text) {
    const body = String(text ?? '').trim() || '(no output)';
    for (const chunk of splitMessage(body)) {
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
    }
  }

  async sendChatAction(chatId, action = 'typing') {
    try {
      await this.call('sendChatAction', { chat_id: chatId, action }, { timeoutMs: 10000 });
    } catch {
      // Typing indicators are cosmetic — never let one break a reply.
    }
  }

  /** Upload a local image file as a photo. */
  async sendPhoto(chatId, filePath, caption) {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('photo', new Blob([bytes], { type: 'image/png' }), basename(filePath));

    const resp = await fetch(`${this.base}/sendPhoto`, { method: 'POST', body: form });
    const body = await resp.json();
    if (!body.ok) throw new Error(`Telegram sendPhoto failed: ${body.description}`);
    return body.result;
  }
}

/** Split on paragraph, then line, then hard character boundaries. */
export function splitMessage(text, limit = MAX_MESSAGE_CHARS) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
