# ADR 004 · Tamper-evident audit chain

**Status** Accepted

## Context

The project needs evidence of edits, deletion, and replacement in booking confirmation and prescription creation audit records.

## Decision

Store the SHA-256 digest of canonical JSON plus sequence, previous hash, event type, timestamp, and entry hash. Advance the chain head and append the event under the business transaction. Verify from genesis using a snapshot and compare the result against the stored head. Administrators can sign the current checkpoint with Ed25519 and publish a sequence-specific file outside MongoDB. The verifier uses the public key to check the signature and compares the signed checkpoint with the chain.

## Consequences

The chain head serializes writes. Verification reads the entire chain. A valid older anchor proves the corresponding prefix, and a newer tip requires a new checkpoint for tip verification. The signing key and stored anchors are separate trust dependencies. Storage writable by the same attacker as MongoDB weakens the independent evidence.
