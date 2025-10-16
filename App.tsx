import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  SectionList,
  SectionListData,
  SectionListRenderItemInfo,
  StyleSheet,
  Text,
  TextInput,
  View,
  LogBox,
} from 'react-native';
import { openDatabaseAsync, SQLiteDatabase } from 'expo-sqlite';
import * as Notifications from 'expo-notifications';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Polyline, Stop } from 'react-native-svg';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Suppress Expo Go warning about deprecated remote pushes; we only use local notifications.
LogBox.ignoreLogs([
  'expo-notifications: Android Push notifications (remote notifications) functionality provided by expo-notifications was removed from Expo Go with the release of SDK 53. Use a development build instead of Expo Go. Read more at https://docs.expo.dev/develop/development-builds/introduction/.',
]);

type PriceUpdate = {
  key: string;
  symbol: string;
  price: number;
  timestamp: number;
};

type HistoryEntry = {
  key: string;
  symbol: string;
  price: number;
  timestamp: number;
};

type HistorySection = {
  title: string;
  data: HistoryEntry[];
};

type AlertThreshold = {
  id: string;
  symbol: string;
  direction: 'above' | 'below';
  price: number;
  triggered: boolean;
};

const FINNHUB_TOKEN = (process.env.EXPO_PUBLIC_FINNHUB_TOKEN ?? '').trim();
const DEFAULT_SYMBOL = 'AAPL';
const QUICK_SYMBOLS = ['AAPL', 'TSLA', 'BINANCE:BTCUSDT'];
const MAX_ITEMS = 20;
const DB_MAX_ITEMS = 60;
const ALERT_MAX_ITEMS = 20;
const DB_NAME = 'priceUpdates.db';

const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid date';
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

// Reduce the buffered price updates into simple analytics for the header.
const computeMetrics = (entries: PriceUpdate[]) => {
  if (!entries.length) {
    return { change: 0, percentage: 0, basis: null as number | null, latest: null as number | null };
  }
  const latest = entries[0].price;
  const oldest = entries[entries.length - 1].price;
  const change = latest - oldest;
  const percentage = oldest !== 0 ? (change / oldest) * 100 : 0;
  return {
    change,
    percentage,
    basis: oldest,
    latest,
  };
};

// Prepare sparkline data points from the cached trades.
const computeSparklinePoints = (entries: PriceUpdate[]) => {
  if (entries.length < 2) {
    return { points: [] as Array<{ key: number; price: number; normalized: number }>, min: null as number | null, max: null as number | null };
  }

  const chronological = [...entries].reverse();
  const prices = chronological.map(item => item.price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const range = max - min || 1;

  return {
    points: chronological.map(item => ({
      key: item.timestamp,
      price: item.price,
      normalized: (item.price - min) / range,
    })),
    min,
    max,
  };
};

export default function App(): JSX.Element {
  const [activeSymbol, setActiveSymbol] = useState(DEFAULT_SYMBOL);
  const [symbolInput, setSymbolInput] = useState(DEFAULT_SYMBOL);
  const [updates, setUpdates] = useState<PriceUpdate[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [freshTimestamp, setFreshTimestamp] = useState<number | null>(null);
  const [isDbReady, setIsDbReady] = useState(false);
  const [isUsMarketOpen, setIsUsMarketOpen] = useState<boolean | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historySections, setHistorySections] = useState<HistorySection[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertThreshold[]>([]);
  const [alertModalVisible, setAlertModalVisible] = useState(false);
  const [alertDirection, setAlertDirection] = useState<'above' | 'below'>('above');
  const [alertPriceText, setAlertPriceText] = useState('');
  const [alertError, setAlertError] = useState<string | null>(null);
  const [notificationAllowed, setNotificationAllowed] = useState(false);
  const hasToken = FINNHUB_TOKEN.length > 0;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dbRef = useRef<SQLiteDatabase | null>(null);

  useEffect(() => {
    const ensurePermissionsAsync = async () => {
      try {
        const settings = await Notifications.getPermissionsAsync();
        if (settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
          setNotificationAllowed(true);
          if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync('price-alerts', {
              name: 'Price Alerts',
              importance: Notifications.AndroidImportance.DEFAULT,
            });
          }
          return;
        }
        const request = await Notifications.requestPermissionsAsync();
        const granted = request.granted || request.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
        setNotificationAllowed(granted);
        if (granted && Platform.OS === 'android') {
          await Notifications.setNotificationChannelAsync('price-alerts', {
            name: 'Price Alerts',
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }
      } catch (err) {
        console.warn('Notification permission error', err);
      }
    };

    void ensurePermissionsAsync();
  }, []);

  useEffect(() => {
    const updateMarketStatus = () => {
      const now = new Date();
      const day = now.getUTCDay();
      const hour = now.getUTCHours();
      const minute = now.getUTCMinutes();

      // US regular market hours: 9:30 AM - 4:00 PM ET => 14:30 - 21:00 UTC (approx, ignoring DST).
      const minutesOfDay = hour * 60 + minute;
      const openMinutes = 14 * 60 + 30;
      const closeMinutes = 21 * 60;

      const weekday = day >= 1 && day <= 5;
      const open = weekday && minutesOfDay >= openMinutes && minutesOfDay <= closeMinutes;
      setIsUsMarketOpen(open);
    };

    updateMarketStatus();
    const timer = setInterval(updateMarketStatus, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // Replay the most recent trades for a symbol from SQLite when the app boots or the user switches symbols.
  const loadCachedUpdates = useCallback(async (symbol: string) => {
    const db = dbRef.current;
    if (!db) {
      return;
    }

    try {
      const rows = await db.getAllAsync(
        `SELECT symbol, price, timestamp FROM price_updates WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?;`,
        [symbol, MAX_ITEMS]
      );

      const loaded: PriceUpdate[] = rows.map((row, index) => {
        const symbolValue = typeof row.symbol === 'string' ? row.symbol : String(row.symbol ?? '');
        const priceValue = typeof row.price === 'number' ? row.price : Number(row.price);
        const timestampValue = typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp);
        return {
          key: `${symbolValue}-${timestampValue}-${index}`,
          symbol: symbolValue,
          price: Number.isNaN(priceValue) ? 0 : priceValue,
          timestamp: Number.isNaN(timestampValue) ? Date.now() : timestampValue,
        };
      });

      setUpdates(loaded);
      setFreshTimestamp(null);
      setErrorMessage(null);
    } catch (err) {
      console.warn('SQLite read error', err);
      setErrorMessage('Failed to load cached data.');
    }
  }, []);

  // Pull the stored alert thresholds for the active symbol.
  const loadAlerts = useCallback(async (symbol: string) => {
    const db = dbRef.current;
    if (!db) {
      setAlerts([]);
      return;
    }
    try {
      const rows = await db.getAllAsync(
        `SELECT id, symbol, direction, price, triggered
         FROM price_alerts
         WHERE symbol = ?
         ORDER BY triggered ASC, price ASC
         LIMIT ?;`,
        [symbol, ALERT_MAX_ITEMS]
      );
      const nextAlerts: AlertThreshold[] = rows.map(row => ({
        id: String(row.id),
        symbol: typeof row.symbol === 'string' ? row.symbol : String(row.symbol ?? ''),
        direction: row.direction === 'below' ? 'below' : 'above',
        price: typeof row.price === 'number' ? row.price : Number(row.price),
        triggered: row.triggered === 1,
      }));
      setAlerts(nextAlerts);
    } catch (err) {
      console.warn('SQLite alerts load error', err);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const db = dbRef.current;
    if (!db) {
      setHistorySections([]);
      setHistoryLoading(false);
      setHistoryError('History unavailable until storage initializes.');
      return;
    }

    try {
      const rows = await db.getAllAsync(
        `SELECT symbol, price, timestamp FROM price_updates ORDER BY symbol ASC, timestamp DESC;`
      );

      const grouped = new Map<string, HistoryEntry[]>();

      rows.forEach((row, index) => {
        const symbolValue = typeof row.symbol === 'string' ? row.symbol : String(row.symbol ?? '');
        const priceValue = typeof row.price === 'number' ? row.price : Number(row.price);
        const timestampValue = typeof row.timestamp === 'number' ? row.timestamp : Number(row.timestamp);
        const entry: HistoryEntry = {
          key: `${symbolValue}-${timestampValue}-${index}`,
          symbol: symbolValue,
          price: Number.isNaN(priceValue) ? 0 : priceValue,
          timestamp: Number.isNaN(timestampValue) ? Date.now() : timestampValue,
        };

        if (!grouped.has(symbolValue)) {
          grouped.set(symbolValue, []);
        }
        grouped.get(symbolValue)?.push(entry);
      });

      const sortedSymbols = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
      sortedSymbols.sort((a, b) => {
        if (a === activeSymbol) {
          return -1;
        }
        if (b === activeSymbol) {
          return 1;
        }
        return a.localeCompare(b);
      });

      const sections: HistorySection[] = sortedSymbols.map(symbol => ({
        title: symbol,
        data: grouped.get(symbol) ?? [],
      }));

      setHistorySections(sections);
      setHistoryError(sections.length ? null : 'No cached history yet.');
    } catch (err) {
      console.warn('SQLite history load error', err);
      setHistoryError('Failed to load history.');
      setHistorySections([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [activeSymbol]);

  // Write the newest trade to SQLite and prune the table so we only keep a capped history per symbol.
  const persistUpdate = useCallback(async (update: PriceUpdate) => {
    const db = dbRef.current;
    if (!db) {
      return;
    }

    try {
      await db.runAsync(
        `INSERT INTO price_updates (symbol, price, timestamp) VALUES (?, ?, ?);`,
        [update.symbol, update.price, update.timestamp]
      );
      await db.runAsync(
        `DELETE FROM price_updates
         WHERE symbol = ?
           AND id NOT IN (
             SELECT id FROM price_updates
             WHERE symbol = ?
             ORDER BY timestamp DESC
             LIMIT ?
           );`,
        [update.symbol, update.symbol, DB_MAX_ITEMS]
      );
    } catch (err) {
      console.warn('SQLite write error', err);
    }
  }, []);

  // Evaluate stored alerts against the latest trade and dispatch local notifications.
  const checkAlertsForUpdate = useCallback(
    async (update: PriceUpdate) => {
      const db = dbRef.current;
      if (!db) {
        return;
      }

      try {
        const rows = await db.getAllAsync(
          `SELECT id, direction, price FROM price_alerts WHERE symbol = ? AND triggered = 0;`,
          [update.symbol]
        );

        if (!rows.length) {
          return;
        }

        const triggeredIds: number[] = [];
        await Promise.all(
          rows.map(async row => {
            const direction = row.direction === 'below' ? 'below' : 'above';
            const priceValue = typeof row.price === 'number' ? row.price : Number(row.price);
            if (Number.isNaN(priceValue)) {
              return;
            }

            const isTriggered =
              (direction === 'above' && update.price >= priceValue) ||
              (direction === 'below' && update.price <= priceValue);

            if (!isTriggered) {
              return;
            }

            triggeredIds.push(row.id);

            if (notificationAllowed) {
              try {
                await Notifications.scheduleNotificationAsync({
                  content: {
                    title: `${update.symbol} price alert`,
                    body:
                      direction === 'above'
                        ? `Price moved above ${priceValue.toFixed(2)} (now ${update.price.toFixed(2)}).`
                        : `Price fell below ${priceValue.toFixed(2)} (now ${update.price.toFixed(2)}).`,
                    channelId: Platform.OS === 'android' ? 'price-alerts' : undefined,
                  },
                  trigger: null,
                });
              } catch (err) {
                console.warn('Notification scheduling error', err);
              }
            }
          })
        );

        if (triggeredIds.length) {
          const placeholders = triggeredIds.map(() => '?').join(', ');
          await db.runAsync(
            `UPDATE price_alerts SET triggered = 1 WHERE id IN (${placeholders});`,
            triggeredIds
          );
          await loadAlerts(update.symbol);
        }
      } catch (err) {
        console.warn('Alert evaluation error', err);
      }
    },
    [loadAlerts, notificationAllowed]
  );

  const persistAndCheckUpdate = useCallback(
    async (update: PriceUpdate) => {
      await persistUpdate(update);
      await checkAlertsForUpdate(update);
    },
    [checkAlertsForUpdate, persistUpdate]
  );

  // Normalize user input and trigger a subscription switch.
  const applySymbol = useCallback(
    (rawSymbol: string) => {
      const normalized = rawSymbol.trim().toUpperCase();
      if (!normalized) {
        setErrorMessage('Enter a symbol to subscribe.');
        return;
      }

      setSymbolInput(normalized);
      setErrorMessage(null);

      if (normalized === activeSymbol) {
        return;
      }

      setActiveSymbol(normalized);
      setUpdates([]);
      setFreshTimestamp(null);
      setErrorMessage(null);
    },
    [activeSymbol]
  );

  const handleApplySymbol = useCallback(() => {
    applySymbol(symbolInput);
  }, [applySymbol, symbolInput]);

  const handleQuickSelect = useCallback(
    (ticker: string) => {
      applySymbol(ticker);
    },
    [applySymbol]
  );

  const handleOpenAlertModal = useCallback(() => {
    const latestPrice = updates[0]?.price;
    setAlertPriceText(latestPrice ? latestPrice.toFixed(2) : '');
    setAlertDirection('above');
    setAlertError(null);
    setAlertModalVisible(true);
  }, [updates]);

  const handleCloseAlertModal = useCallback(() => {
    setAlertModalVisible(false);
    setAlertError(null);
  }, []);

  const handleRemoveAlert = useCallback(async (alertId: string) => {
    const db = dbRef.current;
    if (!db) {
      return;
    }
    try {
      await db.runAsync(`DELETE FROM price_alerts WHERE id = ?;`, [Number(alertId)]);
      await loadAlerts(activeSymbol);
    } catch (err) {
      console.warn('Alert delete error', err);
    }
  }, [activeSymbol, loadAlerts]);

  // Persist a new alert threshold for the current symbol.
  const handleSaveAlert = useCallback(async () => {
    const db = dbRef.current;
    if (!db) {
      setAlertError('Storage not ready yet.');
      return;
    }

    const price = Number(alertPriceText);
    if (Number.isNaN(price) || price <= 0) {
      setAlertError('Enter a valid price greater than zero.');
      return;
    }

    try {
      await db.runAsync(
        `INSERT INTO price_alerts (symbol, direction, price, triggered) VALUES (?, ?, ?, 0);`,
        [activeSymbol, alertDirection, price]
      );
      await db.runAsync(
        `DELETE FROM price_alerts
         WHERE symbol = ?
           AND id NOT IN (
             SELECT id FROM price_alerts
             WHERE symbol = ?
             ORDER BY triggered ASC, id DESC
             LIMIT ?
           );`,
        [activeSymbol, activeSymbol, ALERT_MAX_ITEMS]
      );
      await loadAlerts(activeSymbol);
      setAlertModalVisible(false);
      setAlertError(null);
    } catch (err) {
      console.warn('Alert insert error', err);
      setAlertError('Failed to save alert.');
    }
  }, [activeSymbol, alertDirection, alertPriceText, loadAlerts]);

  const handleOpenHistory = useCallback(() => {
    setHistoryVisible(true);
    setHistoryError(null);
    if (!isDbReady) {
      setHistorySections([]);
      setHistoryError('History unavailable until storage initializes.');
      return;
    }
    setHistoryLoading(true);
    void loadHistory();
  }, [isDbReady, loadHistory]);

  const handleCloseHistory = useCallback(() => {
    setHistoryVisible(false);
    setHistoryLoading(false);
    setHistoryError(null);
  }, []);

  useEffect(() => {
    let isMounted = true;

    // Lazily open the database; we do it once and cache the handle for subsequent queries.
    const initializeDbAsync = async () => {
      try {
        const db = await openDatabaseAsync(DB_NAME);
        if (!isMounted) {
          return;
        }
        dbRef.current = db;

        await db.runAsync(
          `CREATE TABLE IF NOT EXISTS price_updates (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             symbol TEXT NOT NULL,
             price REAL NOT NULL,
             timestamp INTEGER NOT NULL
           );`
        );
        await db.runAsync(
          `CREATE TABLE IF NOT EXISTS price_alerts (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             symbol TEXT NOT NULL,
             direction TEXT NOT NULL,
             price REAL NOT NULL,
             triggered INTEGER NOT NULL DEFAULT 0
           );`
        );
      } catch (err) {
        console.warn('SQLite init error', err);
        if (isMounted) {
          setErrorMessage('Failed to load cached data.');
        }
        return;
      }

      if (isMounted) {
        setIsDbReady(true);
      }
    };

    void initializeDbAsync();

    return () => {
      isMounted = false;
      dbRef.current = null;
    };
  }, []);

  // Whenever the active symbol changes, refill the list from SQLite so the UI updates instantly.
  useEffect(() => {
    if (!isDbReady) {
      return;
    }
    void loadCachedUpdates(activeSymbol);
    void loadAlerts(activeSymbol);
  }, [activeSymbol, isDbReady, loadCachedUpdates, loadAlerts]);

  // Handle the WebSocket lifecycle and reconnects for the currently selected symbol.
  useEffect(() => {
    let manualClose = false;
    const symbolForSession = activeSymbol;

    if (!hasToken) {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnectionStatus('error');
      setErrorMessage('Set EXPO_PUBLIC_FINNHUB_TOKEN to stream live data.');
      return () => {
        manualClose = true;
      };
    }

    const scheduleReconnect = () => {
      if (manualClose || reconnectTimerRef.current) {
        return;
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, 3000);
    };

    const handleMessage = (data: string) => {
      try {
        const payload = JSON.parse(data);
        const trades: Array<Record<string, unknown>> = Array.isArray(payload?.data) ? payload.data : [];
        if (!trades.length) {
          return;
        }

        trades.forEach(trade => {
          const symbol = typeof trade.s === 'string' ? trade.s : null;
          const price = typeof trade.p === 'number' ? trade.p : Number(trade.p);
          const timestamp = typeof trade.t === 'number' ? trade.t : Number(trade.t);

          if (!symbol || Number.isNaN(price) || Number.isNaN(timestamp) || symbol !== symbolForSession) {
            return;
          }

          const update: PriceUpdate = {
            key: `${symbol}-${timestamp}-${price}`,
            symbol,
            price,
            timestamp,
          };

          setUpdates(prev => {
            const next = [update, ...prev.filter(item => item.key !== update.key)];
            return next.slice(0, MAX_ITEMS);
          });
          setFreshTimestamp(timestamp);
          setErrorMessage(null);
          void persistAndCheckUpdate(update);
        });
      } catch (err) {
        console.warn('WebSocket parse error', err);
      }
    };

    const connect = () => {
      setConnectionStatus('connecting');
      setErrorMessage(null);

      const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_TOKEN}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus('open');
        ws.send(JSON.stringify({ type: 'subscribe', symbol: symbolForSession }));
      };

      ws.onmessage = event => {
        if (typeof event.data === 'string') {
          handleMessage(event.data);
        }
      };

      ws.onerror = event => {
        console.warn('WebSocket error', (event as WebSocketErrorEvent)?.message ?? 'unknown error');
        setConnectionStatus('error');
        setErrorMessage('Live feed error, attempting to reconnect...');
      };

      ws.onclose = () => {
        if (manualClose) {
          return;
        }
        setConnectionStatus('closed');
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      manualClose = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [activeSymbol, persistAndCheckUpdate, hasToken]);

  const metrics = useMemo(() => computeMetrics(updates), [updates]);
  const { points: sparklinePoints, min: sparklineMin, max: sparklineMax } = useMemo(
    () => computeSparklinePoints(updates),
    [updates]
  );
  const sparklineChart = useMemo(() => {
    // Build an SVG-friendly representation of the last trades for a smooth sparkline.
    const height = 48;
    if (!sparklinePoints.length) {
      return {
        viewBoxWidth: 1,
        height,
        pointsString: '',
        latest: null as null | { x: number; y: number; price: number },
      };
    }

    const count = sparklinePoints.length;
    const width = count > 1 ? count - 1 : 1;
    const verticalPadding = 4;
    const usableHeight = height - verticalPadding * 2;
    const polylinePoints = sparklinePoints
      .map((point, index) => {
        const x = count === 1 ? 0 : (index / (count - 1)) * width;
        const y = height - (point.normalized * usableHeight + verticalPadding);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

    const latest = sparklinePoints[count - 1];
    const latestPoint = {
      x: count === 1 ? 0 : width,
      y: height - (latest.normalized * usableHeight + verticalPadding),
      price: latest.price,
    };

    return {
      viewBoxWidth: width,
      height,
      pointsString: polylinePoints,
      latest: latestPoint,
    };
  }, [sparklinePoints]);

  const renderItem = ({ item }: ListRenderItemInfo<PriceUpdate>) => {
    const isFresh = freshTimestamp !== null && item.timestamp === freshTimestamp;
    return (
      <View style={[styles.row, isFresh ? styles.rowFresh : styles.rowStale]}>
        <View style={styles.rowHeader}>
          <Text style={styles.symbol}>{item.symbol}</Text>
          <Text style={styles.price}>{item.price.toFixed(2)}</Text>
        </View>
        <Text style={styles.timestamp}>{formatTimestamp(item.timestamp)}</Text>
      </View>
    );
  };

  const renderHistoryItem = ({ item }: SectionListRenderItemInfo<HistoryEntry>) => (
    <View style={styles.historyRow}>
      <View style={styles.historyRowHeader}>
        <Text style={styles.historyRowPrice}>{item.price.toFixed(2)}</Text>
        <Text style={styles.historyRowTimestamp}>{formatTimestamp(item.timestamp)}</Text>
      </View>
    </View>
  );

  const renderHistorySectionHeader = ({ section }: { section: SectionListData<HistoryEntry> }) => (
    <View style={styles.historySectionHeader}>
      <Text style={styles.historySectionTitle}>{section.title}</Text>
      <Text style={styles.historySectionMeta}>{section.data.length} stored</Text>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.statusContainer}>
        <Text style={styles.statusText}>Status: {connectionStatus}</Text>
        <Text style={styles.statusText}>Symbol: {activeSymbol}</Text>
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        {!hasToken ? (
          <Text style={styles.warningText}>
            Set EXPO_PUBLIC_FINNHUB_TOKEN before running to stream live data.
          </Text>
        ) : null}
        <Pressable style={styles.historyButton} onPress={handleOpenHistory}>
          <Text style={styles.historyButtonText}>View History</Text>
        </Pressable>
      </View>
      <View style={styles.symbolControls}>
        <TextInput
          value={symbolInput}
          onChangeText={text => setSymbolInput(text.toUpperCase())}
          placeholder="Enter symbol (e.g. AAPL or BINANCE:BTCUSDT)"
          placeholderTextColor="#4a5568"
          autoCapitalize="characters"
          keyboardType="default"
          style={styles.symbolInput}
        />
        <Pressable style={styles.symbolButton} onPress={handleApplySymbol}>
          <Text style={styles.symbolButtonText}>Subscribe</Text>
        </Pressable>
      </View>
      {isUsMarketOpen === false && activeSymbol && activeSymbol.indexOf(':') === -1 ? (
        <View style={styles.marketNotice}>
          <Text style={styles.marketNoticeText}>
            U.S. equities may be idle outside regular market hours (9:30 AM – 4:00 PM ET).
          </Text>
        </View>
      ) : null}
      <View style={styles.quickSymbols}>
        {QUICK_SYMBOLS.map(ticker => {
          const isActive = ticker === activeSymbol;
          return (
            <Pressable
              key={ticker}
              onPress={() => handleQuickSelect(ticker)}
              style={[styles.symbolChip, isActive ? styles.symbolChipActive : null]}
            >
              <Text style={[styles.symbolChipText, isActive ? styles.symbolChipTextActive : null]}>{ticker}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.alertsContainer}>
        <View style={styles.alertsHeader}>
          <Text style={styles.alertsTitle}>Alerts</Text>
          <Pressable style={styles.alertsAddButton} onPress={handleOpenAlertModal}>
            <Text style={styles.alertsAddButtonText}>Add</Text>
          </Pressable>
        </View>
        {!notificationAllowed ? (
          <Text style={styles.alertsPermission}>
            Enable notifications in system settings to receive alert banners.
          </Text>
        ) : null}
        {alerts.length ? (
          alerts.map(alert => (
            <View
              key={alert.id}
              style={[
                styles.alertRow,
                alert.triggered ? styles.alertRowTriggered : styles.alertRowActive,
              ]}
            >
              <Text
                style={[
                  styles.alertRowText,
                  alert.triggered ? styles.alertRowTextTriggered : null,
                ]}
              >
                {alert.symbol} {alert.direction === 'above' ? '≥' : '≤'} {alert.price.toFixed(2)}
              </Text>
              <Pressable onPress={() => handleRemoveAlert(alert.id)}>
                <Text style={styles.alertRemoveText}>Remove</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.alertsEmpty}>No alerts configured.</Text>
        )}
      </View>
      <View style={styles.analyticsContainer}>
        <View style={styles.metricBlock}>
          <Text style={styles.metricLabel}>Last Price</Text>
          <Text style={styles.metricValue}>{metrics.latest !== null ? metrics.latest.toFixed(2) : '—'}</Text>
        </View>
        <View style={styles.metricBlock}>
          <Text style={styles.metricLabel}>Δ (20 ticks)</Text>
          <Text
            style={[
              styles.metricValue,
              metrics.change > 0 ? styles.metricValuePositive : null,
              metrics.change < 0 ? styles.metricValueNegative : null,
            ]}
          >
            {metrics.change > 0 ? '+' : ''}
            {metrics.change.toFixed(2)}
          </Text>
        </View>
        <View style={styles.metricBlock}>
          <Text style={styles.metricLabel}>Δ%</Text>
          <Text
            style={[
              styles.metricValue,
              metrics.percentage > 0 ? styles.metricValuePositive : null,
              metrics.percentage < 0 ? styles.metricValueNegative : null,
            ]}
          >
            {metrics.percentage > 0 ? '+' : ''}
            {metrics.percentage.toFixed(2)}%
          </Text>
        </View>
      </View>
      {sparklinePoints.length ? (
        <View style={styles.sparkline}>
          {/* Show a quick legend so readers know the min/max that the line chart spans. */}
          <View style={styles.sparklineHeader}>
            <Text style={styles.sparklineLabel}>Price trend (last 20 trades)</Text>
            {sparklineMin !== null && sparklineMax !== null ? (
              <Text style={styles.sparklineRange}>
                {sparklineMin.toFixed(2)} – {sparklineMax.toFixed(2)}
              </Text>
            ) : null}
          </View>
          {sparklineChart.pointsString ? (
            <Svg
              style={styles.sparklineChart}
              viewBox={`0 0 ${sparklineChart.viewBoxWidth} ${sparklineChart.height}`}
              preserveAspectRatio="none"
            >
              <Defs>
                <SvgLinearGradient id={`sparkline-gradient-${activeSymbol}`} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0%" stopColor="#63b3ed" stopOpacity={0.9} />
                  <Stop offset="100%" stopColor="#3182ce" stopOpacity={0.2} />
                </SvgLinearGradient>
              </Defs>
              <Polyline
                points={sparklineChart.pointsString}
                fill="none"
                stroke={`url(#sparkline-gradient-${activeSymbol})`}
                strokeWidth={0.9}
              />
              {sparklineChart.latest ? (
                <Circle cx={sparklineChart.latest.x} cy={sparklineChart.latest.y} r={1.2} fill="#63b3ed" />
              ) : null}
            </Svg>
          ) : null}
        </View>
      ) : null}
      <FlatList
        data={updates}
        renderItem={renderItem}
        keyExtractor={item => item.key}
        contentContainerStyle={updates.length === 0 ? styles.emptyContent : undefined}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Waiting for trade updates…</Text>
          </View>
        }
      />
      <Modal
        animationType="fade"
        transparent
        visible={alertModalVisible}
        onRequestClose={handleCloseAlertModal}
      >
        <View style={styles.alertOverlay}>
          <View style={styles.alertSheet}>
            <Text style={styles.alertTitle}>Create Price Alert</Text>
            <Text style={styles.alertSubtitle}>Notify when {activeSymbol} trades…</Text>
            <View style={styles.alertToggleRow}>
              <Pressable
                style={[
                  styles.alertToggle,
                  alertDirection === 'above' ? styles.alertToggleActive : null,
                ]}
                onPress={() => setAlertDirection('above')}
              >
                <Text
                  style={[
                    styles.alertToggleText,
                    alertDirection === 'above' ? styles.alertToggleTextActive : null,
                  ]}
                >
                  At or above
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.alertToggle,
                  styles.alertToggleLast,
                  alertDirection === 'below' ? styles.alertToggleActive : null,
                ]}
                onPress={() => setAlertDirection('below')}
              >
                <Text
                  style={[
                    styles.alertToggleText,
                    alertDirection === 'below' ? styles.alertToggleTextActive : null,
                  ]}
                >
                  At or below
                </Text>
              </Pressable>
            </View>
            <TextInput
              value={alertPriceText}
              onChangeText={setAlertPriceText}
              placeholder="Price target"
              placeholderTextColor="#4a5568"
              keyboardType="decimal-pad"
              style={styles.alertInput}
            />
            {alertError ? <Text style={styles.alertError}>{alertError}</Text> : null}
            {!notificationAllowed ? (
              <Text style={styles.alertPermissionWarning}>
                Alerts will be stored, but enable notifications to see banners.
              </Text>
            ) : null}
            <View style={styles.alertActions}>
              <Pressable style={styles.alertCancelButton} onPress={handleCloseAlertModal}>
                <Text style={styles.alertCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.alertSaveButton} onPress={handleSaveAlert}>
                <Text style={styles.alertSaveText}>Save Alert</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="slide"
        transparent
        visible={historyVisible}
        onRequestClose={handleCloseHistory}
      >
        <View style={styles.historyOverlay}>
          <View style={styles.historySheet}>
            <View style={styles.historySheetHeader}>
              <Text style={styles.historyTitle}>Cached History</Text>
              <Pressable onPress={handleCloseHistory}>
                <Text style={styles.historyCloseText}>Close</Text>
              </Pressable>
            </View>
            {historyLoading ? (
              <Text style={styles.historyStatus}>Loading…</Text>
            ) : historyError ? (
              <Text style={styles.historyStatus}>{historyError}</Text>
            ) : (
              <SectionList
                sections={historySections}
                renderItem={renderHistoryItem}
                renderSectionHeader={renderHistorySectionHeader}
                keyExtractor={item => item.key}
                contentContainerStyle={
                  historySections.length === 0 ? styles.historyEmpty : undefined
                }
                stickySectionHeadersEnabled={false}
                showsVerticalScrollIndicator={false}
              />
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1624',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusContainer: {
    marginBottom: 12,
  },
  statusText: {
    color: '#9aa5b1',
    fontSize: 12,
  },
  errorText: {
    marginTop: 4,
    color: '#f56565',
    fontSize: 12,
  },
  warningText: {
    marginTop: 4,
    color: '#ecc94b',
    fontSize: 12,
  },
  historyButton: {
    marginTop: 12,
    alignSelf: 'flex-start',
    backgroundColor: '#2c5282',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  historyButtonText: {
    color: '#f7fafc',
    fontSize: 12,
    fontWeight: '600',
  },
  symbolControls: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  symbolInput: {
    flex: 1,
    backgroundColor: '#151d2b',
    color: '#f7fafc',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  symbolButton: {
    marginLeft: 12,
    backgroundColor: '#3182ce',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  symbolButtonText: {
    color: '#f7fafc',
    fontWeight: '600',
    fontSize: 14,
  },
  quickSymbols: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  symbolChip: {
    marginRight: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2d3748',
    backgroundColor: '#151d2b',
  },
  symbolChipActive: {
    borderColor: '#48bb78',
    backgroundColor: '#1f2a3c',
  },
  symbolChipText: {
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  symbolChipTextActive: {
    color: '#48bb78',
  },
  alertsContainer: {
    backgroundColor: '#151d2b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  alertsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  alertsTitle: {
    color: '#f7fafc',
    fontSize: 16,
    fontWeight: '700',
  },
  alertsAddButton: {
    backgroundColor: '#3182ce',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  alertsAddButtonText: {
    color: '#f7fafc',
    fontSize: 12,
    fontWeight: '600',
  },
  alertsPermission: {
    color: '#ecc94b',
    fontSize: 12,
    marginBottom: 6,
  },
  alertsEmpty: {
    color: '#9aa5b1',
    fontSize: 12,
    fontStyle: 'italic',
  },
  alertRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 6,
  },
  alertRowActive: {
    borderColor: '#48bb78',
    backgroundColor: '#1f2a3c',
  },
  alertRowTriggered: {
    borderColor: '#4a5568',
    backgroundColor: '#1a202c',
  },
  alertRowText: {
    color: '#f7fafc',
    fontSize: 14,
    fontWeight: '600',
  },
  alertRowTextTriggered: {
    color: '#718096',
    textDecorationLine: 'line-through',
  },
  alertRemoveText: {
    color: '#f56565',
    fontSize: 12,
    fontWeight: '600',
  },
  alertOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 22, 36, 0.85)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  alertSheet: {
    backgroundColor: '#0f1624',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  alertTitle: {
    color: '#f7fafc',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  alertSubtitle: {
    color: '#9aa5b1',
    fontSize: 12,
    marginBottom: 12,
  },
  alertToggleRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  alertToggle: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingVertical: 10,
    marginRight: 8,
    alignItems: 'center',
  },
  alertToggleLast: {
    marginRight: 0,
  },
  alertToggleActive: {
    borderColor: '#48bb78',
    backgroundColor: '#1f2a3c',
  },
  alertToggleText: {
    color: '#9aa5b1',
    fontSize: 14,
    fontWeight: '600',
  },
  alertToggleTextActive: {
    color: '#48bb78',
  },
  alertInput: {
    backgroundColor: '#151d2b',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2d3748',
    color: '#f7fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    marginBottom: 12,
  },
  alertError: {
    color: '#f56565',
    fontSize: 12,
    marginBottom: 8,
  },
  alertPermissionWarning: {
    color: '#ecc94b',
    fontSize: 12,
    marginBottom: 8,
  },
  alertActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
  },
  alertCancelButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  alertCancelText: {
    color: '#9aa5b1',
    fontSize: 14,
    fontWeight: '600',
  },
  alertSaveButton: {
    backgroundColor: '#48bb78',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  alertSaveText: {
    color: '#0f1624',
    fontSize: 14,
    fontWeight: '700',
  },
  analyticsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#151d2b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  metricBlock: {
    flex: 1,
  },
  metricLabel: {
    color: '#9aa5b1',
    fontSize: 12,
    marginBottom: 4,
  },
  metricValue: {
    color: '#f7fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  metricValuePositive: {
    color: '#48bb78',
  },
  metricValueNegative: {
    color: '#f56565',
  },
  marketNotice: {
    backgroundColor: '#1f2a3c',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  marketNoticeText: {
    color: '#ecc94b',
    fontSize: 12,
  },
  sparkline: {
    backgroundColor: '#151d2b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3748',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
  },
  sparklineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sparklineLabel: {
    color: '#f7fafc',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  sparklineRange: {
    color: '#9aa5b1',
    fontSize: 12,
  },
  sparklineChart: {
    width: '100%',
    height: 48,
  },
  historyOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 22, 36, 0.85)',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  historySheet: {
    backgroundColor: '#0f1624',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderWidth: 1,
    borderColor: '#2d3748',
    maxHeight: '80%',
  },
  historySheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  historyTitle: {
    color: '#f7fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  historyCloseText: {
    color: '#63b3ed',
    fontSize: 14,
    fontWeight: '600',
  },
  historyStatus: {
    color: '#9aa5b1',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 24,
  },
  historyEmpty: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  historySectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#151d2b',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 8,
  },
  historySectionTitle: {
    color: '#f7fafc',
    fontWeight: '700',
    fontSize: 14,
  },
  historySectionMeta: {
    color: '#9aa5b1',
    fontSize: 12,
  },
  historyRow: {
    backgroundColor: '#0f1b2d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1f2a3c',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  historyRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  historyRowPrice: {
    color: '#f6ad55',
    fontSize: 16,
    fontWeight: '600',
  },
  historyRowTimestamp: {
    color: '#9aa5b1',
    fontSize: 12,
  },
  row: {
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  rowFresh: {
    backgroundColor: '#1f2a3c',
    borderColor: '#48bb78',
  },
  rowStale: {
    backgroundColor: '#151d2b',
    borderColor: '#2d3748',
  },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  symbol: {
    color: '#f7fafc',
    fontSize: 18,
    fontWeight: '700',
  },
  price: {
    color: '#f6ad55',
    fontSize: 18,
    fontWeight: '600',
  },
  timestamp: {
    color: '#a0aec0',
    fontSize: 12,
  },
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 40,
  },
  emptyContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyText: {
    color: '#718096',
  },
});
