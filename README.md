# btc-race-bot-3 — dip-buy mean-reversion bot for the make.fun BTC 24h race

[![make.fun competition](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/competitions/btc-race-24h-20261117-0603)
[![make.fun rank](https://make.fun/badge/btc-race-24h-20261117-0603/IlhamEl777/btc-race-bot-3/rank.svg)](https://make.fun/competitions/btc-race-24h-20261117-0603)
[![make.fun reward](https://make.fun/badge/btc-race-24h-20261117-0603/IlhamEl777/btc-race-bot-3/reward.svg)](https://make.fun/competitions/btc-race-24h-20261117-0603)

Entry for `btc-race-24h-20261117-0603` (pool $250, top 10 paid, 1st $60).
Trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars,
long only, starting from $1,000 of paper money.

## Strategy

The bot sits in cash most of the time and only buys a dip, then sells the
bounce:

- **Buy** 100% of cash when the close is **0.80% or more below the rolling
  240-bar high**, after a 45-bar cooldown since the last exit decision.
- **Sell** the whole position at **+1.20% over the entry close**, at **-2.50%
  under it**, or after **240 bars** held — whichever comes first.
- **Drawdown brake:** if equity falls 8% from its peak, liquidate and stop
  trading for the rest of the window (the race bar is 25%).

Why this shape: the published dev window is a flat, choppy day (64,461 →
64,776, +0.49%, range 63,874–65,467). Buy-and-hold makes about +$2.45 on it
and ema-cross loses -$106, so the bot does not ride the trend — it buys
dips and banks the bounces.

Why a 0.80% dip / 240-bar high: the sweep found 3,786 positive
combinations on this window, but the winners concentrate on a few +$9–10
trades. This configuration has the best worst-half (+$6.18 on the weaker
half, +$10.52 on the stronger) of any configuration with PnL above $15,
and stays +$11.88 at 2x fees. Shallower dips (0.50%) score higher on the
full window (+$23–26) but lean on one half (+$20.76 / +$2.35) and on a
single cooldown value; deeper dips (1.00%+) lose money. The plateau is
wide: 681 combinations are positive on both halves separately.

Why +1.20% take-profit: the bounces here run about a percent; +1.20%
banks them before the chop resumes, and it beats +0.80% (+$5.88) and
+0.50% (-$9.79) on this window. The stop-loss almost never fires on dev
(results are identical for -1.60% / -2.50% / -4.00%): exits are the
take-profit or the 240-bar max hold.

Why 100% size: a full-size round trip pays ~26 bps in fees, slippage and
price impact on this thin pool (a $1,000 buy moves its own price ~7 bps),
but the winning moves are ~1%, so full size wins; 80% size scores lower
on every nearby configuration. Parameters were tuned from zero on this
window — the 13 Nov parameters were NOT reused (they failed on the
15 Nov window).

## Grade (official `grade-local --driver process` on the dev window)

| version | net PnL | trades | win rate | max drawdown | dev gate |
|---------|--------:|-------:|---------:|-------------:|----------|
| v1 (L=240, dip 0.80%, tp +1.20%, sl -2.50%, size 100%, cooldown 45) | **+$15.91** | 10 | 0.60 | 1.63% | **PASS** |

Official `grade-local --driver process` result: net PnL **+15.914664 USDC**,
10 trades, win rate 0.600, max drawdown 0.0163, 0 rejected, guardrails met;
fees $4.02, net PnL at 2x fees +$11.88. Two executions reproduced byte for
byte (deterministic: identical result_sha256 and action_log_sha256 across
two separate grade-local runs). The local simulator predicted +$15.92
exactly.

Baselines on the same window (official `grade-local --driver process`):
momentum +$2.45 (1 trade), ema-cross -$106.21 (68 trades).

Robustness of v1 (local simulator, fresh strategy instance per window):

| window | net PnL |
|--------|--------:|
| full dev (1,440 bars) | +$15.92 |
| first half (720 bars) | +$10.52 |
| second half (720 bars) | +$6.18 |

Positive on the full window and on each half — the edge is not one stretch
of the day.

## Layout

- `main.ts` — the bot (TypeScript, Node 22 type-stripping, stdlib only).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's TS SDK shim
  (excluded from authorship counts per the rules).

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```
