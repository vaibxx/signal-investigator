// Signal Investigator engine: a line-for-line port of investigate.py.
// No DOM here, so the same module runs in the browser and in Node (tests/web_parity.mjs).

export const ACTIONS = ['score', 'segments', 'mix', 'finish'];
export const THRESHOLD = 0.03;

export const SCENARIOS = {
  // Each pair is [[before successes, before total], [after successes, after total]].
  'traffic-shift': { lookup: [[81, 90], [9, 10]], summary: [[5, 10], [45, 90]] },
  'retrieval-regression': { lookup: [[90, 100], [60, 100]], summary: [[80, 100], [80, 100]] },
  'mixed-change': { lookup: [[81, 90], [7, 10]], summary: [[5, 10], [36, 90]] },
  'quiet-release': { lookup: [[90, 100], [89, 100]], summary: [[80, 100], [80, 100]] }
};

export const TOOL_DESCRIPTIONS = {
  score: 'overall pass rates',
  segments: 'rates by segment',
  mix: 'counterfactual attribution',
  finish: 'deliver grounded verdict'
};

export const GOAL =
  'Investigate a release quality alert. First score; stop for a decline smaller than 3 percentage points. ' +
  'For a material decline inspect both segments and mix, in either order, before finishing.';

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

export function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
    throw new Error('Expected a nonempty object keyed by evaluation segment');
  }
  for (const [name, pair] of Object.entries(data)) {
    if (!name || !Array.isArray(pair) || pair.length !== 2) throw new Error('Each segment needs before and after counts');
    for (const counts of pair) {
      if (!Array.isArray(counts) || counts.length !== 2) throw new Error('Each count must be [successes, total]');
      const [passed, total] = counts;
      if (!isInt(total) || !isInt(passed) || !(passed >= 0 && passed <= total) || total === 0) {
        throw new Error('Counts require 0 <= successes <= total and total > 0');
      }
    }
  }
}

export function measure(action, data) {
  const pairs = Object.values(data);
  const totals = [0, 1].map((i) => pairs.reduce((s, p) => s + p[i][1], 0));
  const rates = [0, 1].map((i) => pairs.reduce((s, p) => s + p[i][0], 0) / totals[i]);
  if (action === 'score') {
    return { before: rates[0], after: rates[1], delta: rates[1] - rates[0], sample_sizes: totals };
  }
  if (action === 'segments') {
    return Object.fromEntries(Object.entries(data).map(([name, [[a, n], [b, m]]]) => [name, { before: a / n, after: b / m, after_count: m }]));
  }
  const counterfactual = pairs.reduce((s, [[a, n], [, m]]) => s + (a / n) * (m / totals[1]), 0);
  return {
    old_rates_at_new_weights: counterfactual,
    mix_effect: counterfactual - rates[0],
    within_effect: rates[1] - counterfactual
  };
}

export function nextRequired(seen) {
  if (!('score' in seen)) return 'score';
  if (seen.score.delta > -THRESHOLD + 1e-12) return 'finish';
  for (const action of ['segments', 'mix']) if (!(action in seen)) return action;
  return 'finish';
}

export function verdict(seen) {
  if (!('mix' in seen)) return 'below-alert-threshold';
  const { mix_effect: mix, within_effect: within } = seen.mix;
  if (Math.abs(mix) < 1e-10 || (within < 0 && mix >= 0)) return 'within-segment-decline';
  if (Math.abs(within) < 1e-10 || (mix < 0 && within >= 0)) return 'traffic-mix-shift';
  return 'mixed-decline';
}

export class GuardrailError extends Error {}

/**
 * Runs the bounded tool loop. `choose(seen, remaining)` may be async (a model);
 * without it the deterministic offline planner is used. `onStep` sees each step as it happens.
 */
export async function investigate(data, choose = null, onStep = () => {}) {
  validate(data);
  const seen = {};
  const trace = [];
  for (let step = 0; step < 4; step++) {
    const remaining = ACTIONS.filter((a) => !(a in seen));
    const action = choose ? await choose(seen, remaining) : nextRequired(seen);
    if (typeof action !== 'string' || !remaining.includes(action)) {
      throw new GuardrailError(`Invalid or repeated action at step ${step + 1}${typeof action === 'string' ? ` ("${action}")` : ''}`);
    }
    if (Object.keys(seen).length === 0 && action !== 'score') {
      throw new GuardrailError(`First action must establish the overall score (agent chose "${action}")`);
    }
    if (action === 'finish') {
      if (nextRequired(seen) !== 'finish') throw new GuardrailError('Insufficient evidence for a verdict (agent tried to finish early)');
      const result = { verdict: verdict(seen), trace: [...trace, { action: 'finish' }] };
      onStep({ action: 'finish', verdict: result.verdict, seen });
      return result;
    }
    if (nextRequired(seen) === 'finish') throw new GuardrailError('Evidence budget exhausted or alert below threshold');
    seen[action] = measure(action, data);
    trace.push({ action, evidence: seen[action] });
    onStep({ action, evidence: seen[action], seen });
  }
  throw new GuardrailError('Tool budget exhausted');
}

/** The exact context the model sees: aggregates and legal actions only, never raw records. */
export function plannerPrompt(seen, remaining) {
  return {
    goal: GOAL,
    tool_descriptions: TOOL_DESCRIPTIONS,
    observations: seen,
    remaining_actions: [...remaining].sort()
  };
}
