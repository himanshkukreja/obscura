# ADR-0010 — npm-workspaces monorepo with a separated control and data plane

**Status:** Accepted · 2026-09-20

## Context
The project has five deployable units and several shared libraries. Shared types between
the browser player and the backend are a primary motivation for the language choice
(ADR-0002).

## Decision
An npm-workspaces monorepo using TypeScript project references for the build graph,
`apps/*` for deployables and `packages/*` for libraries. `apps/api` (control plane) and `apps/edge` (data plane) are
**separate applications** that can deploy as one container or two.

## Alternatives considered

**Polyrepo.** Rejected: the shared-types benefit disappears, and a contributor would have
to make coordinated changes across repositories to touch a wire contract.

**A single application.** Simpler to start. Rejected: the control plane and the data plane
have different scaling profiles and different network exposure. `edge` is
request-heavy, latency-sensitive and must be reachable by browsers; `api` is low-volume
and can sit behind stricter policy. Splitting later means changing every deployment.

**pnpm workspaces.** Originally chosen for strict dependency isolation, which prevents the
phantom-dependency class of bug. Reversed during implementation: pnpm requires a global
install, and the project's pitch is `git clone && docker compose up`. Every prerequisite
beyond Node and Docker is friction for exactly the contributor we want. npm workspaces ship
with the Node version we already require. The isolation benefit is real but smaller than
the setup cost for a project this size; revisit if phantom dependencies actually bite.

**Turborepo / Nx for the task graph.** Not needed — TypeScript project references already
give incremental, dependency-ordered builds via `tsc --build`. One less tool.

## Consequences
- Small installs run one container with both route trees; production runs two.
- `packages/streaming` from the original brief is split into `media` (producing HLS) and
  `delivery` (authorizing it) — unrelated concerns with different dependencies. The worker
  needs `media` and not `delivery`; `edge` needs the reverse.
- `packages/db` gets its own home for migrations and repositories rather than crowding
  `shared`.
- One CI pipeline, one lint config, one test runner.
- **Accepted cost:** a monorepo is slightly more intimidating to a first-time contributor.
  Mitigated with a `CONTRIBUTING.md` map and per-package READMEs.
