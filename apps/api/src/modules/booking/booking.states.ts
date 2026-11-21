import type { slotStatuses } from '../doctor/doctor.schemas.js';

export const activeAppointmentStatuses = [
  'pending_payment',
  'confirmed',
] as const;
export const appointmentStatuses = [
  ...activeAppointmentStatuses,
  'cancelled',
  'expired',
] as const;

type SlotStatus = (typeof slotStatuses)[number];
type AppointmentStatus = (typeof appointmentStatuses)[number];

const slotTransitions: Record<SlotStatus, readonly SlotStatus[]> = {
  available: ['held'],
  held: ['booked', 'available'],
  booked: ['available'],
};
const appointmentTransitions: Record<
  AppointmentStatus,
  readonly AppointmentStatus[]
> = {
  pending_payment: ['confirmed', 'cancelled', 'expired'],
  confirmed: ['cancelled'],
  cancelled: [],
  expired: [],
};

export function canTransitionSlot(from: SlotStatus, to: SlotStatus): boolean {
  return slotTransitions[from].includes(to);
}

export function canTransitionAppointment(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return appointmentTransitions[from].includes(to);
}
