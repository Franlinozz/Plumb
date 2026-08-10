/**
 * Signal rationale — the Claude call P2 designed the interface for.
 *
 * ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GUARDRAIL 4. THE MODEL RETURNS PROSE. It never returns a number that reaches a signal.      │
 * │                                                                                             │
 * │ The signal is FROZEN before generation and the rationale is written to the FEED, never back  │
 * │ onto the signal object. `generateRationale` takes an already-frozen `Signal` and returns a   │
 * │ string; there is no path by which its output can mutate the thing it describes.              │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * If the model is unavailable, slow, or returns anything unparseable, a deterministic template
 * fires instead. A subscriber always gets an explanation; it is simply a plainer one.
 */

import type { Signal } from '@plumb/core';
import { z } from 'zod';

export interface RationaleDeps {
  /** Injected so tests never call a provider. Returns the model's raw text. */
  readonly complete?: (prompt: string, system: string) => Promise<string>;
  readonly apiKey?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxWords?: number;
}

export interface RationaleResult {
  readonly text: string;
  readonly source: 'model' | 'template';
  /** Present when the model was tried and rejected — the reason it fell back. */
  readonly fallbackReason?: string;
}

const ResponseSchema = z.object({
  rationale: z.string().min(20).max(1_200),
});

const SYSTEM = [
  'You write two or three plain sentences explaining why a trading signal fired, for a subscriber',
  'who is not a quant. You are given the exact indicator readings that triggered it.',
  '',
  'RULES, absolute:',
  '- Return ONLY JSON: {"rationale": "..."}',
  '- PROSE ONLY. Do not invent, restate, or introduce ANY number — not a price, not a size, not a',
  '  level, not a percentage. Describe the situation in words.',
  '- Do not predict. Do not promise. Do not give advice. Say what the indicators showed.',
  '- Never imply certainty. This is one signal among many and most individual signals lose.',
].join('\n');

/**
 * The deterministic fallback.
 *
 * Deliberately readable rather than terse: it is what a subscriber sees whenever the model is
 * down, so it cannot be a placeholder.
 */
export function templateRationale(signal: Signal): string {
  const direction = signal.side === 'long' ? 'upward' : 'downward';
  const regime = signal.regime.replace(/_/g, ' ');
  const asset = signal.instId.split('-')[0] ?? signal.instId;

  const byStrategy: Record<string, string> = {
    trend_ema: `the shorter moving average crossed the longer one in the ${direction} direction while the trend filter agreed`,
    revert_band: `price reached the edge of its recent range in a market the classifier reads as quiet, and the setup fades that stretch`,
    breakout_range: `price closed decisively outside the range it had been holding, measured against current volatility`,
    vol_expansion: `volatility had compressed into the low end of its recent history and price then broke out of that compression`,
    oi_divergence: `the move came with new positioning entering rather than existing positions closing`,
    session_bias: `this is a measured intraday window rather than a chart pattern`,
    funding_skew: `funding sat at an extreme against its own history, which points away from the crowded side`,
  };
  const because = byStrategy[signal.strategyId] ?? 'the strategy\'s entry conditions were met';

  return (
    `A ${signal.side} signal on ${asset} perpetuals: ${because}. ` +
    `The market is currently classified as ${regime} on the ${signal.timeframe} timeframe. ` +
    `The protective stop is set before the position opens and the trade is abandoned if it has not ` +
    `resolved within ${signal.invalidation.maxHoldBars} bars. One signal is not a forecast — most ` +
    `individual signals lose, and the record is published either way.`
  );
}

/** Numbers the model must not have introduced. */
export function containsForeignNumber(prose: string, signal: Signal): boolean {
  const sanctioned = new Set<string>();
  const add = (v: number): void => {
    sanctioned.add(v.toFixed(0));
    sanctioned.add(v.toFixed(1));
    sanctioned.add(v.toFixed(2));
  };
  for (const v of Object.values(signal.inputs)) add(v);
  add(signal.stop.price);
  add(signal.invalidation.maxHoldBars);
  if (signal.entry.price !== undefined) add(signal.entry.price);
  for (const tp of signal.takeProfit ?? []) {
    add(tp.price);
    add(tp.rMultiple);
  }

  for (const match of prose.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const raw = (match[0] ?? '').replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    // Small integers are ordinary prose ("two of three conditions"); anything else must be
    // traceable to the signal itself.
    if (value <= 10 && Number.isInteger(value)) continue;
    if (!sanctioned.has(value.toFixed(0)) && !sanctioned.has(value.toFixed(1)) && !sanctioned.has(value.toFixed(2))) {
      return true;
    }
  }
  return false;
}

export function buildPrompt(signal: Signal, maxWords: number): string {
  const inputs = Object.entries(signal.inputs)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return [
    `Instrument: ${signal.instId}`,
    `Direction: ${signal.side}`,
    `Timeframe: ${signal.timeframe}`,
    `Market regime: ${signal.regime}`,
    `Strategy: ${signal.strategyId} v${signal.version}`,
    `Invalidation conditions: ${signal.invalidation.conditions.join('; ')}`,
    '',
    'Indicator readings that fired it:',
    inputs,
    '',
    `Write at most ${maxWords} words. Return only {"rationale": "..."}.`,
  ].join('\n');
}

/**
 * Generate the rationale.
 *
 * `signal` is expected to be frozen; the return value is a STRING that the caller writes to the
 * feed. Nothing here can reach back into the signal.
 */
export async function generateRationale(
  signal: Signal,
  deps: RationaleDeps = {},
): Promise<RationaleResult> {
  const maxWords = deps.maxWords ?? 90;
  const complete = deps.complete ?? (deps.apiKey === undefined ? undefined : anthropicCompletion(deps));

  if (complete === undefined) {
    return { text: templateRationale(signal), source: 'template', fallbackReason: 'no model configured' };
  }

  let raw: string;
  try {
    raw = await complete(buildPrompt(signal, maxWords), SYSTEM);
  } catch (error) {
    return {
      text: templateRationale(signal),
      source: 'template',
      fallbackReason: `model unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: { rationale: string };
  try {
    const json = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    parsed = ResponseSchema.parse(JSON.parse(json));
  } catch {
    return { text: templateRationale(signal), source: 'template', fallbackReason: 'unparseable model response' };
  }

  if (containsForeignNumber(parsed.rationale, signal)) {
    // The model introduced a figure that is not in the signal. That is exactly the failure
    // guardrail 4 exists to prevent, so the response is discarded rather than cleaned up.
    return {
      text: templateRationale(signal),
      source: 'template',
      fallbackReason: 'model introduced a number not present in the signal',
    };
  }

  return { text: parsed.rationale.trim(), source: 'model' };
}

/** Raw-fetch Anthropic client. No SDK — one endpoint, one shape. */
function anthropicCompletion(deps: RationaleDeps) {
  return async (prompt: string, system: string): Promise<string> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': deps.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: deps.model ?? 'claude-sonnet-5',
          max_tokens: 400,
          system,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { content?: Array<{ text?: string }> };
      return body.content?.[0]?.text ?? '';
    } finally {
      clearTimeout(timer);
    }
  };
}
