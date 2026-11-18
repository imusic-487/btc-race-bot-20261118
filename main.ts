// BTC race bot — core position with one dip-buy and a disaster stop.
//
// A simpler shape than a ladder: take a core position early, add once if it
// dips further, and cut it if it falls hard. The bot never shorts, never
// holds more than one position, and never opens a new position late.
//
// Mechanics (all in the replay's raw units):
// - One asset, CBBTC, quoted in USDC. A bar's close `c` is the price at
//   price_scale 5, so c / 1e5 is USDC per BTC. Cash is USDC raw units
//   (1e6 per USDC). A fill's qty is at qty_scale 8 (1e8 per BTC).
// - Average entry: rebuilt from the fills of the current position.
//   price = notional / qty, and to express it in the close's raw units
//   (scale 1e5) the factor is 1e7:
//     avgEntry = totalNotional * 1e7 / totalQty
//   because (1e8 qty units per BTC) / (1e6 USDC raw per USDC) = 100, and
//   100 * 1e5 (the price scale) = 1e7.
// - Core: at bar sequence 24, buy with 70% of the cash. The early entry
//   gives the position the whole window to work.
// - Dip-buy: holding the core only, and the close has fallen to 1% below
//   the core entry, buy with all the cash that is left. Once only.
// - Disaster stop: holding, and the close has fallen to 2% below the
//   average entry, sell everything. This bounds the loss on a day that
//   only goes down.
// - Take profit: holding, and the close has risen to 2% above the average
//   entry, sell everything and bank the move.
// - End: holding at bar sequence 1380 or later, sell everything rather
//   than leave it to the final flatten.
// - Orders decided on bar k fill at bar k + 1's open, so the bot only ever
//   acts on fills it has already seen.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

const CORE_SEQ = 24; // buy the core position on this bar
const CORE_FRACTION_NUM = 7n; // 70% of the cash
const CORE_FRACTION_DEN = 10n;
const DIP_FACTOR = 0.99; // dip-buy 1% below the core entry
const DISASTER_FACTOR = 0.98; // sell everything 2% below the average entry
const TAKE_PROFIT_FACTOR = 1.02; // sell everything 2% above the average entry
const LAST_ENTRY_SEQ = 1380; // never open a new position after this bar
const MAX_SLIPPAGE_BPS = 100;

// The bot's own state, rebuilt from the batches the harness sends.
interface CoreState {
  coreEntry: number | null; // average entry right after the core buy filled
  dipBought: boolean; // the one dip-buy has been placed and filled
  pendingBuy: boolean; // a buy order is in flight (decided, not yet filled)
  pendingSell: boolean; // a sell order is in flight
  costNotional: bigint; // USDC raw units paid for the current position's fills
  costQty: bigint; // qty-scale units received for the current position's fills
}

const state: CoreState = {
  coreEntry: null,
  dipBought: false,
  pendingBuy: false,
  pendingSell: false,
  costNotional: 0n,
  costQty: 0n,
};

/** Average entry price in the close's raw units, or null with no cost basis. */
function avgEntry(): number | null {
  if (state.costQty === 0n) return null;
  // See the header comment: 1e7 converts notional/qty into price_scale 5.
  return (Number(state.costNotional) * 1e7) / Number(state.costQty);
}

/** Fold this batch's fills into the cost basis and the in-flight flags. */
function applyFills(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.status === 'filled') {
      if (fill.side === 'buy') {
        state.costNotional += BigInt(fill.notional_quote_units);
        state.costQty += BigInt(fill.qty);
        if (fill.client_id.startsWith('core-')) {
          state.coreEntry = avgEntry();
        }
        if (fill.client_id.startsWith('dip-')) state.dipBought = true;
        state.pendingBuy = false;
      } else {
        // The whole position is sold: start clean for the next entry.
        state.costNotional = 0n;
        state.costQty = 0n;
        state.coreEntry = null;
        state.dipBought = false;
        state.pendingSell = false;
      }
    } else {
      // Rejected: the order never happened, so clear the in-flight flag.
      if (fill.side === 'buy') state.pendingBuy = false;
      else state.pendingSell = false;
    }
  }
}

/** Decide this bar's orders. Returns at most one order per bar. */
function decide(s: BarsState, batch: Batch): OrderInput[] {
  const close = s.close(SYMBOL);
  if (close === null) return [];
  const closeNum = Number(close);
  const seq = batch.seq;

  const pos = s.positions.get(SYMBOL);
  const qty = pos ? pos.qty : 0n;
  const holding = qty > 0n;

  if (holding && !state.pendingSell) {
    const entry = avgEntry();
    if (entry !== null) {
      if (closeNum <= entry * DISASTER_FACTOR || closeNum >= entry * TAKE_PROFIT_FACTOR || seq >= LAST_ENTRY_SEQ) {
        state.pendingSell = true;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `x-${seq}` }];
      }
    }
    // One dip-buy: the core is in, it has dipped 1% under where it was
    // bought, and the rest of the cash is still sitting idle.
    if (!state.pendingBuy && !state.dipBought && state.coreEntry !== null && seq <= LAST_ENTRY_SEQ) {
      if (closeNum <= state.coreEntry * DIP_FACTOR) {
        const room = s.weightRoom(SYMBOL);
        const spend = s.cash < room ? s.cash : room;
        if (spend > 0n) {
          state.pendingBuy = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `dip-${seq}` }];
        }
      }
    }
    return [];
  }

  // Flat and it is the core bar: buy the core position with 70% of cash.
  if (!holding && !state.pendingBuy && !state.pendingSell && seq === CORE_SEQ && !s.warmingUp) {
    const desired = (s.cash * CORE_FRACTION_NUM) / CORE_FRACTION_DEN;
    const room = s.weightRoom(SYMBOL);
    const spend = desired < room ? desired : room;
    if (spend > 0n) {
      state.pendingBuy = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `core-${seq}` }];
    }
  }
  return [];
}

await runBars({
  onBatch(s, batch) {
    applyFills(batch);
    return decide(s, batch);
  },
});
