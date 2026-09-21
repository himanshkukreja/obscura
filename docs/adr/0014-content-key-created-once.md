# ADR-0014 — The content key is created in `process`, never lazily in `rendition`

**Status:** Accepted · 2026-09-21

## Context
Rendition jobs are independent and run concurrently — that is the point of the
decomposition, and it is what makes "720p ok, 480p ok, 360p failed" retry only 360p.

The first implementation created the asset's content key lazily, on first use inside the
rendition job:

```ts
let keyRow = (await contentKeys.forAsset(assetId))[0];
if (!keyRow) { /* generate, wrap, insert */ }
```

With `WORKER_CONCURRENCY=2` this is a read-then-write race. Two rendition jobs start
together, both observe "no key yet", and both insert one. `kid` is unique, so both
succeed. Different rungs are then encrypted under different keys while the manifest
advertises a single `kid`, and playback fails for whichever rendition lost the race.

It surfaced as an intermittent `bad decrypt` in the end-to-end suite — passing alone,
failing roughly every other time under load. Exactly the shape of bug that reaches
production because it looks like flakiness.

## Decision
The content key is generated once in the `process` job, before any rendition job is
enqueued. `runRendition` reads it and fails loudly (retryably) if it is absent — it never
creates one.

A unique index on `(asset_id, rotation_index)` makes the old failure mode unrepresentable
at the schema level, rather than relying on the application always being careful.

## Alternatives considered

**`INSERT … ON CONFLICT DO NOTHING` then re-read.** Would work, and is a smaller change.
Rejected as the primary fix because it leaves key creation on a hot, concurrent path where
the next contributor has to rediscover why the conflict clause matters. Creating it once,
up front, removes the concurrency from the question entirely.

**Advisory lock around key creation.** Correct but heavier, and it would still leave the
key's lifecycle spread across concurrent jobs.

**Serialise rendition jobs.** Rejected outright: parallel rungs are a deliberate design
property.

## Consequences
- Key creation is deterministic and happens exactly once per asset, which is also what
  makes deletion a single unambiguous act ([ADR-0011](0011-verified-deletion.md)).
- Rendition jobs stay fully parallel.
- The database constraint documents the invariant to anyone reading the schema.
- **Generalisable lesson:** any lazy "create if missing" inside a concurrent job is a race.
  Rotation, when it arrives, must be planned with this in mind rather than bolted on.
