# KAMAL AI Moonshot Hunter (Local PAPER)

Arabic-first local meme-token radar and paper-trading simulator. Runs on Node.js on your own computer; it does not use Cloudflare, Wrangler, a cloud database, or runtime npm packages.

> **PAPER only.** No wallet connection, private keys, transaction signing, or real orders. A 15X threshold is an observed price multiple from first signal, not a USD/JPY target, forecast, or promised return.

## Quick start

Requirements: Node.js 20 or newer, plus internet access for public market/security feeds.

```sh
node server.mjs
```

Open `http://127.0.0.1:8787`. Windows users can double-click `start-local.bat`; macOS/Linux users can run `./start-local.sh`. No `npm install` is needed. The process must stay running, and the computer must remain awake, for discovery, price tracking, and Telegram alerts to continue.
The launch scripts check the Node.js version and create `.env` from `.env.example` when missing.

Optional local settings:

```sh
cp .env.example .env
# edit .env, then restart the service
```

To receive Telegram alerts, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. Keep that file private. The dashboard has a Telegram status check, bot link (when available), and a test-message button.
For BotFather, chat ID, local configuration, and VPS secret-file steps, see [TELEGRAM_SETUP_AR.md](TELEGRAM_SETUP_AR.md).

## What it does

- Discovers newly created crypto meme-token liquidity pairs from DEX Screener and GeckoTerminal only; scans forex and USD/JPY are out of scope.
- Runs the scanner cycle roughly every 15 seconds, but throttles GeckoTerminal new-pool requests to at most once per network per minute by default. HTTP 429 responses trigger a persisted per-provider exponential cooldown across endpoints and honor `Retry-After` up to 15 minutes; provider limits or outages can still miss launches.
- Scores liquidity, pair age, recent volume, buy/sell flow, and price movement.
- Checks selected contracts with RugCheck (Solana) or GoPlus (supported EVM chains). Unknown or cautionary results do not pass the default strict verification gate.
- Rejects entries by default if the liquidity pair is older than 15 minutes, market cap/FDV is missing or above the cap, liquidity/buy-transaction share is weak, security is not cleanly checked, or the price has already over-extended.
- Records first signal and candidate price history locally for up to seven days, tracks missed runners, and reports price multiples relative to first observation separately from realized PAPER P&L.
- The headline 10,000% target is **101X before costs**. Telegram can alert at observed 15X, 25X, 50X, and 101X; this is after-the-fact monitoring, not forecasting or a guaranteed holding return.
- Maintains PAPER positions, polls prices about every 15 seconds, and applies an 18% entry stop, liquidity-collapse exit, 22% peak-trailing exit after 1.5X, and portfolio drawdown breaker by default. These simulation rules cannot guarantee a real exit before a token collapses.
- Stores state under `data/state.json`. This directory is ignored by Git.

Public data providers can rate-limit, fail, or return stale/incomplete values. The scanner limits requests and rejects extreme price jumps, but neither provider checks nor PAPER execution prove a token is safe or a trade fill is achievable.

## Configuration

See `.env.example` for scanner thresholds and optional Telegram credentials. The service binds to `127.0.0.1` only; remote network binding is intentionally unsupported. Do not expose it to the public internet. An admin token does not provide HTTPS or a production security boundary. See [SECURITY.md](SECURITY.md).

## Always-on VPS

For a machine-independent 24/7 scanner, deploy to a VPS with internet access. The included [Arabic VPS guide](VPS_SETUP_AR.md) configures systemd, Caddy HTTPS, a strict public-origin check, and loopback-only Node binding. The market and Telegram feeds still require the VPS to have internet; never expose port 8787 directly.

## Android companion

Android Studio source is in `android-app/`. The phone app securely opens the deployed HTTPS VPS dashboard; 24/7 scanning and Telegram remain on the VPS, not the phone. See [android-app/README_AR.md](android-app/README_AR.md). Build the APK with Android Studio and SDK 35.

## Development

```sh
node --check server.mjs
npm test
```

The project has no runtime dependencies. GitHub Actions runs the checks on Node.js 20 and 22. The end-to-end scanner test uses mocked public feeds and a fake Telegram Bot API response; it validates routing and logic without making live trades or sending real messages.

Arabic guide: [README_AR.md](README_AR.md).
Before trusting any performance claims, use the staged [PAPER validation plan](VALIDATION_PLAN_AR.md).
