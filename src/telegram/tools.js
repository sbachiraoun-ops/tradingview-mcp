/**
 * The chart capabilities exposed to the conversation layer.
 *
 * Each entry is a Claude tool definition plus a `run` that calls straight into
 * src/core — the same code the MCP server uses, so the bot and Claude Code see
 * an identical chart.
 */

import * as chart from '../core/chart.js';
import * as data from '../core/data.js';
import * as capture from '../core/capture.js';
import * as health from '../core/health.js';
import * as alerts from '../core/alerts.js';

/**
 * ctx = { sendPhoto(filePath, caption) } — lets the screenshot tool push the
 * image to the chat instead of handing Claude a path it can't see.
 */
export const TOOLS = [
  {
    name: 'get_chart_state',
    description:
      'Read the current chart: symbol, timeframe, chart type, and every indicator on it with its entity ID. ' +
      'Call this first when you need to know what the user is looking at, or when you need an entity ID to remove an indicator.',
    input_schema: { type: 'object', properties: {} },
    run: () => chart.getState(),
  },

  {
    name: 'get_quote',
    description:
      'Latest price snapshot for the chart symbol: last, open, high, low, close, volume. ' +
      'Use for "what is X trading at" questions.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Optional ticker. Omit to quote whatever the chart is showing.',
        },
      },
    },
    run: ({ symbol }) => data.getQuote({ symbol }),
  },

  {
    name: 'get_ohlcv',
    description:
      'Price bars for the current symbol and timeframe. Returns a compact summary (high, low, range, change %, average volume, last few bars) unless full_bars is true. ' +
      'Ask for full_bars only when the user needs individual candles.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          description: 'How many bars to look back. Default 100, maximum 500.',
        },
        full_bars: {
          type: 'boolean',
          description: 'True to return every bar instead of a summary. Costs a lot of output — keep count low if you set this.',
        },
      },
    },
    run: ({ count, full_bars }) =>
      data.getOhlcv({ count: Math.min(count || 100, 500), summary: !full_bars }),
  },

  {
    name: 'get_indicator_values',
    description:
      'Current numeric readings from every visible indicator on the chart (RSI, MACD, moving averages, Bollinger Bands, and so on). ' +
      'This is the fast way to answer "is it overbought" or "where are the bands".',
    input_schema: { type: 'object', properties: {} },
    run: () => data.getStudyValues(),
  },

  {
    name: 'get_pine_graphics',
    description:
      'Read what custom Pine indicators have drawn on the chart — these are invisible to the other data tools. ' +
      'kind="lines" gives horizontal price levels, "labels" gives text annotations with prices, ' +
      '"tables" gives dashboard/session-stats tables, "boxes" gives price zones. ' +
      'Pass study_filter with part of the indicator name whenever you know which one you want.',
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['lines', 'labels', 'tables', 'boxes'],
          description: 'Which type of drawing to read.',
        },
        study_filter: {
          type: 'string',
          description: 'Substring of the indicator name, e.g. "Profiler". Omit to scan every study.',
        },
      },
      required: ['kind'],
    },
    run: ({ kind, study_filter }) => {
      switch (kind) {
        case 'lines': return data.getPineLines({ study_filter });
        case 'labels': return data.getPineLabels({ study_filter });
        case 'tables': return data.getPineTables({ study_filter });
        case 'boxes': return data.getPineBoxes({ study_filter });
        default: throw new Error(`Unknown kind: ${kind}`);
      }
    },
  },

  {
    name: 'set_symbol',
    description: 'Switch the chart to a different ticker, e.g. "AAPL", "ES1!", "NYMEX:CL1!".',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string', description: 'Ticker to load.' } },
      required: ['symbol'],
    },
    run: ({ symbol }) => chart.setSymbol({ symbol }),
  },

  {
    name: 'set_timeframe',
    description:
      'Switch the chart resolution. Use TradingView notation: "1", "5", "15", "60" for minutes, "D" daily, "W" weekly.',
    input_schema: {
      type: 'object',
      properties: { timeframe: { type: 'string', description: 'Resolution to load.' } },
      required: ['timeframe'],
    },
    run: ({ timeframe }) => chart.setTimeframe({ timeframe }),
  },

  {
    name: 'search_symbol',
    description:
      'Look up TradingView tickers by name or partial symbol. Use this when the user names an instrument loosely and you need the exact ticker before calling set_symbol.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text, e.g. "crude oil" or "NVDA".' },
      },
      required: ['query'],
    },
    run: ({ query }) => chart.symbolSearch({ query }),
  },

  {
    name: 'manage_indicator',
    description:
      'Add or remove an indicator. Adding requires the full TradingView name — "Relative Strength Index", not "RSI"; ' +
      '"Moving Average Exponential", not "EMA". Removing requires the entity_id from get_chart_state.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        indicator: { type: 'string', description: 'Full indicator name. Required when adding.' },
        entity_id: { type: 'string', description: 'Study ID from get_chart_state. Required when removing.' },
        inputs: {
          type: 'object',
          description: 'Optional indicator settings when adding, e.g. {"length": 21}.',
        },
      },
      required: ['action'],
    },
    run: ({ action, indicator, entity_id, inputs }) =>
      chart.manageIndicator({ action, indicator, entity_id, inputs }),
  },

  {
    name: 'send_screenshot',
    description:
      'Capture the chart and send the image straight to the user in this chat. ' +
      'Use it when they ask to see the chart, or when a picture answers the question better than numbers. ' +
      'You will not see the image yourself — describe what you already know from the data tools.',
    input_schema: {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          enum: ['chart', 'full', 'strategy_tester'],
          description: 'Which area to capture. Default "chart".',
        },
        caption: { type: 'string', description: 'Short caption shown under the image.' },
      },
    },
    run: async ({ region, caption }, ctx) => {
      const shot = await capture.captureScreenshot({ region: region || 'chart' });
      if (!shot.file_path) return { success: false, error: 'Screenshot produced no file.' };
      await ctx.sendPhoto(shot.file_path, caption);
      return { success: true, sent: true, note: 'Image delivered to the user in this chat.' };
    },
  },

  {
    name: 'manage_alerts',
    description: 'List the active price alerts, create one, or delete all of them.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete_all'] },
        condition: {
          type: 'string',
          enum: ['crossing', 'greater_than', 'less_than'],
          description: 'Required when creating.',
        },
        price: { type: 'number', description: 'Trigger price. Required when creating.' },
        message: { type: 'string', description: 'Optional alert message.' },
      },
      required: ['action'],
    },
    run: ({ action, condition, price, message }) => {
      if (action === 'list') return alerts.list();
      if (action === 'create') return alerts.create({ condition, price, message });
      if (action === 'delete_all') return alerts.deleteAlerts({ delete_all: true });
      throw new Error(`Unknown action: ${action}`);
    },
  },

  {
    name: 'check_connection',
    description:
      'Verify the bridge can still reach TradingView. Call this when a tool fails and you need to tell the user whether the app went away.',
    input_schema: { type: 'object', properties: {} },
    run: () => health.healthCheck(),
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/** Tool definitions in the shape the Messages API expects. */
export function toolSchemas() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Execute one tool call. Errors come back as data so the model can recover
 * (retry differently, or tell the user what broke) instead of killing the turn.
 */
export async function runTool(name, input, ctx) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, result: { error: `Unknown tool: ${name}` } };
  try {
    return { ok: true, result: await tool.run(input || {}, ctx) };
  } catch (err) {
    return { ok: false, result: { error: err.message } };
  }
}
