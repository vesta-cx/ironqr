# Diagnostics and Benchmark Boundary

Related: [[Pipeline Stage Contracts]], [[View Study]]

## Purpose
Define how `ironqr` should expose observability without growing benchmark-specific hooks.

## Core decision
Prefer:
- exported pipeline stages
- generic typed tracing / diagnostics

over:
- benchmark-only hooks
- benchmark mode flags
- ad hoc string logs

## Why
A benchmark package is a consumer of the scanner, not the owner of its architecture.

If `ironqr` grows special callback surfaces just for benchmark code, the production scanner starts carrying around instrumentation assumptions that do not belong in the core design.

## Boundary rule
`ironqr` should expose small, composable functions that a future benchmark package can call directly.

It may also expose a generic diagnostics API that is equally useful for:
- benchmarks
- tests
- local debugging
- future visualizers
- human review

## Preferred tracing shape
Use typed events.

Example shape:

```ts
export interface TraceSink {
  emit(event: IronqrTraceEvent): void;
}

export interface ScanRuntimeOptions extends ScanOptions {
  readonly traceSink?: TraceSink;
}

export type IronqrTraceEvent =
  | ScanStartedEvent
  | ScalarViewBuiltEvent
  | BinaryViewBuiltEvent
  | ProposalGeneratedEvent
  | ProposalRankedEvent
  | GeometryCandidateCreatedEvent
  | DecodeAttemptStartedEvent
  | DecodeAttemptFailedEvent
  | DecodeAttemptSucceededEvent
  | ScanFinishedEvent;
```

## Why typed events
Typed events make it possible to answer:
- which views were materialized?
- which proposal won?
- why did a proposal rank highly?
- how many geometry candidates were tried?
- which decode attempt finally succeeded?
- what failure class dominated a hard asset?

without scraping logs or building benchmark-specific branches.

## Trace cost policy
Diagnostics should be opt-in.

Default production scans should not pay for heavy trace capture unless a trace sink or explicit trace mode is requested.

A good cost ladder is:
- `off`: no per-event collection beyond ordinary scan work
- `summary`: aggregate counts and high-level failure summaries
- `full`: full typed event capture for debugging and study tooling

This lets `tools/bench` and one-off study scripts request richer diagnostics without turning production scans into benchmark-shaped code.

## Preferred default summaries
When full tracing is not needed, prefer summaries that answer the highest-value questions cheaply, such as:
- proposal count
- cluster count
- representative count
- dominant attempt-failure classes
- whether a cluster would have decoded, been killed, or exhausted under a given policy

Cluster-level summaries are usually a better default than large raw per-attempt event arrays.

## Convenience collector
A small in-memory collector is desirable:

```ts
export interface TraceCollector extends TraceSink {
  readonly events: readonly IronqrTraceEvent[];
}
```

That makes the same diagnostics surface easy to use in tests and debugging.

## Export policy
In addition to the top-level scan entry point, prefer exporting stage functions directly, such as:
- view builders
- proposal generators
- proposal rankers
- geometry-candidate builders
- decode-cascade runners

The benchmark package should be able to use either:
1. direct stage calls for focused experiments
2. top-level scan plus tracing for end-to-end measurements

## Public tuning boundary
If `ironqr` grows public tuning APIs, prefer exposing stable policy seams over raw internal stage wiring.

Good examples:
- proposal-view allowlists / ordering
- scanner profiles built from those allowlists
- decode-budget caps

Bad examples:
- arbitrary pipeline-stage reordering in `scanFrame(..., options)`
- benchmark-only knobs that reshuffle internal stages
- public promises that every rescue pass can be toggled independently forever

## Existing internal seam
The current internal pipeline already has a useful tuning seam: proposal generation can be driven by an explicit ordered `viewIds` list.

That is a good candidate for a future advanced API because it:
- matches the view-study terminology
- is meaningful to users with controlled QR populations
- does not force `scanFrame()` to expose every internal stage as a public contract

## Anti-patterns
Avoid:
- `benchmarkMode` flags in core pipeline logic
- stringly-typed trace messages
- giant state-dump events that carry everything at once
- one-off callbacks that only exist for a single benchmark script

## Scope note
This note defines the `ironqr` side of the boundary only.

A future benchmark package can consume these exports and traces, but the benchmark package itself is outside the scope of these `ironqr` architecture notes.
