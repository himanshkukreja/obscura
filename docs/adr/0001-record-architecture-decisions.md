# ADR-0001 — Record architecture decisions

**Status:** Accepted · 2026-09-20

## Context
This project makes several decisions that are expensive to reverse (container format,
encryption scheme, where authorization is enforced) and several that are easy to get
wrong in ways that only surface under load or attack. An open-source project also has to
explain itself to contributors who were not present for the reasoning.

## Decision
Every significant architectural decision is recorded here as a numbered, immutable ADR
with Context / Decision / Alternatives / Consequences. ADRs are never edited after
acceptance; they are superseded by a new ADR that references them.

## Consequences
A small ongoing writing cost. In exchange, "why is it like this?" has an answer that does
not depend on anyone's memory, and reversing a decision requires stating what changed.
