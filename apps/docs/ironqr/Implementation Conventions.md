# Implementation Conventions

Related: [[Pipeline Stage Contracts]], [[Diagnostics and Benchmark Boundary]]

## Purpose
Capture the engineering rules that shape the current `ironqr` architecture independent of any one pipeline stage.

## Renaming policy
Feel free to rename essentially everything.

That includes:
- files
- directories
- functions
- types
- internal data structures
- helper modules

If an existing name encodes the old threshold-loop architecture, prefer replacing it rather than preserving it.

## Documentation policy
### Exported members
Document all exported members.

That includes:
- exported functions
- exported types and interfaces
- exported constants
- exported classes if any exist
- public entry points

### Human-review-critical areas
Add rationale comments or local documentation wherever it materially helps manual review, especially around:
- proposal scoring
- search-order decisions
- clustering policy
- early exits
- geometry candidate generation
- decode-cascade ordering
- tracing event semantics

Short rule:
> exported surfaces need API docs, tricky decisions need rationale docs.

## Effect v4 beta policy
Use Effect v4 beta internally wherever it helps and does not actively hurt.

### Good places for Effect
- top-level orchestration
- stage composition
- error channel modeling
- resourceful workflows
- optional diagnostics emission
- boundary adapters where composition clarity matters

### Bad places to force Effect
- tiny numeric kernels
- hot inner loops
- code that becomes materially slower or noisier when wrapped unnecessarily

Short rule:
> use Effect for orchestration and boundaries, not as decorative syntax in hot math.

## Error policy
- validate at trust boundaries
- propagate failures through the pipeline
- swallow only expected candidate-level failures
- keep internal errors visible

## Module policy
Do not create a new god-file scanner.

Prefer stage-oriented modules with clear contracts.

## Testing policy
Every architectural decision should become testable in isolation.

That means the scanner architecture should prefer directly callable stage functions over hidden orchestration-only logic.

## Compatibility policy
Preserving the public API shape is useful when cheap, but architecture wins over internal compatibility.

If compatibility becomes the reason the new design stays muddy, pick the cleaner design and document the migration.
