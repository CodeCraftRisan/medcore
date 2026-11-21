# ADR 003 · Envelope encryption and key management

**Status** Accepted

## Context

Prescription records contain sensitive medical content. Key rotation needs to preserve access to previously encrypted records.

## Decision

Generate a random 32-byte DEK per prescription. Encrypt its medical payload with AES-256-GCM, a fresh 12-byte IV, a 16-byte tag and appointment/patient AAD. Wrap the DEK with a separately configured KEK and store the KEK ID. An administrator can rewrap the DEK under the current KEK without rewriting the ciphertext. Keep older decryption keys until their records have been rotated.

## Consequences

A MongoDB-only snapshot contains ciphertext and reference metadata. Data access still depends on API authorization and application key availability. Distribute KEKs through an independently controlled secret store in deployed environments, back them up securely, and restrict access to both sets of material. Key loss can make records unreadable.
