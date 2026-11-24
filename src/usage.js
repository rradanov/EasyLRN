// The cost of the AI teacher (T-020, D-022).
// Every finished call is one record in the `usage` store (IndexedDB) with its
// token counts and its estimated cost (src/claude.js `costOf`, by the price
// table PRICES). The month's spend is the sum of this calendar month's records
// (local time); over the threshold of "Настройки" (`monthlyBudgetUSD`, 0 = no
// warning) the app warns. `easylrn:usage` tells open screens (no key, no text).
import { logUsage, usageTotals, monthStart, getSettings } from './db.js';
import { USAGE_LIMITS, MAX_CALL_COST_USD } from './claude.js';

/** A count / a cost as kept: a sane non-negative number, else 0 (T074-D2). */
const bounded = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };

/**
 * Keep one call: { model, kind: 'answer'|'subtopic'|'test', usage: usageCounts(), costUSD }.
 * Returns the month's state after it (monthState).
 */
export async function recordCall({ model, kind = 'answer', usage, costUSD }) {
  const u = usage || {};
  await logUsage({
    model: String(model || ''),
    kind,
    input: bounded(u.input, USAGE_LIMITS.input),
    output: bounded(u.output, USAGE_LIMITS.output),
    cacheRead: bounded(u.cacheRead, USAGE_LIMITS.input),
    cacheWrite: bounded(u.cacheWrite, USAGE_LIMITS.input),
    estCostUSD: bounded(costUSD, MAX_CALL_COST_USD),
  });
  const state = await monthState();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('easylrn:usage', { detail: { spentUSD: state.spentUSD, over: state.over } }));
  return state;
}

/**
 * This month: { spentUSD, calls, limitUSD, over, totals }.
 * `over`: the threshold is set (> 0) and reached.
 */
export async function monthState(date = new Date()) {
  const [totals, settings] = await Promise.all([usageTotals(monthStart(date)), getSettings()]);
  const limitUSD = Number(settings.monthlyBudgetUSD) || 0;
  const spentUSD = totals.estCostUSD;
  return { spentUSD, calls: totals.calls, limitUSD, over: limitUSD > 0 && spentUSD >= limitUSD, totals };
}

/** "$0.0123" / "$1.20": cents, or more digits below one cent. */
export function formatUSD(v) {
  const n = Number(v) || 0;
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** The warning over the threshold (Bulgarian), or '' under it. */
export function budgetWarning(state) {
  if (!state?.over) return '';
  return `Разходът за месеца (${formatUSD(state.spentUSD)}) е над прага от ${formatUSD(state.limitUSD)}. Можеш да продължиш; прагът се сменя в Настройки.`;
}
