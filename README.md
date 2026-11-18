# BTC Race Bot — Core with Dip-Buy and Disaster Stop

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/imusic-487/btc-race-bot-20261118/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/imusic-487/btc-race-bot-20261118/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

An entry for [make.fun](https://make.fun/bounty/btc-race-24h-20261118-1444)'s "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261118-1444). The bot trades Coinbase Wrapped BTC (cbBTC) against USDC, one minute at a time, starting with $1,000 of paper money.

## The strategy

Take a core position early, add once if it dips, and cut it if it falls hard.

- **Core:** at bar sequence 24, buy with 70% of the cash. The early entry gives the position the whole window to work.
- **Dip-buy:** holding the core only, and the close has fallen to 1% below the core entry, buy with all the cash that is left. Once only.
- **Disaster stop:** holding, and the close has fallen to 2% below the average entry, sell everything. This bounds the loss on a day that only goes down.
- **Take profit:** holding, and the close has risen to 2% above the average entry, sell everything and bank the move.
- **End:** holding at bar sequence 1380 or later, sell everything rather than leave it to the final flatten.

The average entry price is rebuilt from the fills the bot actually received (total notional paid / total units received), not from where it intended to buy — fills land at the next bar's open, after fees, slippage and price impact.

## Why this shape

A single core with a hard stop loses little on a grind-down day and catches a full recovery if one comes. It trades rarely (3 fills on the dev window), so fees stay small. The alternative tried here, an EMA dip ladder that buys every small dip, traded 11 times on the same window and lost slightly more — the ladder only wins on days that bounce or range, and this dev window mostly ground down.

## Dev grades (official `grade-local`, process driver)

The dev window runs $65,083 → $63,261 (−2.80%), a grind down with a largest bounce of +1.73%. Both strategies below were graded on it; the gate needs net PnL above $0.

- **EMA dip ladder** (first version): net PnL **−$10.19**, 11 trades, win rate 0.25, max drawdown 2.95%, fees $2.77.
- **Core + dip-buy + disaster stop** (this version, kept): net PnL **−$9.77**, 3 trades, win rate 0.00, max drawdown 2.15%, fees $0.80.

Neither passes the dev gate on this window, so this entry as it stands would not race. The core is kept because it loses the least and trades the least; the race window itself is a different, unseen 24 hours.

## Files

- `main.ts` — the bot (Node 22, TypeScript, standard library only). It speaks the `agent-fun/bars-replay/v1` protocol through the vendored shim.
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte-identical (exempt from the authorship gate).
- `README.md` — this file. `LICENSE` — MIT.
