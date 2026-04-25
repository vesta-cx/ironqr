# Proposal Detector Policy Study

## Problem / question

Detector-only evidence has identified faster finder implementations and measured overlap, but it does not decide production proposal/decode policy. The study asks:

1. Can flood-fill be removed without changing positive decodes, false positives, or proposal/decode failure behavior?
2. Can matcher become a staged rescue path instead of always running after row-scan?
3. Can matcher skip row-scan-overlapping finders without losing proposal/decode capability?
4. What are the contribution bounds of row-scan, flood, and matcher when each family is isolated or paired?

The production change under study is the detector-family policy feeding proposal generation, not detector-local implementation details.

## Hypothesis / thesis

Overlap evidence suggests flood is mostly dominated by row-scan and matcher, while matcher carries most retained evidence. The likely production policy is either:

```text
row-scan + matcher + dedupe -> proposals
```

or a staged policy:

```text
row-scan -> proposals/decode
if no decode: matcher -> proposals/decode
```

The null hypothesis is that the current full detector stack remains necessary:

```text
row-scan + flood + matcher + dedupe -> proposals/decode
```

No detector family should be disabled, gated, or overlap-suppressed unless a full proposal/decode study preserves decoded positives and false-positive behavior.

## Designed experiment / study

Run a new study plugin:

```bash
bun run --cwd tools/bench bench study proposal-detector-policy --view-set all
```

The study uses all 54 binary view identities with production-like decode behavior by default:

```text
allowMultiple: false
maxProposals: 24
maxClusterRepresentatives: 1
maxClusterStructuralFailures: 10_000
maxDecodeAttempts: 200
continueAfterDecode: false
proposalViewIds: all default binary views
```

The global proposal, representative, and decode-attempt budgets are flags (`--max-proposals`, `--max-cluster-representatives`, `--max-decode-attempts`) so follow-up exhaustive budget studies can widen them deliberately. The first policy question is production-behavior equivalence, so defaults stay bounded enough to run the full policy matrix.

Policies:

| Policy | Detector/proposal behavior | Question answered |
| --- | --- | --- |
| `full-current` | `row-scan + flood + matcher -> dedupe -> proposals` | Control. |
| `no-flood` | `row-scan + matcher -> dedupe -> proposals` | Is flood removable? |
| `row-only` | `row-scan -> proposals` | How much capability does row-scan carry alone? |
| `row-plus-flood` | `row-scan + flood -> dedupe -> proposals` | Does flood matter when matcher is absent? |
| `matcher-only` | `matcher -> proposals` | How much capability does matcher carry alone? |
| `matcher-no-row-overlap` | `row-scan + matcher`, with matcher outputs overlapping row-scan suppressed before dedupe | Can matcher avoid duplicate row-scan work safely? |
| `row-first-fallback-on-no-decode` | run row-only first; if it does not decode, run `no-flood` as rescue | Can matcher be staged as a rescue path? |

The fallback policy is measured conservatively: a fallback asset pays row-only plus rescue cost. A production implementation could reuse intermediate row-scan work, so this study should treat fallback timing as an upper bound unless reuse is later implemented and measured.

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive decoded assets | assets | Primary recall; must match control for promotion. |
| False-positive assets | assets | Safety; must not increase. |
| Lost/gained positive asset ids | asset ids | Explains regressions or rescue behavior. |
| Decoded payloads | strings | Equivalence of outputs, not just count. |
| Proposal count / bounded proposal count | count | Proposal frontier size. |
| Ranked proposal count | count | Ranking workload. |
| Cluster count / representative count | count | Decode frontier size. |
| Processed representatives | count | Actual cluster work. |
| First decoded cluster rank | rank | Decode budget evidence. |
| Decode attempts / successes | count | Downstream cost and effort. |
| Row/flood/matcher/deduped finder counts | count | Detector contribution under policy. |
| Expensive detector view count | views | Staging/gating effectiveness. |
| Proposal-view, detector, ranking, clustering, structure, module-sampling, decode timings | ms | Cost attribution; nested timings must not be double-counted as independent wall time. |

## Decision rule

### Flood removal

Promote `no-flood` only if, relative to `full-current`:

```text
positive decoded assets unchanged
false-positive assets unchanged
decoded payloads equivalent
no new proposal/decode failure class dominates
cost improves or is neutral
```

### Staged matcher rescue

Promote `row-first-fallback-on-no-decode` only if it preserves `full-current` positive/false-positive behavior and materially reduces expensive detector executions or proposal/decode wall time. Because the current implementation measures fallback by running a second scan, follow-up implementation may be needed to measure reused-work production timing.

### Matcher overlap suppression

Promote `matcher-no-row-overlap` only if it preserves decode outcomes and reduces matcher/proposal/decode effort. If it loses positives, keep plain dedupe and do not suppress matcher outputs before proposal generation.

### Contribution bounds

Use `row-only`, `row-plus-flood`, and `matcher-only` to explain why a policy wins or loses. Do not promote these bound policies unless they independently satisfy the same decode/false-positive admission rule.

## Report contract

Expected reports:

```text
tools/bench/reports/full/study/study-proposal-detector-policy.json
tools/bench/reports/study/study-proposal-detector-policy.summary.json
```

The processed summary must include:

- per-policy decoded positive count and false-positive count;
- per-policy lost/gained positive asset ids relative to `full-current`;
- per-policy proposal, cluster, representative, and decode-attempt counts;
- first-success cluster-rank percentiles;
- detector/proposal/decode timing totals;
- comparisons versus `full-current`.

## Results

Pending. Run the study before changing production policy.

## Interpretation plan

First inspect `no-flood` versus `full-current`. If equivalent, flood is a deletion/gating candidate. Then inspect `row-first-fallback-on-no-decode` to decide whether matcher can be staged. Finally inspect `matcher-no-row-overlap`; if it loses any positives, matcher overlap should remain a dedupe concern rather than an early suppression policy.

## Conclusion / evidence-backed decision

Pending generated study evidence.
