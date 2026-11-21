/* global __ENV, open */
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

const base = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const slotId = __ENV.SLOT_ID;
const requests = Number(__ENV.REQUESTS || 1000);
const runId = __ENV.RUN_ID;
const tokens = new SharedArray('patient tokens', () =>
  __ENV.TOKENS_FILE
    ? JSON.parse(open(__ENV.TOKENS_FILE))
    : [__ENV.ACCESS_TOKEN],
);
if (
  !slotId ||
  !runId ||
  !tokens[0] ||
  !Number.isInteger(requests) ||
  requests < 1
) {
  throw new Error(
    'Set SLOT_ID, RUN_ID, and ACCESS_TOKEN or TOKENS_FILE. REQUESTS must be a positive integer.',
  );
}

const holds = new Counter('hold_created');
export const options = {
  scenarios: {
    contention: {
      executor: 'shared-iterations',
      vus: requests,
      iterations: requests,
      maxDuration: '1m',
    },
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    hold_created: ['count==1'],
    checks: ['rate==1'],
    iterations: ['count==' + requests],
  },
};

http.setResponseCallback(http.expectedStatuses(201, 409));

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const response = http.post(
    base + '/api/bookings/hold',
    JSON.stringify({ slotId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + tokens[iteration % tokens.length],
        'Idempotency-Key': runId + '-' + iteration,
      },
      tags: { name: 'POST /api/bookings/hold' },
    },
  );
  holds.add(Number(response.status === 201));
  check(response, {
    'hold was created or rejected as contention': (value) =>
      value.status === 201 ||
      (value.status === 409 &&
        ['SLOT_LOCKED', 'SLOT_NOT_AVAILABLE'].includes(value.json('code'))),
  });
}
