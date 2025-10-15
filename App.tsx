import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  ListRenderItemInfo,
  Modal,
  Pressable,
  SafeAreaView,
  SectionList,
  SectionListData,
  SectionListRenderItemInfo,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { openDatabaseAsync, SQLiteDatabase } from 'expo-sqlite';

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

const FINNHUB_TOKEN = '***REMOVED***';
const DEFAULT_SYMBOL = 'AAPL';
const QUICK_SYMBOLS = ['AAPL', 'TSLA', 'BINANCE:BTCUSDT'];
const MAX_ITEMS = 20;
const DB_MAX_ITEMS = 60;
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

// Normalize the recent prices into 0-1 values so we can render a sparkline bar chart.
// Prepare sparkline data points from the cached trades.
const computeSparklinePoints = (entries: PriceUpdate[]) => {
  if (entries.length < 2) {
    return [];
  }

  const chronological = [...entries].reverse();
  const prices = chronological.map(item => item.price);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const range = max - min || 1;

  return chronological.map(item => ({
    key: item.timestamp,
    value: (item.price - min) / range,
  }));
};

export default function App(): JSX.Element {
  const [activeSymbol, setActiveSymbol] = useState(DEFAULT_SYMBOL);
  const [symbolInput, setSymbolInput] = useState(DEFAULT_SYMBOL);
  const [updates, setUpdates] = useState<PriceUpdate[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [freshTimestamp, setFreshTimestamp] = useState<number | null>(null);
  const [isDbReady, setIsDbReady] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historySections, setHistorySections] = useState<HistorySection[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dbRef = useRef<SQLiteDatabase | null>(null);

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
  }, [activeSymbol, isDbReady, loadCachedUpdates]);

  // Handle the WebSocket lifecycle and reconnects for the currently selected symbol.
  useEffect(() => {
    let manualClose = false;
    const symbolForSession = activeSymbol;

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
        console.log('Finnhub message', {
          type: payload?.type,
          tradeCount: trades.length,
          sample: trades[0],
        });
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
          void persistUpdate(update);
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
  }, [activeSymbol, persistUpdate]);

  const metrics = useMemo(() => computeMetrics(updates), [updates]);
  const sparklinePoints = useMemo(() => computeSparklinePoints(updates), [updates]);

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
        {FINNHUB_TOKEN === 'YOUR_API_KEY' ? (
          <Text style={styles.warningText}>Replace YOUR_API_KEY with a valid Finnhub API token.</Text>
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
          {sparklinePoints.map((point, index) => (
            <View
              key={`${activeSymbol}-spark-${point.key}-${index}`}
              style={[styles.sparklineBar, { height: Math.max(6, point.value * 40) }]}
            />
          ))}
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
  sparkline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 48,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d3748',
    backgroundColor: '#151d2b',
    marginBottom: 16,
  },
  sparklineBar: {
    width: 4,
    marginHorizontal: 1,
    borderRadius: 2,
    backgroundColor: '#63b3ed',
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
