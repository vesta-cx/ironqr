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

Full proposal-only run generated `2026-04-25T21:24:03.240Z` from commit `0b1454bc0c07cdb7a0a36f191e1b22ffc2bde524` with dirty working tree state. Reports:

```text
tools/bench/reports/full/study/study-proposal-detector-policy.json
tools/bench/reports/study/study-proposal-detector-policy.summary.json
```

Run shape:

```text
assets=203 positives=60 negatives=143
viewSet=all maxViews=54 maxProposals=24
cache hits=0 misses=203 writes=203
```

| Policy | Positive assets with proposals | Negative assets with proposals | Proposals | Scan ms | Row ms | Flood ms | Matcher ms | Expensive views | Fallback assets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `full-current` | 60 | 143 | 168,366 | 533,914.26 | 68,755.15 | 212,503.17 | 188,132.05 | 8,347 | 0 |
| `no-flood` | 60 | 143 | 168,366 | 306,914.19 | 66,560.80 | 0.56 | 181,063.29 | 8,347 | 0 |
| `row-only` | 60 | 142 | 159,305 | 125,062.77 | 66,185.86 | 0.77 | 0.74 | 0 | 0 |
| `row-plus-flood` | 60 | 142 | 159,315 | 331,921.64 | 66,666.78 | 205,188.85 | 6.46 | 8,347 | 0 |
| `matcher-only` | 60 | 141 | 24,801 | 83,801.89 | 3.39 | 0.23 | 27,987.35 | 1,218 | 0 |
| `matcher-no-row-overlap` | 60 | 143 | 163,773 | 305,416.80 | 65,982.86 | 0.69 | 180,310.02 | 8,347 | 0 |
| `row-first-fallback-on-no-proposals` | 60 | 143 | 159,309 | 124,386.92 | 65,828.69 | 0.60 | 111.60 | 24 | 1 |

Compared with `full-current`:

- `no-flood` matched positive coverage, negative proposal behavior, and proposal count exactly; scan time dropped by `227,000.07ms` (`42.52%`).
- `matcher-no-row-overlap` matched positive coverage and negative proposal behavior while emitting `4,593` fewer proposals and reducing scan time by `228,497.46ms` (`42.80%`).
- `row-first-fallback-on-no-proposals` matched positive coverage and negative proposal behavior, emitted `9,057` fewer proposals, used fallback on one negative asset (`asset-a63ebea2df94c77a`), and reduced scan time by `409,527.34ms` (`76.70%`).
- `row-only`, `row-plus-flood`, and `matcher-only` all retained positive proposal coverage but reduced negative assets with proposals; these are contribution-bound controls, not strict full-current equivalents.

## Interpretation plan

This proposal-only run answers proposal coverage and proposal-generation cost. It does not answer decode payload equivalence, first-success ranks, or false decoded payload behavior.

First inspect `no-flood` versus `full-current`. It is equivalent at the measured proposal-count and coverage level and removes the flood cost. Then inspect `row-first-fallback-on-no-proposals`; it is the fastest full-current coverage match, but changes proposal frontier size. Finally inspect `matcher-no-row-overlap`; it preserves proposal coverage while reducing duplicate proposal pressure, but needs proposal-identity or decode confirmation before production suppression.

## Conclusion / evidence-backed decision

For proposal generation, flood is removable: `no-flood` matched `full-current` on positive coverage, negative proposal behavior, and total proposal count while eliminating `212,503.17ms` of flood work.

The fastest full-current coverage-preserving policy is `row-first-fallback-on-no-proposals`; it avoids matcher on all but one asset and cuts scan time by `76.70%`, but it emits fewer proposals than `full-current`, so treat it as the next policy candidate rather than an immediate production default.

Matcher overlap suppression is promising at proposal level, but should not be promoted without proposal-identity or decode-level confirmation.

Future default policy-study runs should bin the slow flood-bearing permutations (`full-current`, `row-plus-flood`) unless they are explicitly requested as historical controls. The next performance study should focus on proposal assembly itself using `no-flood` as the detector-policy baseline.
