# Changelog

## 1.1.0

- Narrowed discovery to newly created crypto meme liquidity pairs; forex and USD/JPY are explicitly out of scope.
- Default pool-age gate: 15 minutes, with short-interval scanning and price polling.
- Added market-cap, buy-flow, impulse, liquidity and clean-security entry gates.
- Added PAPER hard stop, liquidity-collapse exit, peak-trailing exit and portfolio drawdown breaker.
- Added direct-minted alert thresholds at 15X, 25X, 50X and 101X; large jumps send the highest crossed milestone once rather than spamming each skipped level.
- Added mocked end-to-end coverage for fresh-token discovery, security gating, PAPER position opening, 101X observation and LIVE-mode rejection.
- All prices and returns remain observational/simulated; no trading guarantee or live-order route.
