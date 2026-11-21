import mongoose, { type ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import { completeIdempotency } from '../../shared/middleware/idempotency.js';
import { logger } from '../../shared/observability/logger.js';
import { Outbox } from '../../shared/outbox/outbox.model.js';
import { Appointment } from '../booking/appointment.model.js';
import { Doctor } from '../doctor/doctor.model.js';
import { Slot } from '../doctor/slot.model.js';
import { Payment } from './payment.model.js';
import {
  createIntent,
  refundIntent,
  retrieveIntent,
} from './stripe.adapter.js';

interface Success {
  id: string;
  amountReceived: number;
  currency: string;
}

type Claim = Parameters<typeof completeIdempotency>[0];

export async function preparePayment(
  appointmentId: string,
  patientId: string,
  claim: Claim,
) {
  const filter = { _id: appointmentId, patientId };
  const appointment =
    await Appointment.findOne(filter).select('+paymentAmount');
  if (!appointment)
    return { status: 404, body: { code: 'APPOINTMENT_NOT_FOUND' } } as const;
  if (
    appointment.status !== 'pending_payment' ||
    appointment.holdExpiresAt.getTime() <= Date.now()
  ) {
    return { status: 409, body: { code: 'HOLD_NOT_PAYABLE' } } as const;
  }

  let intent;
  let amount = appointment.paymentAmount;
  if (appointment.paymentIntentId) {
    intent = await retrieveIntent(appointment.paymentIntentId);
  } else {
    if (amount == null) {
      const doctor = await Doctor.findById(appointment.doctorId).orFail();
      const fee = doctor.consultationFee;
      if (fee < 1 || fee > 99_999_999) {
        return {
          status: 422,
          body: { code: 'INVALID_PAYMENT_AMOUNT' },
        } as const;
      }

      // Persist the fee before contacting Stripe so retries use the same parameters.
      await Appointment.updateOne(
        { ...filter, paymentAmount: null },
        { $set: { paymentAmount: fee } },
      );
      amount = (
        await Appointment.findOne(filter).select('+paymentAmount').orFail()
      ).paymentAmount;
    }
    if (amount == null) throw new Error('Payment amount missing');
    intent = await createIntent({
      amount,
      currency: env.STRIPE_CURRENCY,
      metadata: {
        appointmentId: appointment.id as string,
        patientId,
        slotId: appointment.slotId.toHexString(),
      },
    });
  }

  return mongoose.connection.transaction(async (session) => {
    const current = await Appointment.findOne(filter).session(session).orFail();
    if (!current.paymentIntentId) {
      if (amount == null) throw new Error('Payment amount missing');
      current.paymentIntentId = intent.id;
      await current.save({ session });
      await new Payment({
        appointmentId: current._id,
        stripeIntentId: intent.id,
        amount,
        currency: intent.currency,
        status: 'pending',
      }).save({ session });
    } else if (current.paymentIntentId !== intent.id) {
      throw new Error('Conflicting payment intent');
    }

    if (
      current.status !== 'pending_payment' ||
      current.holdExpiresAt.getTime() <= Date.now()
    ) {
      return { status: 409, body: { code: 'HOLD_NOT_PAYABLE' } } as const;
    }

    const body = {
      paymentIntentId: intent.id,
      clientSecret: intent.clientSecret,
    };
    await completeIdempotency(claim, 201, body, session);
    return { status: 201, body } as const;
  });
}

// Returns true when an externally successful charge needs a refund after commit.
export async function applyPaymentSuccess(
  intent: Success,
  session: ClientSession,
): Promise<boolean> {
  const payment = await Payment.findOne({ stripeIntentId: intent.id })
    .session(session)
    .orFail();
  if (
    intent.amountReceived !== payment.amount ||
    intent.currency !== payment.currency
  ) {
    throw new Error('Provider amount or currency does not match payment');
  }
  if (payment.status === 'succeeded' || payment.status === 'refunded')
    return false;
  if (payment.refundRequired) return true;

  const appointment = await Appointment.findById(payment.appointmentId)
    .session(session)
    .orFail();
  const now = new Date();
  if (
    appointment.status === 'pending_payment' &&
    appointment.holdExpiresAt > now
  ) {
    const slot = await Slot.findOneAndUpdate(
      {
        _id: appointment.slotId,
        status: 'held',
        heldBy: appointment.patientId,
        holdExpiresAt: appointment.holdExpiresAt,
      },
      { $set: { status: 'booked', holdExpiresAt: null } },
      { session, returnDocument: 'after' },
    );
    if (slot) {
      appointment.status = 'confirmed';
      payment.status = 'succeeded';
      await appointment.save({ session });
      await payment.save({ session });
      await new Outbox({
        type: 'AppointmentConfirmed',
        payload: {
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          slotId: slot._id,
        },
      }).save({ session });
      return false;
    }
  }

  payment.status = 'pending';
  payment.refundRequired = true;
  payment.nextCheckAt = now;
  await payment.save({ session });
  return true;
}

export async function finishLateRefund(stripeIntentId: string): Promise<void> {
  const filter = {
    stripeIntentId,
    status: 'pending' as const,
    refundRequired: true,
  };
  if (!(await Payment.exists(filter))) return;
  const refund = await refundIntent(stripeIntentId);
  if (refund.status !== 'succeeded') {
    logger.warn(
      { refundStatus: refund.status },
      'Stripe refund has not completed',
    );
    return;
  }

  await mongoose.connection.transaction(async (session) => {
    const payment = await Payment.findOneAndUpdate(
      filter,
      {
        $set: {
          status: 'refunded',
          refundRequired: false,
          refundId: refund.id,
        },
      },
      { session, returnDocument: 'after' },
    );
    if (!payment) return;
    await new Outbox({
      type: 'LatePaymentRefunded',
      payload: { appointmentId: payment.appointmentId, stripeIntentId },
    }).save({ session });
  });
}
