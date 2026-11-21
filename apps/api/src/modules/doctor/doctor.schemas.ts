import { z } from 'zod';

const longitude = z.number().min(-180).max(180);
const latitude = z.number().min(-90).max(90);
const specialty = z.string().trim().min(1).max(100);
const queryNumber = z.string().trim().min(1).pipe(z.coerce.number());
const dateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const coordinatesSchema = z.tuple([longitude, latitude]);
export const slotStatuses = ['available', 'held', 'booked'] as const;

export const profileSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  specialty,
  consultationFee: z.number().int().nonnegative(),
  location: z.strictObject({
    type: z.literal('Point'),
    coordinates: coordinatesSchema,
  }),
});

export const nearbySchema = z.strictObject({
  lng: queryNumber.pipe(longitude),
  lat: queryNumber.pipe(latitude),
  maxDistanceKm: queryNumber.pipe(z.number().positive().max(20100)).default(10),
  specialty: specialty.optional(),
});

export const doctorParamsSchema = z.object({
  doctorId: z.string().regex(/^[a-f0-9]{24}$/i),
});

const newSlot = z
  .strictObject({ startAt: dateTime, endAt: dateTime })
  .refine((slot) => slot.startAt < slot.endAt, {
    path: ['endAt'],
    message: 'endAt must be after startAt',
  });

export const createSlotsSchema = z.union([
  newSlot.transform((slot) => [slot]),
  z
    .strictObject({ slots: z.array(newSlot).min(1).max(100) })
    .transform(({ slots }) => slots),
]);

export const listSlotsSchema = z
  .strictObject({
    status: z.enum(slotStatuses).optional(),
    from: dateTime.optional(),
    to: dateTime.optional(),
  })
  .refine(({ from, to }) => !from || !to || from < to, {
    path: ['to'],
    message: 'to must be after from',
  });
