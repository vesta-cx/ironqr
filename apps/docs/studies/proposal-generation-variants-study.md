# Proposal Generation Variants Study

## Problem / question

After detector-policy evidence binned flood-heavy proposal policies, the next bottleneck is proposal generation itself: assembling finder triples, retaining the top triples, and constructing proposal objects. This study asks which proposal assembly implementation preserves output while reducing proposal-generation time.

The production change under study is the implementation of finder-triple assembly inside proposal generation, not detector-family selection.

## Hypothesis / thesis

The current control scores every finder triple, materializes all scored candidates, sorts them, and slices the existing top set. For views with many finder evidences, sorting and retaining every candidate may waste work even when every candidate is still scored.

Expected result:

```text
streaming top-k scores the same triples, preserves exact output, and reduces triple-assembly time
```

Null hypothesis: exhaustive `sort-all` remains necessary because streaming does not improve time or cannot preserve exact proposal output.

## Designed experiment / study

Run:

```bash
bun run --cwd tools/bench bench study proposal-generation-variants --detector-policy no-flood
```

Default detector policy is `no-flood` because proposal-policy evidence showed it is proposal-equivalent to `full-current` while removing flood cost. Historical slow controls remain available in `proposal-detector-policy` via explicit `--policies`, but they are no longer the default permutation set.

Variants:

| Variant | Behavior | Question answered |
| --- | --- | --- |
| `sort-all` | Current control: materialize every valid triple, sort all, slice top combinations. | Baseline output and cost. |
| `streaming-topk` | Score every valid triple but maintain only the top-K triples incrementally. | Can we preserve exact output while avoiding full materialization/sort? |

Default corpus: all approved assets, all default binary views. Cache is study-level per asset/config; use `--refresh-cache` when changing variant implementation.

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Proposal asset coverage | assets | Must match control. |
| Positive proposal asset coverage | assets | Mandatory recall guard. |
| Negative proposal asset coverage | assets | Safety/frontier-shape guard. |
| Proposal count | proposals | Detects frontier changes. |
| Proposal signature mismatch assets | assets | Exact-output test versus `sort-all`. |
| Proposal count mismatch assets | assets | Coarse output divergence. |
| Lost/gained positive asset ids | asset ids | Explains recall changes. |
| Triple count | triples | Assembly workload. |
| `tripleAssemblyMs` | ms | Primary implementation cost metric. |
| `proposalViewMs` / `scanDurationMs` | ms | End-to-end proposal-generation impact. |
| Detector timings | ms | Confirm detector work is unchanged across assembly variants. |

## Decision rule

Promote `streaming-topk` only if:

```text
proposal signature mismatches = 0
proposal count mismatches = 0
positive proposal asset delta = 0
tripleAssemblyMs improves materially
```

## Results

Pending. Run the study before changing production proposal assembly.

## Interpretation plan

First compare `streaming-topk` with `sort-all` for exact proposal signatures. If exact and faster, it is the safest implementation-level win. Do not include capped evidence, early-exit, or budget variants in this study; those belong in a separate policy/budget study after exact implementation work is exhausted.

## Conclusion / evidence-backed decision

Pending generated study evidence.
