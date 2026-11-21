import express, { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth } from '../../shared/middleware/auth.js';
import { requireIdempotency } from '../../shared/middleware/idempotency.js';
import { logger } from '../../shared/observability/logger.js';
import {
  applyPaymentSuccess,
  finishLateRefund,
  preparePayment,
} from './payment.service.js';
import { verifyWebhook } from './stripe.adapter.js';
import { StripeEvent } from './stripeEvent.model.js';

const intentInput = z.strictObject({
  appointmentId: z.string().regex(/^[a-f0-9]{24}$/i),
});
const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({ object: z.unknown() }),
});
const successSchema = z.object({
  id: z.string().startsWith('pi_'),
  amount_received: z.number().int().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
});

export const paymentRouter = Router();
paymentRouter.post(
  '/intent',
  requireAuth,
  (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  requireIdempotency,
  async (req, res) => {
    const input = intentInput.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ code: 'INVALID_INPUT' });
      return;
    }

    const claim = res.locals.idempotency!;
    const { status, body } = await preparePayment(
      input.data.appointmentId,
      req.auth!.sub,
      claim,
    );
    claim.committed = status === 201;
    res.status(status).json(body);
  },
);

export const paymentWebhookRouter = Router();
paymentWebhookRouter.post(
  '/',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.get('Stripe-Signature');
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ code: 'INVALID_STRIPE_WEBHOOK' });
      return;
    }

    let verified: unknown;
    try {
      verified = verifyWebhook(req.body, signature);
    } catch {
      res.status(400).json({ code: 'INVALID_STRIPE_WEBHOOK' });
      return;
    }

    const event = eventSchema.safeParse(verified);
    if (!event.success) {
      res.status(400).json({ code: 'INVALID_STRIPE_EVENT' });
      return;
    }
    const success =
      event.data.type === 'payment_intent.succeeded'
        ? successSchema.safeParse(event.data.data.object)
        : null;
    if (success && !success.success) {
      res.status(400).json({ code: 'INVALID_STRIPE_EVENT' });
      return;
    }

    try {
      const refund = await mongoose.connection.transaction(async (session) => {
        await new StripeEvent({
          eventId: event.data.id,
          type: event.data.type,
          processedAt: new Date(),
        }).save({ session });
        if (!success) return false;
        const { id, amount_received, currency } = success.data;
        return applyPaymentSuccess(
          { id, amountReceived: amount_received, currency },
          session,
        );
      });

      if (refund && success) {
        // Persisted refund obligation lets the worker retry even if this process dies here.
        try {
          await finishLateRefund(success.data.id);
        } catch {
          logger.warn('Late payment refund deferred to reconciliation');
        }
      }
      res.json({ received: true });
    } catch (error) {
      if (
        error instanceof mongoose.mongo.MongoServerError &&
        error.code === 11000 &&
        error.keyPattern?.eventId === 1
      ) {
        res.json({ duplicate: true });
        return;
      }
      throw error;
    }
  },
);
