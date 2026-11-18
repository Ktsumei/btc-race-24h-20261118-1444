// Capitulation-bounce cbBTC bot for btc-race-24h-20261118-1444 (Node 22, stdlib only).
//
// The published 24h dev window (1,440 one-minute bars of cbBTC/USDC) trends down
// 2.8% overall, and every kit baseline loses on it: buy-and-hold -31.63,
// ema-cross -148.17, rsi-bollinger -39.92 USDC. The 1-minute noise (about 6.7 bps
// per minute) is smaller than a full round trip's cost (~26 bps in fee, slippage
// and pool impact), so frequent trading only bleeds. The one reliable edge in the
// window is the sharp selloff early on and the slow, hours-long recovery that
// follows it. This bot therefore trades rarely, only at a capitulation, and then
// lets the recovery run:
//
//   - Entry (flat only): the close is at least 130 bps below the close 30 minutes
//     ago, or at least 180 bps below the close 60 minutes ago (the second leg
//     catches a slower selloff that never prints a -130 bp half hour). On the dev
//     window the first leg fires once, at the trough of the -2.6% selloff; the
//     second leg fires nowhere there, so it changes nothing on the dev grade and
//     only widens the days the bot can trade on.
//   - Exit: take profit at +220 bps over the entry close, stop loss at -100 bps,
//     or a 720-bar (12h) time stop. A profit lock arms once the position is +150 bps
//     up: it exits if the close falls 80 bps below the running peak, so a recovery
//     that rolls over before the target still banks a gain.
//   - After an exit it waits 60 bars before it may enter again.
//   - Full size (all cash, capped by the weight room), long only, one position.
//
// All decisions are exact BigInt comparisons on the raw price units, so two runs
// on the same bars produce the same orders. No clock, no randomness, no network.
import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars of history the entry rule compares against (fast leg). */
const LOOKBACK_BARS = 30;
/** Bars of history the entry rule compares against (slow leg). */
const LOOKBACK_SLOW_BARS = 60;
/** Entry: close this far (bps) below the close LOOKBACK_BARS ago. */
const DIP_BPS = 130n;
/** Entry: close this far (bps) below the close LOOKBACK_SLOW_BARS ago. */
const DIP_SLOW_BPS = 180n;
/** Take profit, in bps over the entry close. */
const TAKE_PROFIT_BPS = 220n;
/** Stop loss, in bps under the entry close. */
const STOP_LOSS_BPS = 100n;
/** Longest a position is held, in bars. */
const MAX_HOLD_BARS = 720;
/** Profit lock: arms once the position is this far (bps) above its entry close. */
const LOCK_ARM_BPS = 150n;
/** Profit lock: exits when the close falls this far (bps) below the running peak. */
const LOCK_TRAIL_BPS = 80n;
/** Bars to wait after an exit before a new entry. */
const COOLDOWN_BARS = 60;
/** Orders never let a fill run more than 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;

interface Series {
  /** Last LOOKBACK_SLOW_BARS + 1 closes, oldest first, as raw price units. */
  closes: bigint[];
  /** Entry close of the open position, or null when flat. */
  entry: bigint | null;
  /** Bar the position opened on. */
  entryBar: number;
  /** Highest close since the position opened. */
  peak: bigint;
  /** Bar of the last exit, for the cooldown. */
  lastExitBar: number;
}

const series = new Map<string, Series>();

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = { closes: [], entry: null, entryBar: 0, peak: 0n, lastExitBar: -1_000_000 };
    series.set(symbol, s);
  }
  return s;
}

function push(bar: Bar): void {
  const s = getSeries(bar.symbol);
  s.closes.push(BigInt(bar.c));
  if (s.closes.length > LOOKBACK_SLOW_BARS + 1) s.closes.shift();
}

function enter(state: BarsState, symbol: string, s: Series, close: bigint): BuyInput | null {
  if (state.warmingUp) return null;
  if (s.closes.length < LOOKBACK_BARS + 1) return null;
  if (state.seq - s.lastExitBar < COOLDOWN_BARS) return null;
  const ago = s.closes[s.closes.length - 1 - LOOKBACK_BARS];
  const agoSlow = s.closes.length >= LOOKBACK_SLOW_BARS + 1
    ? s.closes[s.closes.length - 1 - LOOKBACK_SLOW_BARS]
    : null;
  // close <= ago * (10000 - DIP_BPS) / 10000, in integers, on either leg.
  const fastDip = close * BPS <= ago * (BPS - DIP_BPS);
  const slowDip = agoSlow !== null && close * BPS <= agoSlow * (BPS - DIP_SLOW_BPS);
  if (!fastDip && !slowDip) return null;
  let amount = state.cash;
  const room = state.weightRoom(symbol);
  if (amount > room) amount = room;
  if (amount < BigInt(state.hello.fees.min_notional_quote_units)) return null;
  s.entry = close;
  s.entryBar = state.seq;
  s.peak = close;
  return { side: 'buy', symbol, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function exit(state: BarsState, symbol: string, s: Series, close: bigint, held: { qty: bigint; cost: bigint }): SellInput | null {
  const entry = s.entry;
  if (entry === null) return null;
  if (close > s.peak) s.peak = close;
  const takeProfit = close * BPS >= entry * (BPS + TAKE_PROFIT_BPS);
  const stopLoss = close * BPS <= entry * (BPS - STOP_LOSS_BPS);
  const timeStop = state.seq - s.entryBar >= MAX_HOLD_BARS;
  const lockArmed = s.peak * BPS >= entry * (BPS + LOCK_ARM_BPS);
  const lockHit = lockArmed && close * BPS <= s.peak * (BPS - LOCK_TRAIL_BPS);
  if (!takeProfit && !stopLoss && !timeStop && !lockHit) return null;
  s.entry = null;
  s.lastExitBar = state.seq;
  return { side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const orders: (BuyInput | SellInput)[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol);
      if (s === undefined) continue;
      const close = state.close(symbol);
      if (close === null) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const sell = exit(state, symbol, s, close, held);
        if (sell !== null) orders.push(sell);
        continue;
      }
      const buy = enter(state, symbol, s, close);
      if (buy !== null) orders.push(buy);
    }
    return orders.slice(0, state.hello.caps.max_orders_per_bar);
  },
});
