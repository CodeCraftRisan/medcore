import { Router } from 'express';

const str = { type: 'string' };
const date = { ...str, format: 'date-time' };
const id = { ...str, pattern: '^[a-fA-F0-9]{24}$' };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const role = { ...str, enum: ['patient', 'doctor', 'admin'] };
const slotStatus = { ...str, enum: ['available', 'held', 'booked'] };
const array = (items: object) => ({ type: 'array', items });
const object = (
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required });
const ref = (name: string) => ({ $ref: '#/components/schemas/' + name });
const param = (
  name: string,
  location: string,
  schema: object,
  required = false,
) => ({
  name,
  in: location,
  required: location === 'path' || required,
  schema,
});
const idem = param(
  'Idempotency-Key',
  'header',
  { ...str, minLength: 1, maxLength: 255 },
  true,
);
const errorStatuses: Record<number, string> = {
  400: 'Invalid input or missing idempotency key',
  401: 'Invalid credentials or token',
  403: 'Role or ownership check denied access',
  404: 'Resource not found',
  409: 'Conflict or request already in progress',
  422: 'Idempotency mismatch or unsupported payment amount',
  429: 'Rate limit exceeded',
  500: 'Request failed',
  503: 'Dependency or key material unavailable',
};

const schemas = {
  Error: {
    oneOf: [
      object({ code: str }),
      object({ status: str }),
      object(
        { valid: { ...bool, enum: [false] }, reason: str, brokenAtSeq: int },
        ['valid', 'reason'],
      ),
    ],
  },
  Credentials: object({
    email: { ...str, format: 'email' },
    password: { ...str, format: 'password', minLength: 8, maxLength: 128 },
  }),
  User: object({ id, email: str, role }),
  AccessToken: object({ accessToken: str }),
  Point: object({
    type: { ...str, enum: ['Point'] },
    coordinates: {
      ...array(num),
      minItems: 2,
      maxItems: 2,
      description: '[longitude (-180..180), latitude (-90..90)]',
    },
  }),
  DoctorProfile: object({
    name: str,
    specialty: str,
    consultationFee: {
      ...int,
      minimum: 0,
      description: 'Minor currency units',
    },
    location: ref('Point'),
  }),
  Doctor: {
    allOf: [ref('DoctorProfile'), object({ _id: id, userId: id }, ['_id'])],
  },
  SlotInput: object({ startAt: date, endAt: date }),
  Slot: {
    allOf: [
      ref('SlotInput'),
      object({
        _id: id,
        doctorId: id,
        status: slotStatus,
        holdExpiresAt: { ...date, nullable: true },
      }),
    ],
  },
  Appointment: object({
    _id: id,
    patientId: id,
    doctorId: id,
    slotId: id,
    status: {
      ...str,
      enum: ['pending_payment', 'confirmed', 'cancelled', 'expired'],
    },
    paymentIntentId: { ...str, nullable: true },
    idempotencyKey: str,
    holdExpiresAt: date,
  }),
  PrescriptionInput: object(
    {
      appointmentId: id,
      diagnosis: str,
      medications: array({
        oneOf: [
          str,
          object(
            {
              name: str,
              dose: str,
              dosage: str,
              frequency: str,
              instructions: str,
              duration: str,
            },
            ['name'],
          ),
        ],
      }),
      notes: str,
    },
    ['appointmentId', 'diagnosis', 'medications'],
  ),
  Prescription: {
    allOf: [
      ref('PrescriptionInput'),
      object({ id, patientId: id, doctorId: id }),
    ],
  },
  AuditVerification: {
    oneOf: [
      object({ valid: { ...bool, enum: [true] }, totalEntries: int }),
      object({
        valid: { ...bool, enum: [false] },
        brokenAtSeq: int,
        reason: str,
      }),
    ],
  },
  Anchor: object({
    seq: int,
    hash: str,
    ts: date,
    signature: { ...str, format: 'byte' },
  }),
};

interface OperationOptions {
  summary: string;
  ok?: number;
  output?: object;
  input?: object;
  optionalBody?: boolean;
  auth?: 'bearerAuth' | 'refreshCookie' | 'stripeSignature';
  parameters?: object[];
  errors?: number[];
  mime?: string;
  setsCookie?: boolean;
}
function operation(options: OperationOptions) {
  const {
    ok = 200,
    output = object({ status: str }),
    mime = 'application/json',
  } = options;
  return {
    summary: options.summary,
    ...(options.auth ? { security: [{ [options.auth]: [] }] } : {}),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options.input
      ? {
          requestBody: {
            required: !options.optionalBody,
            content: { 'application/json': { schema: options.input } },
          },
        }
      : {}),
    responses: {
      [ok]: {
        description: ok === 204 ? 'No content' : 'Success',
        headers: {
          'x-request-id': { schema: { ...str, format: 'uuid' } },
          ...(options.setsCookie
            ? {
                'Set-Cookie': {
                  schema: str,
                  description:
                    'HttpOnly; SameSite=Strict; Secure in production',
                },
              }
            : {}),
        },
        ...(ok === 204 ? {} : { content: { [mime]: { schema: output } } }),
      },
      ...Object.fromEntries(
        (options.errors ?? []).map((status) => [
          status,
          {
            description: errorStatuses[status],
            ...(status === 429
              ? { headers: { 'Retry-After': { schema: int } } }
              : {}),
            content: { 'application/json': { schema: ref('Error') } },
          },
        ]),
      ),
    },
  };
}

const doctorId = param('doctorId', 'path', id);
const prescriptionId = param('id', 'path', id);
const statuses = [400, 401, 403, 429];
const bookingErrors = [400, 401, 404, 409, 422, 429];
const staff = { auth: 'bearerAuth', errors: statuses } as const;

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'MedCore API',
    version: '1.0.0',
    description: 'Fault-tolerant booking, payments, prescriptions and audit.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/health': {
      get: operation({
        summary: 'Process liveness',
        output: object({ status: str }),
      }),
    },
    '/ready': {
      get: operation({ summary: 'MongoDB and Redis readiness', errors: [503] }),
    },
    '/metrics': {
      get: operation({
        summary: 'Prometheus counters and latency histogram',
        mime: 'text/plain',
        output: str,
      }),
    },
    '/api/docs.json': {
      get: operation({
        summary: 'OpenAPI specification',
        output: { type: 'object' },
        errors: [429],
      }),
    },
    '/api/docs': {
      get: operation({
        summary: 'Human-readable documentation',
        mime: 'text/html',
        output: str,
        errors: [429],
      }),
    },
    '/api/auth/register': {
      post: operation({
        summary: 'Register a patient',
        input: ref('Credentials'),
        output: object({ user: ref('User') }),
        ok: 201,
        errors: [400, 409, 429],
      }),
    },
    '/api/auth/login': {
      post: operation({
        summary: 'Issue an access token and refresh cookie',
        input: ref('Credentials'),
        output: ref('AccessToken'),
        setsCookie: true,
        errors: [400, 401, 429],
      }),
    },
    '/api/auth/refresh': {
      post: operation({
        summary: 'Rotate a refresh token and detect reuse',
        auth: 'refreshCookie',
        output: ref('AccessToken'),
        setsCookie: true,
        errors: [401, 429],
      }),
    },
    '/api/auth/logout': {
      post: operation({
        summary: 'Revoke the refresh family and clear the cookie',
        auth: 'refreshCookie',
        setsCookie: true,
        ok: 204,
        errors: [429],
      }),
    },
    '/api/doctors/profile': {
      post: operation({
        ...staff,
        summary: 'Create or update caller profile (doctor or admin)',
        input: ref('DoctorProfile'),
        output: object({ doctor: ref('Doctor') }),
      }),
    },
    '/api/doctors/nearby': {
      get: operation({
        summary: 'Search doctors by spherical distance',
        parameters: [
          param('lng', 'query', { ...num, minimum: -180, maximum: 180 }, true),
          param('lat', 'query', { ...num, minimum: -90, maximum: 90 }, true),
          param('maxDistanceKm', 'query', {
            ...num,
            default: 10,
            maximum: 20100,
          }),
          param('specialty', 'query', str),
        ],
        output: object({ doctors: array(ref('Doctor')) }),
        errors: [400, 429],
      }),
    },
    '/api/doctors/{doctorId}/slots': {
      get: operation({
        summary: 'List slots; from inclusive, to exclusive',
        parameters: [
          doctorId,
          param('status', 'query', slotStatus),
          param('from', 'query', date),
          param('to', 'query', date),
        ],
        output: object({ slots: array(ref('Slot')) }),
        errors: [400, 429],
      }),
      post: operation({
        ...staff,
        summary: 'Create slots (profile owner or admin)',
        parameters: [doctorId],
        input: {
          oneOf: [
            ref('SlotInput'),
            object({
              slots: { ...array(ref('SlotInput')), minItems: 1, maxItems: 100 },
            }),
          ],
        },
        output: object({ slots: array(ref('Slot')) }),
        ok: 201,
        errors: [...statuses, 404, 409],
      }),
    },
    '/api/bookings/hold': {
      post: operation({
        auth: 'bearerAuth',
        summary: 'Create a ten-minute slot hold',
        parameters: [idem],
        input: object({ slotId: id }),
        output: object({ appointment: ref('Appointment') }),
        ok: 201,
        errors: bookingErrors,
      }),
    },
    '/api/bookings/{appointmentId}/cancel': {
      post: operation({
        auth: 'bearerAuth',
        summary: 'Cancel a booking owned by the caller',
        parameters: [param('appointmentId', 'path', id), idem],
        output: object({ appointment: ref('Appointment') }),
        errors: bookingErrors,
      }),
    },
    '/api/payments/intent': {
      post: operation({
        auth: 'bearerAuth',
        summary: 'Create or retrieve a PaymentIntent for an owned hold',
        parameters: [idem],
        input: object({ appointmentId: id }),
        output: object({
          paymentIntentId: str,
          clientSecret: { ...str, nullable: true },
        }),
        ok: 201,
        errors: bookingErrors,
      }),
    },
    '/api/payments/webhook': {
      post: operation({
        auth: 'stripeSignature',
        summary: 'Accept a Stripe-signed raw JSON event',
        input: object({
          id: str,
          type: str,
          data: object({ object: { type: 'object' } }),
        }),
        output: {
          oneOf: [object({ received: bool }), object({ duplicate: bool })],
        },
        errors: [400, 500],
      }),
    },
    '/api/prescriptions': {
      post: operation({
        ...staff,
        summary: 'Create encrypted prescription (assigned doctor or admin)',
        input: ref('PrescriptionInput'),
        output: object({ id }),
        ok: 201,
        errors: [...statuses, 404, 503],
      }),
    },
    '/api/prescriptions/{id}': {
      get: operation({
        ...staff,
        summary: 'Read prescription (patient, prescribing doctor or admin)',
        parameters: [prescriptionId],
        output: ref('Prescription'),
        errors: [...statuses, 404, 500],
      }),
    },
    '/api/prescriptions/{id}/rotate-key': {
      post: operation({
        ...staff,
        summary: 'Rewrap the prescription DEK (admin only)',
        parameters: [prescriptionId],
        output: object({ keyId: str }),
        errors: [...statuses, 404, 409, 500],
      }),
    },
    '/api/audit/verify': {
      get: operation({
        ...staff,
        summary: 'Verify the full audit chain (admin only)',
        output: ref('AuditVerification'),
      }),
    },
    '/api/audit/anchor': {
      post: operation({
        ...staff,
        summary: 'Sign and store the current checkpoint (admin only)',
        output: ref('Anchor'),
        ok: 201,
        errors: [...statuses, 409, 503],
      }),
    },
    '/api/audit/anchor/verify': {
      get: operation({
        ...staff,
        summary: 'Verify the signed checkpoint and current tip (admin only)',
        output: {
          oneOf: [
            object({ valid: bool, seq: int }),
            object({ valid: bool, reason: str, brokenAtSeq: int }, [
              'valid',
              'reason',
            ]),
          ],
        },
      }),
    },
  },
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
      stripeSignature: {
        type: 'apiKey',
        in: 'header',
        name: 'Stripe-Signature',
      },
    },
  },
};

const escape = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const entries = Object.entries(openapi.paths)
  .flatMap(([path, methods]) =>
    Object.entries(methods).map(
      ([method, spec]) =>
        '<details><summary><code>' +
        method.toUpperCase() +
        ' ' +
        escape(path) +
        '</code> — ' +
        escape(spec.summary) +
        '</summary><pre>' +
        escape(JSON.stringify(spec, null, 2)) +
        '</pre></details>',
    ),
  )
  .join('\n');
const html =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>MedCore API</title><h1>MedCore API</h1><p><a href="/api/docs.json">OpenAPI 3.0 JSON</a></p>' +
  entries +
  '<details><summary>Schema definitions</summary><pre>' +
  escape(JSON.stringify(openapi.components, null, 2)) +
  '</pre></details></html>';

export const docsRouter = Router();
docsRouter.get('/docs.json', (_req, res) => res.json(openapi));
docsRouter.get('/docs', (_req, res) => res.type('html').send(html));
