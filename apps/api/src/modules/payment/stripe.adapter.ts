import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Schema, model } from 'mongoose';
import Stripe from 'stripe';
import { env } from '../../config/env.js';

interface IntentMetadata {
  appointmentId: string;
  slotId: string;
  patientId: string;
}
interface IntentInput {
  amount: number;
  currency: string;
  metadata: IntentMetadata;
}
interface ProviderIntent {
  id: string;
  clientSecret: string | null;
  status: string;
  amountReceived: number;
  currency: string;
}
interface ProviderRefund {
  id: string;
  status: string | null;
}

const stripe =
  env.NODE_ENV !== 'test' && env.STRIPE_SECRET_KEY
    ? new Stripe(env.STRIPE_SECRET_KEY, {
        timeout: 10_000,
        maxNetworkRetries: 2,
      })
    : undefined;
const webhookSecret =
  env.STRIPE_WEBHOOK_SECRET ?? randomBytes(32).toString('hex');

export const LocalStripeIntent = model(
  'LocalStripeIntent',
  new Schema(
    {
      _id: { type: String, required: true },
      status: { type: String, default: 'requires_payment_method' },
      amount: { type: Number, required: true },
      currency: { type: String, required: true },
      metadata: { type: Schema.Types.Mixed, required: true },
      refundId: String,
    },
    { collection: 'local_stripe_intents', versionKey: false },
  ),
);

function deterministicId(prefix: string, value: string): string {
  return prefix + createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function fromStripe(intent: Stripe.PaymentIntent): ProviderIntent {
  return {
    id: intent.id,
    clientSecret: intent.client_secret,
    status: intent.status,
    amountReceived: intent.amount_received,
    currency: intent.currency,
  };
}

export async function createIntent(
  input: IntentInput,
): Promise<ProviderIntent> {
  const key = 'appointment-intent-' + input.metadata.appointmentId;
  if (stripe) {
    return fromStripe(
      await stripe.paymentIntents.create(
        {
          ...input,
          metadata: { ...input.metadata },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: key },
      ),
    );
  }

  const id = deterministicId('pi_', key);
  await LocalStripeIntent.updateOne(
    { _id: id },
    { $setOnInsert: input },
    { upsert: true },
  );
  return retrieveIntent(id);
}

export async function retrieveIntent(id: string): Promise<ProviderIntent> {
  if (stripe) return fromStripe(await stripe.paymentIntents.retrieve(id));
  const intent = await LocalStripeIntent.findById(id).orFail();
  const status = intent.status ?? 'requires_payment_method';
  return {
    id,
    clientSecret: id + '_secret_local',
    status,
    currency: intent.currency,
    amountReceived: status === 'succeeded' ? intent.amount : 0,
  };
}

export async function refundIntent(id: string): Promise<ProviderRefund> {
  const key = 'late-payment-' + id;
  if (stripe) {
    // Stripe may prune idempotency keys. Reuse a previously recorded Stripe refund after that window.
    for await (const refund of stripe.refunds.list({ payment_intent: id })) {
      if (refund.metadata?.medcoreRefundKey === key)
        return { id: refund.id, status: refund.status };
    }
    const refund = await stripe.refunds.create(
      {
        payment_intent: id,
        metadata: { medcoreRefundKey: key },
      },
      { idempotencyKey: key },
    );
    return { id: refund.id, status: refund.status };
  }

  const refundId = deterministicId('re_', key);
  const result = await LocalStripeIntent.updateOne(
    { _id: id },
    { $set: { refundId } },
  );
  if (!result.matchedCount) throw new Error('Local Stripe intent not found');
  return { id: refundId, status: 'succeeded' };
}

function localSignature(payload: Buffer, timestamp: number): Buffer {
  return createHmac('sha256', webhookSecret)
    .update(String(timestamp) + '.')
    .update(payload)
    .digest();
}

export function signLocalWebhook(payload: Buffer): string {
  if (stripe) throw new Error('Local signing is disabled for real Stripe');
  const timestamp = Math.floor(Date.now() / 1000);
  return (
    't=' +
    timestamp +
    ',v1=' +
    localSignature(payload, timestamp).toString('hex')
  );
}

export function verifyWebhook(payload: Buffer, signature: string): unknown {
  if (stripe)
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);

  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
  if (!match) throw new Error('Invalid local webhook signature');
  const timestamp = Number(match[1]);
  if (
    Math.abs(Date.now() / 1000 - timestamp) > 300 ||
    !timingSafeEqual(
      localSignature(payload, timestamp),
      Buffer.from(match[2], 'hex'),
    )
  ) {
    throw new Error('Invalid local webhook signature');
  }
  return JSON.parse(payload.toString('utf8'));
}
