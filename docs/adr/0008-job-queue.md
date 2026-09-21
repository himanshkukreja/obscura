# ADR-0008 — BullMQ on Redis, with PostgreSQL as the authoritative job record

**Status:** Accepted · 2026-09-20

## Context
Transcoding runs for minutes to hours and must never block an HTTP request. Failures must
be resumable at rendition granularity. Options: BullMQ/Redis, pg-boss/PostgreSQL, SQS,
RabbitMQ, or Postgres `SELECT … FOR UPDATE SKIP LOCKED` by hand.

## Decision
**BullMQ on Redis** for dispatch, with the `jobs` table in PostgreSQL as the authoritative
record of state. `JobQueue` is a port; pg-boss is the planned second implementation.

Work is decomposed so a failure costs only the failed unit, with idempotency key
`(asset_id, type, target, pipeline_version)`. A retried rendition job first checks storage
for complete, hash-verified output before doing any work.

## Alternatives considered

**pg-boss (Postgres only).** Genuinely attractive: one fewer service for small
deployments, and transactional enqueue with the state change. Rejected as the v1 default
because BullMQ's stalled-job detection via lock renewal matters a great deal for
hour-long jobs, and because Redis earns its place independently (rate limiting,
concurrent-session counters, replay caches) — it is not a service added solely for the
queue. Scheduled as the second `JobQueue` implementation for operators who want a single
datastore.

**SQS.** Good managed durability, but ties the default path to AWS and has awkward
visibility-timeout semantics for hour-long jobs. Supported later behind the port.

**RabbitMQ.** More operational surface than the problem justifies.

**Hand-rolled `SKIP LOCKED`.** Tempting and simple, but reimplements retries, backoff,
scheduling, progress and stall detection. Not worth it.

## Consequences
- Redis is a required service. It is one small container and it does more than queueing.
- **Redis persistence is not relied upon for correctness.** If Redis loses data, a
  reconciliation sweep re-enqueues from the `jobs` table. The queue is a dispatcher, not a
  source of truth.
- Workers scale independently and can go to zero. Because jobs are resumable, spot and
  preemptible instances are appropriate.
- Progress reporting is first-class, which the status endpoint needs.
