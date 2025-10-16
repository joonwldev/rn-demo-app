import {
  computeMetrics,
  computeSparklinePoints,
  formatTimestamp,
  isUsMarketOpen,
} from '../utils/market';

describe('formatTimestamp', () => {
  it('returns a readable string for valid timestamps', () => {
    const timestamp = Date.UTC(2024, 0, 1, 13, 45); // Jan 1 2024 13:45 UTC
    const result = formatTimestamp(timestamp);
    const expected = `${new Date(timestamp).toLocaleDateString()} ${new Date(timestamp).toLocaleTimeString()}`;
    expect(result).toBe(expected);
  });

  it('returns fallback for invalid dates', () => {
    expect(formatTimestamp(Number.NaN)).toBe('Invalid date');
  });
});

describe('computeMetrics', () => {
  it('returns zeros for empty input', () => {
    expect(computeMetrics([])).toEqual({
      change: 0,
      percentage: 0,
      basis: null,
      latest: null,
    });
  });

  it('computes change and percentage', () => {
    const sample = [
      { price: 110, timestamp: 2_000 },
      { price: 100, timestamp: 1_000 },
    ];
    expect(computeMetrics(sample)).toEqual({
      change: 10,
      percentage: 10,
      basis: 100,
      latest: 110,
    });
  });
});

describe('computeSparklinePoints', () => {
  it('returns empty payload when fewer than two points', () => {
    const result = computeSparklinePoints([{ price: 100, timestamp: 1_000 }]);
    expect(result).toEqual({
      points: [],
      min: null,
      max: null,
    });
  });

  it('normalizes prices between 0 and 1', () => {
    const result = computeSparklinePoints([
      { price: 100, timestamp: 1_000 },
      { price: 110, timestamp: 2_000 },
      { price: 105, timestamp: 3_000 },
    ]);

    const normalized = result.points.map(point => point.normalized);
    expect(Math.min(...normalized)).toBe(0);
    expect(Math.max(...normalized)).toBe(1);
    expect(result.min).toBe(100);
    expect(result.max).toBe(110);
  });
});

describe('isUsMarketOpen', () => {
  it('returns true during regular weekday session', () => {
    const mondayAt15UTC = new Date(Date.UTC(2024, 2, 4, 15, 0)); // Monday
    expect(isUsMarketOpen(mondayAt15UTC)).toBe(true);
  });

  it('returns false before open on weekdays', () => {
    const mondayAt13UTC = new Date(Date.UTC(2024, 2, 4, 13, 0));
    expect(isUsMarketOpen(mondayAt13UTC)).toBe(false);
  });

  it('returns false on weekends', () => {
    const sunday = new Date(Date.UTC(2024, 2, 3, 16, 0));
    expect(isUsMarketOpen(sunday)).toBe(false);
  });
});
