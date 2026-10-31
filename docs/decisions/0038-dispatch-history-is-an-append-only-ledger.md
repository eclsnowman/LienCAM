# 0038 - Dispatch history is an append-only ledger

Date: 2026-08-11
Status: Accepted

## Context

Work-order frontmatter describes the order now. Its `seat`, `priority`, tier,
and evidence fields can change when an order is corrected or re-seated, so
reading today's values cannot answer which model handled an earlier attempt or
why that model was selected. Runner logs under `.worktrees/` contain some of
that evidence, but cleanup removes them and Git does not preserve them.

Routing decisions need durable observations rather than reconstructed guesses.

## Decision

The runner appends dispatch and terminal-outcome records to
`queue/ledger/dispatch.jsonl`. Each dispatch record freezes the work-order
metadata, requested and effective seats, explicitly pinned model ID, role,
resolution reason, attempt, tier, and evidence tier at the time the child
process starts. Terminal records freeze landed, failed, parked, and held
outcomes with the runner's reason.

The file is append-only: existing bytes are never rewritten, reordered, or
deleted. Each record is serialized as one short JSON line and written with one
append call. Readers isolate damage by skipping an unparseable line and
reporting the corrupt-line count.

Frontmatter remains the source of current work-order configuration, but it may
never be treated as historical evidence. No routing or Mission Control behavior
reads the ledger as part of this decision; later work orders may add consumers
after real observations exist.

Ledger I/O is fail-open for work-order execution. A write error is logged
loudly, but recording machinery cannot fail the work it observes. Accumulated
ledger appends are staged with the next durable work-order lifecycle commit,
not committed once per event.

## Alternatives considered

### Reconstruct history from current frontmatter

Rejected. Re-seating overwrites the very fact the history is meant to retain.

### Preserve `.worktrees/` runner logs indefinitely

Rejected. Runtime logs are cleanup artifacts, not a Git-tracked contract, and
retaining them would still leave consumers parsing prose rather than records.

### Rewrite a single JSON array atomically

Rejected. Every write would replace all prior bytes, increasing concurrent
writer risk and making accidental history edits mechanically easy.

### Backfill old work orders now

Rejected. Historical rows would be inferred rather than observed. Mixing them
into the trusted ledger without an explicit inferred marker would weaken every
future routing conclusion.

## Consequences

- New dispatches and terminal outcomes have durable, machine-readable history.
- Concurrent writers do not coordinate through a mutable aggregate document.
- One corrupt line reduces the readable count but does not hide later events.
- The ledger can miss observations during an I/O outage; the runner continues
  and emits a loud diagnostic instead of converting bookkeeping into a gate.
- Current frontmatter and historical events have separate, explicit purposes.

## References

- `tools/dispatch-ledger.mjs`
- `tools/runner.mjs`
- `queue/ledger/dispatch.jsonl`
- `src/tests/tools/dispatchLedger.wo177.test.ts`
- `queue/WO-177-write-down-what-actually-happened.md`
