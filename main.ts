// Rebound Rider — a dip-recovery bot for btc-race-24h-20261118-1444.
//
// Idea, from the dev window's own shape (1,440 one-minute bars of cbBTC):
// the window fell 2.8% overall but its one big move was a V — a ~310 bps
// capitulation in the first ~70 minutes, then a slow ~290 bps grind back
// up over the next ~7 hours. Buying every dip loses here (dips keep
// grinding down: after a -100 bps dip the next 60 bars average -12 bps),
// and chasing momentum loses too (the tape is too choppy). What pays is
// narrow and patient: wait for a deep dip, then buy only once the tape
// itself turns — two rising closes in a row — and bank a fixed target
// before the grind gives it back. Two such legs on the dev window each
// banked just over +100 bps net of costs.
//
// Rules (all integer math, no floats, no clock, no randomness):
//   enter  long, full size, when the close is >= 150 bps below the
//          120-bar high AND the last two closes both rose.
//   exit   all out at +120 bps from the fill price, or when the close
//          falls >= 250 bps below the peak since entry (hard stop).
//   rest   10 bars after an exit before the next entry, so one leg
//          cannot immediately re-buy its own top.
// Long only, at most one position, at most one order per reply.
// A round trip costs ~26-35 bps (4 bps fee + 2 bps slippage + pool
// impact either side), so the +120 bps target clears costs several
// times over; the 250 bps trail caps any single losing leg.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry: dip in bps below the rolling high, and the high's window.
const DIP_BPS = 150n;
const DIP_WINDOW = 120;
// Exit: take-profit and trailing stop, both in bps from fill / peak.
const TAKE_PROFIT_BPS = 120n;
const TRAIL_STOP_BPS = 250n;
// Bars to sit out after an exit before a new entry.
const COOLDOWN_BARS = 10;
// Generous vs the 1-minute moves seen on the dev window (largest
// single-bar move ~64 bps); a fill past this is rejected, not chased.
const MAX_SLIPPAGE_BPS = 100;

const BPS = 10000n;

// Per-run state, kept outside the callbacks so the two graded runs
// each start from the same blank slate.
let closes: bigint[] = [];
let posQty = 0n;
let entryPx = 0n;
let peakPx = 0n;
let cooldownUntil = -1;
let pendingBuy = false;
let pendingSell = false;

await runBars({
  onBatch(state, batch) {
    // Fold in the fills of the orders decided on the previous batch.
    // A buy's fill price is the entry; a sell that empties the position
    // starts the cooldown. A rejection just clears the pending flag.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        if (fill.status === 'filled') {
          posQty += BigInt(fill.qty);
          entryPx = BigInt(fill.price);
          peakPx = entryPx;
        }
        pendingBuy = false;
      } else {
        if (fill.status === 'filled') {
          posQty -= BigInt(fill.qty);
          if (posQty <= 0n) {
            posQty = 0n;
            entryPx = 0n;
            peakPx = 0n;
            cooldownUntil = state.seq + COOLDOWN_BARS;
          }
        }
        pendingSell = false;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);

    if (state.warmingUp) return [];
    if (closes.length < 3) return [];

    if (posQty > 0n) {
      if (close > peakPx) peakPx = close;
      const gainBps = ((close - entryPx) * BPS) / entryPx;
      const trailBps = ((peakPx - close) * BPS) / peakPx;
      if (!pendingSell && (gainBps >= TAKE_PROFIT_BPS || trailBps >= TRAIL_STOP_BPS)) {
        pendingSell = true;
        return [{ side: 'sell', symbol: SYMBOL, qty: posQty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (pendingBuy || state.seq < cooldownUntil) return [];

    // Flat: look for a deep dip that has just turned up.
    const n = closes.length;
    const prev = closes[n - 2]!;
    const prevPrev = closes[n - 3]!;
    if (!(close > prev && prev > prevPrev)) return [];
    let high = closes[n - 1]!;
    const start = Math.max(0, n - DIP_WINDOW);
    for (let i = start; i < n; i++) {
      const c = closes[i]!;
      if (c > high) high = c;
    }
    const dipBps = ((high - close) * BPS) / high;
    if (dipBps < DIP_BPS) return [];

    const cash = state.cash;
    if (cash <= 0n) return [];
    pendingBuy = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
