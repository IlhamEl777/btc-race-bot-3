// Dip-buy mean-reversion bot for make.fun's BTC 24h race (btc-race-24h-20261117-0603).
//
// Market: cbBTC/USDC on 1-minute on-chain bars, long only, $1,000 paper
// cash, cash earns nothing. The published dev window is a flat, choppy
// day (64,461 -> 64,776 USDC, +0.49%, range 63,874-65,467): buy-and-hold
// makes about +$2.45 and ema-cross loses -$106, so the bot stays in cash
// and only buys a dip below the rolling high, then banks the bounce.
//
// Shape (parameters tuned from zero on THIS dev window with a local
// simulator replicating the kit harness fill model exactly, then checked
// for robustness on each half of the window separately — positive on
// both; the 13 Nov parameters were NOT reused, they failed on the 15 Nov
// window):
//   - Buy 100% of cash when the close is 0.80% or more below the rolling
//     240-bar high, after a 45-bar cooldown since the last exit decision.
//   - Sell the whole position at +1.20% over the entry close, at -2.50%
//     under it, or after 240 bars held, whichever comes first.
//   - At most one open position; at most one order per reply.
//   - Drawdown brake: if equity falls 8% from its peak, liquidate once
//     and stop trading for the rest of the window (never triggered on dev:
//     max drawdown 1.63%; the race bar is 25%).
//   - max_slippage_bps 300: the largest 1-minute move in the dev window is
//     well under 1%, so a fill at the next open is never rejected for it.
//
// Why 0.80% dip / 240-bar high: the sweep found 3,786 positive
// combinations on this window, but the winners concentrate on a few
// +$9-10 trades; this configuration has the best worst-half (+$6.18 on
// the weaker half, +$10.52 on the stronger) of any configuration with
// PnL above $15, and stays +$11.88 at 2x fees. Shallower dips (0.50%)
// score higher on the full window (+$23-26) but lean on one half
// (+$20.76 / +$2.35) and on a single cooldown value; deeper dips
// (1.00%+) lose money. The plateau is wide: 681 combinations are
// positive on both halves.
//
// Why +1.20% take-profit: the bounces here run about a percent; +1.20%
// banks them before the chop resumes, and it beats +0.80% (+$5.88) and
// +0.50% (-$9.79) on this window. The stop-loss almost never fires on
// dev (results are identical for -1.60% / -2.50% / -4.00%): exits are
// the take-profit or the 240-bar max hold.
//
// Why 100% size: a full-size round trip pays ~26 bps in fees, slippage
// and price impact on this thin pool (a $1,000 buy moves its own price
// ~7 bps), but the winning moves are ~1%, so full size wins; 80% size
// scores lower on every nearby configuration.
//
// Official grade-local (--driver process) on the dev window: net PnL
// +15.914664 USDC, 10 trades, win rate 0.60, max drawdown 1.63%,
// 0 rejected, net PnL at 2x fees +$11.88; dev gate PASS. Two runs
// reproduced byte for byte (identical result_sha256). The local
// simulator predicted +$15.92 exactly. Baselines on the same window:
// momentum +$2.45 (1 trade), ema-cross -$106.21 (68 trades).
//
// Deterministic: every decision is a pure function of the closes seen so
// far; no clock, no environment, no randomness. The entry price recorded
// here is the decision close; fills happen at the next bar's open, so
// the realised entry differs by one bar of drift — the local simulator
// models exactly that.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const BPS = 10_000n;
const SYMBOL = 'CBBTC';

const LOOKBACK_BARS = 240; // rolling-high window, in bars
const DIP_BPS = 80; // buy at 0.80% below the rolling high
const TAKE_PROFIT_BPS = 120; // sell at +1.20% over the entry close
const STOP_LOSS_BPS = 250; // sell at -2.50% under the entry close
const MAX_HOLD_BARS = 240; // sell after 240 minutes held, whatever the price
const COOLDOWN_BARS = 45; // bars to wait after an exit decision before re-entering
const DRAWDOWN_BRAKE_BPS = 800; // halt if equity is 8% under its peak
const MAX_SLIPPAGE_BPS = 300;

/** Closes seen so far, in price units (close / 10^price_scale USDC). */
const closes: bigint[] = [];
let entryClose: bigint | null = null;
let entrySeq = -1;
let lastExitSeq = -1_000_000;
let peakEquity = 0n;
let halted = false;

/** Highest close of the previous LOOKBACK_BARS bars, excluding the latest one. */
function rollingHigh(): bigint | null {
  let high: bigint | null = null;
  const start = closes.length - LOOKBACK_BARS - 1;
  for (let i = start < 0 ? 0 : start; i < closes.length - 1; i++) {
    const c = closes[i]!;
    if (high === null || c > high) high = c;
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);

    // Drawdown brake: mark equity at this close, halt on an 8% drawdown.
    if (state.equity > peakEquity) peakEquity = state.equity;
    const drawdownBps = ((peakEquity - state.equity) * BPS) / peakEquity;
    if (!halted && drawdownBps >= DRAWDOWN_BRAKE_BPS) {
      halted = true;
      const pos = state.positions.get(SYMBOL);
      if (pos !== undefined) {
        lastExitSeq = batch.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (halted) return [];

    const pos = state.positions.get(SYMBOL);
    if (pos === undefined) {
      if (batch.seq - lastExitSeq < COOLDOWN_BARS) return [];
      const high = rollingHigh();
      if (high === null) return [];
      // Dip in bps, exact integer math: (high - close) * 10000 / high.
      const dipBps = ((high - close) * BPS) / high;
      if (dipBps < DIP_BPS) return [];
      const notional = state.cash;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      // Record the decision close as the entry close now: the fill lands
      // at the next bar's open, but every later exit decision is measured
      // against this close, exactly as the local simulator does.
      entryClose = close;
      entrySeq = batch.seq;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Holding: exit on take-profit, stop-loss or max hold, measured
    // against the decision close at which the position was entered.
    if (entryClose === null) {
      // A position with no recorded entry (cannot happen on a fresh run:
      // every buy sets entryClose above); never sell blind.
      return [];
    }
    const gainBps = ((close - entryClose) * BPS) / entryClose;
    if (
      gainBps >= TAKE_PROFIT_BPS ||
      gainBps <= -STOP_LOSS_BPS ||
      batch.seq - entrySeq >= MAX_HOLD_BARS
    ) {
      lastExitSeq = batch.seq;
      entryClose = null;
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
