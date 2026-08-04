/**
 * The conversation layer: Claude with the chart tools bolted on.
 *
 * One Agent instance per process; conversation history is kept per chat so a
 * follow-up like "and the 5 minute?" still knows what you were looking at.
 */

import { toolSchemas, runTool } from './tools.js';

const SYSTEM_PROMPT = `You are the user's link to their own TradingView Desktop chart. They message you from Telegram, usually from a phone, and you read and drive the chart on their behalf through the tools you have.

The chart is live and shared: what you change, they see on their screen.

How to work:
- Answer from the tools, not from memory. You have no market knowledge past what the tools return, and no way to see the chart except through them.
- Call get_chart_state when you need to know what they're looking at or need an entity ID. Otherwise go straight to the tool that answers the question.
- Custom Pine indicators draw levels, labels, tables and zones that the ordinary data tools cannot see. When someone asks about levels, targets, bias, or session stats, reach for get_pine_graphics.
- Changing the symbol or timeframe changes their live chart. Do it when they ask for it; don't do it as a side effect of answering something else.
- If a tool fails, say what failed in one line. Use check_connection only when you suspect TradingView itself is gone.

How to write:
- Plain text. No markdown, no asterisks, no headers — Telegram renders none of it, and the syntax just clutters the message.
- Lead with the answer. Numbers first, context after, and only the context that changes what they'd do next.
- Short. This is a phone screen. A price question deserves a line, not a report. Skip preamble, skip recapping the question, skip offering follow-ups.
- Use the symbol and timeframe in your answer when it isn't obvious which chart you're describing.

Deliver what they asked for at the scope they asked for. Make routine judgment calls yourself; check in only when different readings would lead to materially different work.`;

export class Agent {
  constructor({ client, model, effort, maxTurns, historyLimit }) {
    this.client = client;
    this.model = model;
    this.effort = effort;
    this.maxTurns = maxTurns;
    this.historyLimit = historyLimit;
    this.useFallbacks = true;
    this.histories = new Map(); // chatId -> messages[]
  }

  /**
   * Build an Agent, or null when no API key is configured (the caller then
   * falls back to the command router).
   */
  static async create(config) {
    if (!config.anthropicApiKey) return null;
    let Anthropic;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      return null;
    }
    return new Agent({
      client: new Anthropic({ apiKey: config.anthropicApiKey }),
      model: config.model,
      effort: config.effort,
      maxTurns: config.maxTurns,
      historyLimit: config.historyLimit,
    });
  }

  reset(chatId) {
    this.histories.delete(chatId);
  }

  history(chatId) {
    if (!this.histories.has(chatId)) this.histories.set(chatId, []);
    return this.histories.get(chatId);
  }

  /**
   * Run one user message to completion, executing tools along the way.
   * Returns the reply text. `ctx` carries sendPhoto and a typing ping.
   */
  async handle(chatId, text, ctx) {
    const messages = this.history(chatId);
    messages.push({ role: 'user', content: text });

    const replies = [];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this.createMessage(messages);

      if (response.stop_reason === 'refusal') {
        this.trim(chatId);
        return "I can't answer that one. Ask me something else about the chart.";
      }

      messages.push({ role: 'assistant', content: response.content });

      const replyText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      if (toolUses.length === 0) {
        if (replyText) replies.push(replyText);
        this.trim(chatId);
        const answer = replies.join('\n\n').trim();
        if (response.stop_reason === 'max_tokens') {
          return `${answer}\n\n(cut off at the length limit)`.trim();
        }
        return answer;
      }

      // Text written before a tool call is a progress note. Send it now — on a
      // phone that reads better than a wall of narration arriving at the end.
      if (replyText) await ctx.say(replyText);
      await ctx.typing();

      // Tools run concurrently, and every result goes back in one user message —
      // splitting them teaches the model to stop making parallel calls.
      const results = await Promise.all(
        toolUses.map(async use => {
          const { ok, result } = await runTool(use.name, use.input, ctx);
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(result),
            ...(ok ? {} : { is_error: true }),
          };
        })
      );
      messages.push({ role: 'user', content: results });
    }

    this.trim(chatId);
    return (
      replies.join('\n\n').trim() ||
      `Stopped after ${this.maxTurns} rounds of tool calls without landing on an answer. Try asking for one thing at a time.`
    );
  }

  /**
   * One request to the model.
   *
   * Server-side fallbacks re-run a request the safety classifiers decline on
   * another model, so a false positive doesn't dead-end a chat. It's a beta
   * parameter — if this account can't use it, drop it and carry on rather than
   * leaving the user with a bot that answers nothing.
   */
  async createMessage(messages) {
    const request = {
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { effort: this.effort },
      tools: toolSchemas(),
      messages,
    };

    if (this.useFallbacks) {
      try {
        return await this.client.beta.messages.create({
          ...request,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        });
      } catch (err) {
        if (err.status !== 400 || !/fallback|beta/i.test(err.message || '')) throw err;
        console.error('[telegram] server-side fallbacks unavailable — continuing without them');
        this.useFallbacks = false;
      }
    }

    return this.client.messages.create(request);
  }

  /**
   * Keep the last `historyLimit` messages, cutting only at a plain user turn so
   * a tool_use block is never separated from its tool_result.
   */
  trim(chatId) {
    const messages = this.history(chatId);
    if (messages.length <= this.historyLimit) return;

    let cut = messages.length - this.historyLimit;
    while (cut < messages.length && !isPlainUserTurn(messages[cut])) cut++;
    if (cut >= messages.length) return; // No safe boundary — leave it alone.
    messages.splice(0, cut);
  }
}

function isPlainUserTurn(message) {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  return !message.content.some(block => block.type === 'tool_result');
}
