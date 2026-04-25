# Proposal Generation Variants Study

## Problem / question

After detector-policy evidence binned flood-heavy proposal policies, the next bottleneck is proposal generation itself: assembling finder triples, retaining the top triples, and constructing proposal objects. This study asks which proposal assembly implementation preserves output while reducing proposal-generation time.

The production change under study is the implementation of finder-triple assembly inside proposal generation, not detector-family selection.

## Hypothesis / thesis

The current control scores every finder triple, materializes all scored candidates, sorts them, and slices the top set. For views with many finder evidences, sorting and retaining every candidate may waste work when only the top `MAX_TRIPLE_COMBINATIONS` are used.

Expected result:

```text
streaming top-k preserves exact output and reduces triple-assembly time
```

Lossy evidence caps (`top48-streaming`, `top32-streaming`) may reduce work further, but must not be promoted unless positive proposal coverage remains intact and proposal frontier reduction is intentional.

Null hypothesis: exhaustive `sort-all` remains necessary because streaming/capped variants either do not improve time or lose required proposals.

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
| `top48-streaming` | Keep top 48 detector evidences before streaming top-K assembly. | Does capping evidence reduce cost without losing positive proposal coverage? |
| `top32-streaming` | Keep top 32 detector evidences before streaming top-K assembly. | More aggressive evidence cap / frontier reduction bound. |

Default corpus: all approved assets, all default binary views. Cache is study-level per asset/config; use `--refresh-cache` when changing variant implementation.

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Proposal asset coverage | assets | Must match control for exact-output or safe lossy variants. |
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

### Exact implementation replacement

Promote `streaming-topk` only if:

```text
proposal signature mismatches = 0
proposal count mismatches = 0
positive proposal asset delta = 0
tripleAssemblyMs improves materially
```

### Lossy evidence caps

Promote `top48-streaming` or `top32-streaming` only if:

```text
positive proposal asset delta = 0
negative proposal behavior is acceptable
proposal frontier reduction is intentional
follow-up decode confirmation accepts the reduced frontier
```

Lossy variants are candidates for policy studies, not immediate production replacements.

## Results

Pending. Run the study before changing production proposal assembly.

## Interpretation plan

First compare `streaming-topk` with `sort-all` for exact proposal signatures. If exact and faster, it is the safest implementation-level win. Then inspect capped variants for positive proposal coverage and proposal-count reduction; if they retain positives, use them to design a decode-level frontier-reduction study.

## Conclusion / evidence-backed decision

Pending generated study evidence.
