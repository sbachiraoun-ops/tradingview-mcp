/**
 * Slash commands.
 *
 * These work whether or not an API key is configured. Without one they are the
 * whole interface; with one they sit alongside the conversation as a fast path
 * that costs no tokens.
 */

import * as chart from '../core/chart.js';
import * as data from '../core/data.js';
import * as capture from '../core/capture.js';
import * as health from '../core/health.js';
import * as alerts from '../core/alerts.js';

export const HELP_WITH_AGENT = `Just talk to me — "what's ES doing", "switch to the 5 minute", "show me the chart", "where are my levels".

Shortcuts that skip the model:
/state          symbol, timeframe, indicators
/quote [SYM]    latest price
/values         all indicator readings
/levels [name]  price levels drawn by Pine indicators
/labels [name]  Pine label annotations
/bars [n]       price action summary
/symbol SYM     switch ticker
/tf TF          switch timeframe (1, 5, 15, 60, D, W)
/shot           screenshot the chart
/alerts         list active alerts
/reset          forget the conversation so far
/health         check the TradingView connection`;

export const HELP_NO_AGENT = `Running without ANTHROPIC_API_KEY, so I only understand commands:

/state          symbol, timeframe, indicators
/quote [SYM]    latest price
/values         all indicator readings
/levels [name]  price levels drawn by Pine indicators
/labels [name]  Pine label annotations
/bars [n]       price action summary
/symbol SYM     switch ticker
/tf TF          switch timeframe (1, 5, 15, 60, D, W)
/shot           screenshot the chart
/alerts         list active alerts
/health         check the TradingView connection

Set ANTHROPIC_API_KEY and restart to talk to me in plain English instead.`;

/**
 * Handle a slash command.
 * Returns null when the text isn't a command this router owns.
 */
export async function handleCommand(text, ctx) {
  const match = /^\/([a-z_]+)(?:@\w+)?\s*(.*)$/is.exec(text.trim());
  if (!match) return null;

  const command = match[1].toLowerCase();
  const arg = match[2].trim();

  switch (command) {
    case 'start':
    case 'help':
      return ctx.hasAgent ? HELP_WITH_AGENT : HELP_NO_AGENT;

    case 'reset':
      ctx.reset();
      return 'Cleared. Starting fresh.';

    case 'state': {
      const s = await chart.getState();
      const studies = s.studies?.length
        ? s.studies.map(st => `  ${st.name}  [${st.id}]`).join('\n')
        : '  (none)';
      return `${s.symbol}  ${s.resolution}  type ${s.chartType}\nIndicators:\n${studies}`;
    }

    case 'quote': {
      const q = await data.getQuote({ symbol: arg || undefined });
      const lines = [`${q.symbol}  ${fmt(q.last ?? q.close)}`];
      if (q.open != null) lines.push(`O ${fmt(q.open)}  H ${fmt(q.high)}  L ${fmt(q.low)}  C ${fmt(q.close)}`);
      if (q.volume) lines.push(`Volume ${q.volume}`);
      if (q.description) lines.push(q.description);
      return lines.join('\n');
    }

    case 'values': {
      const v = await data.getStudyValues();
      if (!v.studies?.length) return 'No indicators reporting values.';
      return v.studies
        .map(s => {
          const pairs = Object.entries(s.values).map(([k, val]) => `  ${k}: ${val}`).join('\n');
          return `${s.name}\n${pairs}`;
        })
        .join('\n\n');
    }

    case 'levels': {
      const r = await data.getPineLines({ study_filter: arg || undefined });
      if (!r.studies?.length) return 'No Pine indicators are drawing lines right now.';
      return r.studies
        .map(s => `${s.name}\n  ${s.horizontal_levels.join('  ') || '(no horizontal levels)'}`)
        .join('\n\n');
    }

    case 'labels': {
      const r = await data.getPineLabels({ study_filter: arg || undefined });
      if (!r.studies?.length) return 'No Pine indicators are drawing labels right now.';
      return r.studies
        .map(s => {
          const items = s.labels
            .map(l => `  ${l.text}${l.price != null ? `  ${fmt(l.price)}` : ''}`)
            .join('\n');
          return `${s.name}\n${items}`;
        })
        .join('\n\n');
    }

    case 'bars': {
      const count = Math.min(Number(arg) || 100, 500);
      const r = await data.getOhlcv({ count, summary: true });
      return formatJson(r);
    }

    case 'symbol': {
      if (!arg) return 'Give me a ticker: /symbol ES1!';
      const r = await chart.setSymbol({ symbol: arg.toUpperCase() });
      return `Chart is on ${r.symbol}.`;
    }

    case 'tf': {
      if (!arg) return 'Give me a timeframe: /tf 5';
      const r = await chart.setTimeframe({ timeframe: arg.toUpperCase() });
      return `Timeframe is ${r.timeframe}.`;
    }

    case 'shot': {
      const shot = await capture.captureScreenshot({ region: 'chart' });
      if (!shot.file_path) return 'Screenshot produced no file.';
      await ctx.sendPhoto(shot.file_path);
      return null; // The image is the reply.
    }

    case 'alerts': {
      const r = await alerts.list();
      if (!r.alerts?.length) return r.error ? `Could not read alerts: ${r.error}` : 'No active alerts.';
      return r.alerts
        .map(a => `${a.symbol}  ${a.active ? 'active' : 'inactive'}${a.message ? `\n  ${a.message}` : ''}`)
        .join('\n');
    }

    case 'health': {
      const h = await health.healthCheck();
      return `Connected to ${h.target_title || 'TradingView'}\n${h.chart_symbol}  ${h.chart_resolution}\nChart API ${h.api_available ? 'available' : 'NOT available'}`;
    }

    default:
      return `Unknown command: /${command}\n\n${ctx.hasAgent ? HELP_WITH_AGENT : HELP_NO_AGENT}`;
  }
}

function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return '?';
  return String(Math.round(Number(n) * 10000) / 10000);
}

function formatJson(obj) {
  return Object.entries(obj)
    .filter(([k]) => k !== 'success')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}
