import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';

const counters = {
  medcore_booking_success_total: 0,
  medcore_booking_conflict_total: 0,
  medcore_lock_contention_total: 0,
  medcore_webhook_failures_total: 0,
};

export function incrementMetric(name: keyof typeof counters): void {
  counters[name]++;
}

const boundaries = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const buckets = boundaries.map(() => 0);
let count = 0;
let sum = 0;
const duration = 'medcore_http_request_duration_seconds';

export const observeHttp: RequestHandler = (req, res, next) => {
  const start = performance.now();
  const path = req.path.toLowerCase().replace(/\/$/, '');
  res.on('finish', () => {
    const elapsed = (performance.now() - start) / 1000;
    count++;
    sum += elapsed;
    boundaries.forEach((bound, index) => {
      if (elapsed <= bound) buckets[index]++;
    });
    if (req.method !== 'POST') return;
    if (path === '/api/bookings/hold' && res.statusCode === 409)
      incrementMetric('medcore_booking_conflict_total');
    if (path === '/api/payments/webhook' && res.statusCode >= 400)
      incrementMetric('medcore_webhook_failures_total');
  });
  next();
};

export function metricsText(): string {
  return [
    ...Object.entries(counters).flatMap(([name, value]) => [
      '# TYPE ' + name + ' counter',
      name + ' ' + value,
    ]),
    '# TYPE ' + duration + ' histogram',
    ...boundaries.map(
      (bound, i) => `${duration}_bucket{le="${bound}"} ${buckets[i]}`,
    ),
    `${duration}_bucket{le="+Inf"} ${count}`,
    `${duration}_count ${count}`,
    `${duration}_sum ${sum}`,
    '',
  ].join('\n');
}
