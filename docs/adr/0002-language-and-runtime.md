# ADR-0002 — TypeScript on Node.js for API, worker and CLI

**Status:** Accepted · 2026-09-20

## Context
The backend orchestrates FFmpeg subprocesses, S3 I/O and PostgreSQL. The reference player
is unavoidably TypeScript. Node.js and Python (FastAPI) are both entirely capable.

## Decision
TypeScript (strict) on Node.js 22 LTS, with Fastify for HTTP. One language across API,
edge, worker, CLI and player.

## Alternatives considered

**Python + FastAPI.** Excellent framework; better ML ecosystem, which matters for future
invisible watermarking; arguably a larger pool of video-engineering contributors.
Rejected because the wire contracts (playback session, integrity manifest, watermark
policy, ladder config) would have to be defined twice or code-generated, and those
contracts are where this project's correctness lives. A generation step is a tax on every
contributor.

**Go.** Best single-binary distribution and lowest resource use for the edge service.
Rejected for v1: no shared types with the player, and a smaller contributor pool for a
project whose growth depends on contributions. A Go rewrite of `apps/edge` alone is a
reasonable future optimisation — it is the one component where the resource profile would
justify it.

**Rust.** Same reasoning as Go, more so.

## Consequences
- Shared `packages/shared` types are type-checked on both server and browser.
- Single toolchain: pnpm, Turborepo, Vitest, one lint config.
- **Accepted cost:** the strongest open-source invisible-watermarking and perceptual-
  hashing libraries are PyTorch (VideoSeal, MIT). We will want them in Phase 6+.
- **Mitigation, designed in now:** the worker already communicates only through the queue
  and object storage. A future `apps/watermark-worker` can be Python, consume the same
  queue, and never touch the TypeScript codebase. The language boundary sits on a seam
  that already exists rather than one we would have to create.
- **Hard rule:** FFmpeg is always a subprocess, never a linked library. This is both an
  isolation decision and a licensing one (see ADR-0009 and research.md).
