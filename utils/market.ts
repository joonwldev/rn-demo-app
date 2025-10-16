export type PriceSample = {
  symbol?: string;
  price: number;
  timestamp: number;
};

export const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid date';
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

export const computeMetrics = (entries: PriceSample[]) => {
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

export const computeSparklinePoints = (entries: PriceSample[]) => {
  if (entries.length < 2) {
    return {
      points: [] as Array<{ key: number; price: number; normalized: number }>,
      min: null as number | null,
      max: null as number | null,
    };
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

export const isUsMarketOpen = (date: Date): boolean => {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();

  // US regular market hours: 9:30 AM - 4:00 PM ET => 14:30 - 21:00 UTC (approx, ignoring DST).
  const minutesOfDay = hour * 60 + minute;
  const openMinutes = 14 * 60 + 30;
  const closeMinutes = 21 * 60;

  const weekday = day >= 1 && day <= 5;
  return weekday && minutesOfDay >= openMinutes && minutesOfDay <= closeMinutes;
};
