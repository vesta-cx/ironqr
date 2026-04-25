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
| `streaming-topk` | Score every valid triple but maintain only the top-K triples incrementally with insertion/splice. | Can we preserve exact output while avoiding full materialization/sort? |
| `fixed-array-topk` | Score every valid triple and maintain a fixed-size sorted top-K array. | Does avoiding dynamic array growth/splice improve top-K retention? |
| `min-heap-topk` | Score every valid triple and keep top-K in a worst-first heap, then sort the retained K. | Is heap retention faster than sorted insertion for K=120? |
| `distance-matrix-sort-all` | Precompute pair distances, then use sort-all retention. | Does reusing pair distances beat direct distance calls? |
| `distance-matrix-streaming` | Precompute pair distances, then use streaming top-K retention. | Do distance reuse and top-K retention compound? |
| `no-allocation-score` | Score every valid triple with manual side selection instead of per-triple side array allocation/sort. | Does allocation-free geometry scoring preserve output and improve assembly time? |

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

Promote any exact implementation variant only if:

```text
proposal signature mismatches = 0
proposal count mismatches = 0
positive proposal asset delta = 0
tripleAssemblyMs improves materially
```

## Results

Confirmation run generated `2026-04-25T22:13:00.671Z` from commit `49d24a9c37d1d0e4389687733b8b9cbdcfd3b8f6` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-generation-variants.json
tools/bench/reports/study/study-proposal-generation-variants.summary.json
```

Run shape:

```text
assets=203 positives=60 negatives=143
detectorPolicyId=no-flood maxViews=54 maxProposals=24
variants=sort-all,no-allocation-score,distance-matrix-streaming,min-heap-topk
cache hits=0 misses=406 writes=203
```

| Variant | Proposal signatures mismatched assets | Proposals | Triple count | Triple assembly ms | Scan ms | Triple assembly delta vs `sort-all` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `sort-all` | 0 | 168,366 | 540,894 | 650.92 | 289,895.35 | — |
| `no-allocation-score` | 0 | 168,366 | 540,894 | 407.46 | 276,935.32 | -243.46ms / -37.40% |
| `distance-matrix-streaming` | 0 | 168,366 | 540,894 | 452.49 | 276,516.52 | -198.43ms / -30.48% |
| `min-heap-topk` | 0 | 168,366 | 540,894 | 578.57 | 275,587.77 | -72.35ms / -11.12% |

All confirmation variants preserved positive proposal-asset coverage (`60/60`), negative proposal-asset behavior (`143/143`), proposal counts, and proposal signatures. The post-fix `min-heap-topk` is now exact on the full corpus, but it is slower on the primary `tripleAssemblyMs` metric than the two leading candidates.

## Interpretation plan

First compare each variant with `sort-all` for exact proposal signatures. If exact and faster, it is a safe implementation-level candidate. Do not include capped evidence, early-exit, or budget variants in this study; those belong in a separate policy/budget study after exact implementation work is exhausted.

The best full-run exact candidate is `no-allocation-score`, reducing triple assembly by `37.40%` while preserving proposal signatures. `distance-matrix-streaming` is second at `30.48%`. Because triple assembly is small relative to detector and view work, total scan improvement is about `4–5%`; scan-time ordering is noisy because each variant reruns detector/view work, so `tripleAssemblyMs` is the primary decision metric.

## Conclusion / evidence-backed decision

Promote `no-allocation-score` as the proposal assembly implementation candidate: it is exact on proposal signatures and is fastest on the primary isolated assembly metric. Keep `distance-matrix-streaming` as the backup candidate. Bin `min-heap-topk` for now: it is exact after the fix but does not win the primary metric.
