# ADR 001 · Modular monolith and transactional outbox

**Status** Accepted

## Context

Booking, payment, and prescription operations share consistency rules. Delayed work needs independent scheduling and retries. Separate services with independent databases would require distributed coordination for these operations.

## Decision

Keep domain modules and shared models in the API workspace. Run the BullMQ worker as a separate process on the same application code and MongoDB replica set. Commit successful payment state, audit entry, and the corresponding outbox event in one transaction. The relay writes an inbox record with the outbox ID and marks the source processed in the same MongoDB transaction.

Use a unique Stripe event ID for delivery deduplication and idempotent Stripe requests for external side effects. Store a late refund obligation before calling Stripe. Reconciliation polls pending payments and resumes outstanding refunds.

## Consequences

API and worker scale independently while sharing the schema. Worker downtime delays the relay and expiry; queued or database-backed work remains recoverable. The current relay target is MongoDB's durable inbox. Downstream email, PDF, or notification consumers need their own durable deduplication and delivery monitoring.
