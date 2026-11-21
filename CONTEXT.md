# Project Name: MedCore (Fault-Tolerant Doctor Booking Engine)

## 1. Core Vision
A fault-tolerant doctor appointment booking system where under high concurrency a slot is never double-booked, failed payments self-heal, sensitive data uses envelope encryption, and every critical event is logged in a tamper-evident hash chain.

## 2. Architecture: Modular Monolith
- Single monorepo containing `apps/api` (Express API), `apps/worker` (BullMQ background processor), and `apps/web` (React SPA).
- Database: MongoDB Replica Set (Source of truth) + Redis (Locks, Rate Limiting, BullMQ Queue).

## 3. Tech Stack & Strict Rules
- **Language:** TypeScript (Strict mode) everywhere.
- **Backend (`apps/api` & `apps/worker`):** Node.js, Express, Mongoose, Redis (ioredis), BullMQ, Zod (validation), Pino (structured logging), Argon2id (password hashing), Stripe (payments).
- **Frontend (`apps/web`):** React, Vite, TypeScript, Tailwind CSS, TanStack Query, React Hook Form + Zod.
- **Testing:** Vitest + Supertest + Testcontainers (real Mongo & Redis) + k6 (load testing).

## 4. Folder Structure
medcore/
├── apps/
│   ├── api/src/
│   │   ├── modules/ (auth, doctor, booking, payment, prescription, audit)
│   │   ├── shared/ (middleware, crypto, lock, outbox, observability)
│   │   ├── app.ts
│   │   └── server.ts (graceful shutdown)
│   ├── worker/src/ (jobs: outboxRelay, expireHolds, reconcile, anchor)
│   └── web/
├── loadtest/
├── docs/
└── docker-compose.yml

## 5. Non-Negotiable Engineering Rules (MUST FOLLOW)
1. **Double-Booking Prevention:** Redis lock (`SET NX PX` + Lua release) is ONLY an optimization for fast rejection (409). The REAL guarantee MUST be MongoDB atomic conditional update (`findOneAndUpdate` where `status: 'available'`) + Unique Indexes (`slots: {doctorId, startAt}` and partial unique index on `appointments.slotId` where status is active).
2. **State Machine:** Slot states: `available` -> `held` (10 min expiry) -> `booked`.
3. **Transactional Outbox Pattern:** Never send emails/PDFs directly inside the request lifecycle. Write events to the `outbox` collection inside the MongoDB ACID transaction, and let `apps/worker` process them.
4. **Idempotency:** All booking/payment mutations require an `Idempotency-Key` header checked against `idempotency_keys` collection (with `requestHash` verification). Stripe webhooks must deduplicate via `stripe_events` collection.
5. **Audit Log:** Tamper-evident hash chain (`SHA256(seq | prevHash | type | payloadHash | ts)`). Store only `payloadHash` (no raw PII/PHI).
6. **Encryption:** Use Envelope Encryption (`AES-256-GCM`) for prescriptions. Each record gets a random 32-byte DEK wrapped by a KEK, with `AAD = appointmentId + patientId`.
7. **Auth:** 15-min JWT Access Token + Refresh Token Rotation (`familyId` tracking; if an old token is reused, revoke the entire family).
8. **Code Quality:** Write integration/unit tests for every module. Never hardcode secrets. Validate all inputs with Zod.