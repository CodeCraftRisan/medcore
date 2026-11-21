import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import { logger } from './logger.js';

mongoose.plugin((schema) => {
  const started = new WeakMap<object, number>();
  const operations: mongoose.MongooseQueryMiddleware[] = [
    'countDocuments',
    'deleteMany',
    'deleteOne',
    'distinct',
    'estimatedDocumentCount',
    'find',
    'findOne',
    'findOneAndDelete',
    'findOneAndReplace',
    'findOneAndUpdate',
    'replaceOne',
    'updateMany',
    'updateOne',
  ];
  const query = { query: true, document: false } as const;
  type Query = mongoose.Query<unknown, unknown>;

  function report(operation: string, collection: string, target: object): void {
    const start = started.get(target);
    if (start === undefined) return;
    started.delete(target);
    const durationMs = performance.now() - start;
    if (durationMs > 100)
      logger.warn({ operation, collection, durationMs }, 'slow_query_detected');
  }

  for (const operation of operations) {
    schema.pre<Query>(operation, query, function () {
      started.set(this, performance.now());
    });
    schema.post<Query>(operation, query, function () {
      report(operation, this.model.collection.name, this);
    });
    schema.post<Query>(
      operation,
      { ...query, errorHandler: true },
      function (error, _result, next) {
        report(operation, this.model.collection.name, this);
        next(error);
      },
    );
  }

  schema.pre('aggregate', function () {
    started.set(this, performance.now());
  });
  schema.post('aggregate', function () {
    report('aggregate', this.model().collection.name, this);
  });
  schema.post(
    'aggregate',
    { errorHandler: true },
    function (error: Error, _result: unknown, next: (error: Error) => void) {
      report('aggregate', this.model().collection.name, this);
      next(error);
    },
  );
});
