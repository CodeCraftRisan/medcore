# ADR 002 · Dual-layer booking concurrency control

**Status** Accepted

## Context

Many requests can target the same available slot. Redis can be lost, and a lease can expire before a process finishes.

## Decision

Use Redis SET with NX and PX for fast rejection. Release the lease using an atomic Lua comparison against its random ownership token. If Redis is unavailable, continue to MongoDB. In one transaction, change a slot only when it is available, insert the pending appointment, and finish the request's idempotency record. MongoDB indexes enforce one slot per doctor/start time and at most one pending or confirmed appointment per slot.

## Consequences

The database protects the invariant after lock loss and across API replicas. The Redis fast path adds a network round trip and reduces contention only when enough requests overlap the lease. The research benchmark isolates database and lock strategies, while the HTTP test exercises the full application contract.
