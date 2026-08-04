/**
 * Telegram bridge unit tests — no TradingView connection, no Telegram token needed.
 * Covers: message splitting, config validation, command routing, history trimming.
 *
 * Run: node --test tests/telegram.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { splitMessage } from '../src/telegram/telegram-api.js';
import { loadConfig } from '../src/telegram/config.js';
import { handleCommand, HELP_NO_AGENT, HELP_WITH_AGENT } from '../src/telegram/router.js';
import { Agent } from '../src/telegram/agent.js';
import { TOOLS, toolSchemas, runTool } from '../src/telegram/tools.js';

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: '123:abc',
  TELEGRAM_ALLOWED_CHAT_IDS: '5551212',
};

describe('splitMessage', () => {
  it('leaves short text alone', () => {
    assert.deepEqual(splitMessage('hello'), ['hello']);
  });

  it('splits long text into chunks under the limit', () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const chunks = splitMessage(text, 200);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 200, `chunk too long: ${chunk.length}`);
  });

  it('prefers paragraph boundaries', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`;
    const chunks = splitMessage(text, 80);
    assert.equal(chunks[0], 'a'.repeat(60));
  });

  it('splits text with no breaks at all', () => {
    const chunks = splitMessage('x'.repeat(250), 100);
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(''), 'x'.repeat(250));
  });
});

describe('loadConfig', () => {
  it('rejects a missing token', () => {
    assert.throws(() => loadConfig({ TELEGRAM_ALLOWED_CHAT_IDS: '1' }), /TELEGRAM_BOT_TOKEN/);
  });

  it('rejects a missing allowlist — an open bot can drive the chart', () => {
    assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: 'x' }), /TELEGRAM_ALLOWED_CHAT_IDS/);
  });

  it('parses a multi-chat allowlist', () => {
    const config = loadConfig({ ...BASE_ENV, TELEGRAM_ALLOWED_CHAT_IDS: ' 1, 2 ,3 ' });
    assert.deepEqual(config.allowedChatIds, ['1', '2', '3']);
  });

  it('defaults the model and effort', () => {
    const config = loadConfig(BASE_ENV);
    assert.equal(config.model, 'claude-opus-5');
    assert.equal(config.effort, 'medium');
    assert.equal(config.anthropicApiKey, null);
  });

  it('honors overrides', () => {
    const config = loadConfig({ ...BASE_ENV, TELEGRAM_MODEL: 'claude-sonnet-5', TELEGRAM_EFFORT: 'low' });
    assert.equal(config.model, 'claude-sonnet-5');
    assert.equal(config.effort, 'low');
  });
});

describe('command router', () => {
  const ctx = { hasAgent: true, reset() { this.wasReset = true; }, sendPhoto() {}, typing() {} };

  it('ignores plain conversation', async () => {
    assert.equal(await handleCommand('what is ES doing', ctx), null);
  });

  it('answers /help based on whether the model is wired up', async () => {
    assert.equal(await handleCommand('/help', { ...ctx, hasAgent: true }), HELP_WITH_AGENT);
    assert.equal(await handleCommand('/help', { ...ctx, hasAgent: false }), HELP_NO_AGENT);
  });

  it('handles /command@botname from group chats', async () => {
    assert.equal(await handleCommand('/help@my_chart_bot', ctx), HELP_WITH_AGENT);
  });

  it('/reset clears conversation state', async () => {
    const local = { ...ctx, wasReset: false, reset() { local.wasReset = true; } };
    await handleCommand('/reset', local);
    assert.equal(local.wasReset, true);
  });

  it('asks for an argument when one is required', async () => {
    assert.match(await handleCommand('/symbol', ctx), /ticker/i);
    assert.match(await handleCommand('/tf', ctx), /timeframe/i);
  });

  it('reports unknown commands with the help text', async () => {
    const reply = await handleCommand('/nope', ctx);
    assert.match(reply, /Unknown command/);
  });
});

describe('tool definitions', () => {
  it('every tool has a name, description and schema', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.name, 'missing name');
      assert.ok(tool.description.length > 40, `${tool.name}: description too thin`);
      assert.equal(tool.input_schema.type, 'object', `${tool.name}: bad schema`);
      assert.equal(typeof tool.run, 'function', `${tool.name}: missing run`);
    }
  });

  it('schemas exclude the run function', () => {
    for (const schema of toolSchemas()) {
      assert.deepEqual(Object.keys(schema).sort(), ['description', 'input_schema', 'name']);
    }
  });

  it('tool names are unique', () => {
    const names = TOOLS.map(t => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('returns unknown tools as data, not a throw', async () => {
    const { ok, result } = await runTool('does_not_exist', {}, {});
    assert.equal(ok, false);
    assert.match(result.error, /Unknown tool/);
  });

  it('turns a failing tool into an error result the model can read', async () => {
    // A bad `kind` throws inside the tool; it should come back as data the
    // model can act on rather than blowing up the turn.
    const { ok, result } = await runTool('get_pine_graphics', { kind: 'bogus' }, {});
    assert.equal(ok, false);
    assert.match(result.error, /Unknown kind/);
  });
});

describe('history trimming', () => {
  function agentWithHistory(messages, historyLimit = 4) {
    const agent = new Agent({ client: null, model: 'm', effort: 'low', maxTurns: 5, historyLimit });
    agent.histories.set('chat', messages);
    return agent;
  }

  it('leaves short histories alone', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    const agent = agentWithHistory(messages);
    agent.trim('chat');
    assert.equal(messages.length, 2);
  });

  it('trims to a plain user turn', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'reply two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'reply three' },
    ];
    const agent = agentWithHistory(messages, 3);
    agent.trim('chat');
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'three');
  });

  it('never splits a tool_use from its tool_result', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_quote', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: 'two' },
    ];
    const agent = agentWithHistory(messages, 2);
    agent.trim('chat');
    // The only safe cut point is the plain "two" turn.
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'two');
  });

  it('keeps everything when no safe boundary exists', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_quote', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];
    const agent = agentWithHistory(messages, 1);
    agent.trim('chat');
    assert.equal(messages.length, 3);
  });
});

describe('Agent.create', () => {
  it('returns null without an API key so the bot falls back to commands', async () => {
    assert.equal(await Agent.create(loadConfig(BASE_ENV)), null);
  });
});
