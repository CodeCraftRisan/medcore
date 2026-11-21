import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { closeMongo, connectMongo } from '../apps/api/src/config/db.js';
import { closeRedis, connectRedis } from '../apps/api/src/config/redis.js';
import {
  acquireSlotLock,
  releaseSlotLock,
} from '../apps/api/src/shared/lock/redisLock.js';
import { summarizeLatency } from './stats.js';

function setting(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(
      name + ' must be a positive integer no greater than ' + max,
    );
  }
  return value;
}

const contenders = setting('BENCH_CONCURRENCY', 100, 1000);
const rounds = setting('BENCH_ROUNDS', 10, 100);
const name = 'medcore_bench_' + randomUUID().replaceAll('-', '');
const strategies = [
  'Unique index only',
  'Atomic conditional update',
  'Redis lock + atomic update',
  'Optimistic concurrency (__v)',
] as const;

async function main() {
  try {
    await connectMongo(name);
    await connectRedis();
    const db = mongoose.connection.db!;
    const slots = db.collection<{
      _id: string;
      available: boolean;
      claims: number;
      __v: number;
    }>('benchmark_slots');
    const claims = db.collection<{ slotId: string }>('benchmark_claims');
    await claims.createIndex({ slotId: 1 }, { unique: true });

    async function atomic(id: string) {
      return (
        (await slots.findOneAndUpdate(
          { _id: id, available: true },
          { $set: { available: false }, $inc: { claims: 1 } },
        )) !== null
      );
    }

    async function claim(
      strategy: (typeof strategies)[number],
      id: string,
    ): Promise<boolean> {
      switch (strategy) {
        case 'Unique index only':
          try {
            await claims.insertOne({ slotId: id });
            return true;
          } catch (error) {
            if (
              error instanceof mongoose.mongo.MongoServerError &&
              error.code === 11000
            )
              return false;
            throw error;
          }
        case 'Atomic conditional update':
          return atomic(id);
        case 'Redis lock + atomic update': {
          const token = await acquireSlotLock(id);
          assert.notEqual(
            token,
            undefined,
            'Redis unavailable during the Redis benchmark',
          );
          if (!token) return false;
          try {
            return await atomic(id);
          } finally {
            await releaseSlotLock(id, token);
          }
        }
        case 'Optimistic concurrency (__v)': {
          const snapshot = await slots.findOne({ _id: id });
          if (!snapshot?.available) return false;
          const update = await slots.updateOne(
            { _id: id, __v: snapshot.__v },
            {
              $set: { available: false },
              $inc: { __v: 1, claims: 1 },
            },
          );
          return update.modifiedCount === 1;
        }
      }
    }

    const measurements = new Map(
      strategies.map((strategy) => [
        strategy,
        { elapsed: 0, durations: [] as number[], doubleBooked: 0 },
      ]),
    );
    // Rotate execution order between rounds so a strategy does not always run first.
    for (let round = 0; round <= rounds; round++) {
      for (let index = 0; index < strategies.length; index++) {
        const strategy = strategies[(round + index) % strategies.length];
        const id = randomUUID();
        await slots.insertOne({ _id: id, available: true, claims: 0, __v: 0 });
        const start = performance.now();
        const results = await Promise.all(
          Array.from({ length: contenders }, async () => {
            const began = performance.now();
            const success = await claim(strategy, id);
            return { success, duration: performance.now() - began };
          }),
        );
        const elapsed = performance.now() - start;
        const persisted =
          strategy === 'Unique index only'
            ? await claims.countDocuments({ slotId: id })
            : (await slots.findOne({ _id: id }))?.claims;
        const wins = results.filter(({ success }) => success).length;
        assert.equal(
          wins,
          persisted,
          strategy + ': reported and persisted winners disagree',
        );
        assert.ok(wins > 0, strategy + ': no winner');
        if (round === 0) continue;
        const result = measurements.get(strategy)!;
        result.elapsed += elapsed;
        result.durations.push(...results.map(({ duration }) => duration));
        if (wins > 1) result.doubleBooked++;
      }
    }

    console.log(
      `\n${rounds} rounds × ${contenders} parallel contenders per strategy (1 warmup round excluded)\n`,
    );
    console.log(
      '| Strategy | Attempts | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | Double-booked slots |',
    );
    console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [strategy, result] of measurements) {
      const stats = summarizeLatency(result.durations, result.elapsed);
      const values = [
        stats.requestsPerSecond,
        stats.p50,
        stats.p95,
        stats.p99,
      ].map((value) => value.toFixed(2));
      const rate = ((result.doubleBooked * 100) / rounds).toFixed(2);
      console.log(
        `| ${strategy} | ${result.durations.length} | ${values.join(' | ')} | ${result.doubleBooked}/${rounds} (${rate}%) |`,
      );
    }
    assert.ok(
      [...measurements.values()].every(
        ({ doubleBooked }) => doubleBooked === 0,
      ),
      'Double-booking observed',
    );
  } finally {
    try {
      if (
        mongoose.connection.readyState === 1 &&
        mongoose.connection.name === name
      )
        await mongoose.connection.dropDatabase();
    } finally {
      await Promise.all([closeMongo(), closeRedis()]);
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
