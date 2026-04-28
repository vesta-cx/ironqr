# Performance Study Variant Contract

## Problem / question

Performance studies should not merely describe the current scanner. They should answer whether a proposed optimization, prototype, or parameter sweep improves a specific cost metric without changing required behavior.

The unit of decision is a study variant: a control, a candidate implementation, a prototype measurement, or a parameter value.

## Hypothesis / thesis

A useful performance study compares the current production behavior against one or more alternatives under the same corpus, seed, cache policy, view set, decode policy, and reporting schema.

Null hypothesis: the candidate variant does not improve the target metric enough to justify implementation complexity, or it changes accuracy/proposal/decode behavior outside the study's accepted bounds.

## Designed experiment / study

Every performance-oriented study should report:

1. **Control**: current production scanner or current hot-path primitive.
2. **Candidate variant(s)**: proposed optimization, prototype equivalent, or parameter sweep.
3. **Behavior guardrails**: exact output/proposal/bit equality when the optimization claims to preserve behavior; explicit recall/false-positive bounds when it does not.
4. **Cost metric**: the timing or memory metric the candidate is expected to improve.
5. **Decision rule**: the minimum effect size needed to adopt or continue implementation.

When the production candidate is not implemented yet, the study may include a prototype or headroom measurement, but the report must label it as such and avoid claiming production-equivalent speedup.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Variant id | string | study config/report | Identifies control/candidate/sweep value. |
| Control metric | ms/bytes/count | production path | Baseline. |
| Candidate metric | ms/bytes/count | variant/prototype | Compared against baseline. |
| Delta | ms/bytes/count | derived | Absolute effect size. |
| Improvement | percent | derived | Normalized effect size. |
| Behavior equality | boolean/diff | comparator | Required for behavior-preserving optimizations. |
| Positive decoded assets | assets | scan/study report | Guardrail when decode runs. |
| False-positive assets | assets | scan/study report | Guardrail when decode runs. |
| Memory overhead | bytes | variant metadata | Adoption tradeoff. |

## Decision rule

Adopt or continue a candidate only if:

- the candidate is measured against a named control in the same study report;
- the reported effect size meets the study-specific threshold;
- behavior guardrails pass, or the accepted behavior tradeoff is documented;
- the candidate's memory/complexity cost is lower than the measured benefit.

## Implementation checklist

- [ ] Add a `variants` section to the study summary/report.
- [ ] Include at least one `control` row and one candidate/prototype/sweep row when possible.
- [ ] Label prototype/headroom measurements honestly when they are not production-equivalent.
- [ ] Keep corpus, cache, seed, view set, and decode policy identical across compared variants.
- [ ] Add equality/diff checks for behavior-preserving variants.

## Results

Placeholder. Each concrete study links its generated report here after a run.

## Interpretation plan

Do not compare totals from different runs unless the corpus, seed, cache policy, and scanner behavior are identical. Prefer same-run paired measurements for micro-path changes, and paired baseline/candidate reports for full scanner changes.

## Conclusion / evidence-backed decision

No performance study is considered decision-ready unless it reports the control, candidate, delta, improvement percentage, and guardrail status.
