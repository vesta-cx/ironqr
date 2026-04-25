# Proposal Detector Policy Study

## Problem / question

Detector-only evidence has identified faster finder implementations and measured overlap, but it does not decide production proposal policy. The study asks:

1. Can flood-fill be removed without changing positive proposal coverage, negative proposal behavior, or proposal frontier shape?
2. Can matcher become a staged rescue path instead of always running after row-scan?
3. Can matcher skip row-scan-overlapping finders without losing proposal-generation capability?
4. What are the contribution bounds of row-scan, flood, and matcher when each family is isolated or paired?

The production change under study is the detector-family policy feeding proposal generation, not detector-local implementation details.

## Hypothesis / thesis

Overlap evidence suggests flood is mostly dominated by row-scan and matcher, while matcher carries most retained evidence. The likely production policy is either:

```text
row-scan + matcher + dedupe -> proposals
```

or a staged policy:

```text
row-scan -> proposals
if no proposals: matcher -> proposals
```

The null hypothesis is that the current full detector stack remains necessary:

```text
row-scan + flood + matcher + dedupe -> proposals
```

No detector family should be disabled, gated, or overlap-suppressed unless a full proposal study preserves positive proposal coverage and negative proposal behavior.

## Designed experiment / study

Run a new study plugin:

```bash
bun run --cwd tools/bench bench study proposal-detector-policy --view-set all
```

The study uses all 54 binary view identities with production-like proposal behavior by default:

```text
maxProposalsPerView: 24
proposalViewIds: all default binary views
no decode cascade
```

The proposal budget is a per-view cap (`--max-proposals`). Decode, clustering, and representative budgets are intentionally not exercised in this proposal-only phase.

Policies:

| Policy | Detector/proposal behavior | Question answered |
| --- | --- | --- |
| `full-current` | `row-scan + flood + matcher -> dedupe -> proposals` | Control. |
| `no-flood` | `row-scan + matcher -> dedupe -> proposals` | Is flood removable? |
| `row-only` | `row-scan -> proposals` | How much capability does row-scan carry alone? |
| `row-plus-flood` | `row-scan + flood -> dedupe -> proposals` | Does flood matter when matcher is absent? |
| `matcher-only` | `matcher -> proposals` | How much capability does matcher carry alone? |
| `matcher-no-row-overlap` | `row-scan + matcher`, with matcher outputs overlapping row-scan suppressed before dedupe | Can matcher avoid duplicate row-scan work safely? |
| `row-first-fallback-on-no-proposals` | run row-only first; if it emits no proposals, run `no-flood` as rescue | Can matcher be staged as a proposal rescue path? |

The fallback policy is measured conservatively: a fallback asset pays row-only plus rescue proposal-generation cost. A production implementation could reuse intermediate row-scan work, so this study should treat fallback timing as an upper bound unless reuse is later implemented and measured.

## Metrics table

| Metric | Unit | Decision use |
| --- | --- | --- |
| Positive assets with proposals | assets | Primary proposal coverage; must match control for promotion. |
| Negative assets with proposals | assets | Safety; must not increase. |
| Lost/gained positive asset ids | asset ids | Explains regressions or rescue behavior. |
| Proposal count / bounded proposal count | count | Proposal frontier size. |
| Row/flood/matcher/deduped finder counts | count | Detector contribution under policy. |
| Expensive detector view count | views | Staging/gating effectiveness. |
| Proposal-view and detector timings | ms | Cost attribution; nested timings must not be double-counted as independent wall time. |

## Decision rule

### Flood removal

Promote `no-flood` only if, relative to `full-current`:

```text
positive proposal coverage unchanged
negative proposal behavior unchanged
proposal frontier remains explainable
no new proposal failure class dominates
cost improves or is neutral
```

### Staged matcher rescue

Promote `row-first-fallback-on-no-proposals` only if it preserves `full-current` positive proposal coverage / negative proposal behavior and materially reduces expensive detector executions or proposal wall time. Because the current implementation measures fallback by running a second proposal pass, follow-up implementation may be needed to measure reused-work production timing.

### Matcher overlap suppression

Promote `matcher-no-row-overlap` only if it preserves proposal coverage and reduces matcher/proposal effort. If it loses positives, keep plain dedupe and do not suppress matcher outputs before proposal generation.

### Contribution bounds

Use `row-only`, `row-plus-flood`, and `matcher-only` to explain why a policy wins or loses. Do not promote these bound policies unless they independently satisfy the same proposal/negative admission rule.

## Report contract

Expected reports:

```text
tools/bench/reports/full/study/study-proposal-detector-policy.json
tools/bench/reports/study/study-proposal-detector-policy.summary.json
```

The processed summary must include:

- per-policy positive-with-proposal count and negative-with-proposal count;
- per-policy lost/gained positive asset ids relative to `full-current`;
- per-policy proposal counts;
- detector/proposal timing totals;
- comparisons versus `full-current`.

## Results

Pending. Run the study before changing production policy.

## Interpretation plan

First inspect `no-flood` versus `full-current`. If equivalent at proposal level, flood is a deletion/gating candidate for a later decode-confirmation study. Then inspect `row-first-fallback-on-no-proposals` to decide whether matcher can be staged at proposal-generation time. Finally inspect `matcher-no-row-overlap`; if it loses any positive proposal coverage, matcher overlap should remain a dedupe concern rather than an early suppression policy.

## Conclusion / evidence-backed decision

Pending generated study evidence.
