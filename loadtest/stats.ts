export function summarizeLatency(durations: number[], elapsedMs: number) {
  const sorted = [...durations].sort((left, right) => left - right);
  const percentile = (quantile: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;

  return {
    requestsPerSecond: (durations.length * 1000) / elapsedMs,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}
