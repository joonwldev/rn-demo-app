# rn-demo-app

## Overview
This Expo SDK 53 / React Native 0.79 demo streams real-time trade ticks from the Finnhub WebSocket API and showcases how to combine live market data with persistent storage. The app caches the latest updates for each subscribed symbol in `expo-sqlite`, reconnects gracefully, and keeps data available offline when you relaunch.

## Features
- **Live trade feed** – Connects to Finnhub’s websocket, subscribes to any ticker (equities or crypto), and displays the latest 20 trades in a styled FlatList.
- **Symbol management** – Quick chips plus manual entry let you swap subscriptions on the fly while rehydrating cached trades instantly.
- **SQLite persistence** – Stores recent trades per symbol along with history browsing via a modal grouped by ticker.
- **Analytics** – Inline metrics (last price, change, change %) and an SVG sparkline with min/max legend give a fast read on short-term movement.
- **Alerts** – Configure above/below price triggers, receive local notifications when thresholds hit, and manage active or triggered alerts.
- **Resilient transport** – Handles reconnects, ping frames, and token validation with simple status messaging.

## Getting Started
1. **Install dependencies**
   ```bash
   npm install
   npx expo install expo-sqlite expo-notifications react-native-svg
   ```
2. **Configure Finnhub**
   - Copy `.env.example` to `.env` and paste your API key as `EXPO_PUBLIC_FINNHUB_TOKEN=...`.
   - Expo automatically inlines `EXPO_PUBLIC_*` variables at build time; the app will stay in an error state until the token is provided.
   - Free keys stream limited symbols (IEX for equities) – use `BINANCE:BTCUSDT` for off-hours testing.
3. **Start the app**
   ```bash
   npx expo start --ios   # or --android / --web
   ```
4. **Grant permissions**
   - On first run, accept notification prompts so alerts can fire.
5. **Usage tips**
   - Use the quick symbol chips or enter tickers manually.
   - Tap “View History” to inspect cached trades.
   - Configure price alerts from the Alerts card; triggered thresholds cross out automatically.
