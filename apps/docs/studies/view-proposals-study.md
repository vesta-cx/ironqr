# View Proposal Priority Study

## Problem / question

IronQR has many scalar, threshold, and polarity views. Running every binary view in production is expensive, but a hard-coded proposal or cluster budget can hide useful evidence. The study asks:

1. Which binary views uniquely contribute successful QR-positive decodes?
2. Which overlapping views should be prioritized by capability versus current time cost?
3. After clustering proposals, how many cluster decode attempts are actually needed before additional clusters stop producing successful decodes?
4. Which pipeline stages dominate scan time and should be optimized first?

## Hypothesis / thesis

The useful production order should be evidence-driven:

- include every view that is the only successful source for at least one positive asset;
- order overlapping views by decoded coverage, confidence, and measured cost;
- cluster all viable proposals before applying a decode budget, because consensus across many medium-ranked proposals is more meaningful than a pre-clustering top-N slice;
- derive any future decode budget from the empirical distribution of successful cluster ranks, not a magic number.

## Designed experiment / study

Run `bench study view-proposals` against the approved corpus with:

- all 54 binary view identities enabled;
- scan `allowMultiple: true` so study execution does not stop after the first result;
- `maxProposals: 10_000` so the study does not impose the old 24-cluster cap;
- full IronQR trace collection;
- timing spans for scalar view materialization, binary plane materialization, binary view wrapper creation, proposal generation, ranking, clustering, structure screening, geometry, module sampling, decode attempts, and decode cascade.

The report is expected at:

```text
tools/bench/reports/study-view-proposals.json
```

The report should include:

- per-asset pass/fail and first decoded cluster rank;
- per-view finder/proposal counts and timings;
- per-view confidence metrics from proposal score breakdowns;
- per-view cluster representative counts and decode/module sampling timings;
- summary cluster-budget evidence including p50/p90/p95/max first decoded cluster rank.

## Results

Use the latest generated report as source of truth. Do not copy stale numbers into production decisions without rerunning the study after scanner changes.

For each run, record:

- corpus asset counts and positive/negative split;
- QR-positive pass/fail counts;
- views with exclusive successful positive assets;
- greedy coverage order for non-exclusive views;
- first decoded cluster rank percentiles;
- total time by pipeline stage;
- top views by decode attempts with no successful contribution.

## Interpretation

A view belongs in the production shortlist if it uniquely decodes at least one positive asset. Views with overlapping coverage should be ordered by marginal decoded assets per measured cost, with confidence as a tie-breaker.

A cluster decode budget is justified only if first-success cluster ranks show a stable cutoff. If p95 or max first-success rank is high, the budget is a product decision rather than a scanner invariant and should be documented as such.

`clusteringMs` measures clustering algorithm runtime, not cluster policy quality. If clustering runtime is low but decode attempts are high, optimize cluster ranking, cluster representative construction, and decode budget policy instead of the clustering loop itself.

## Conclusion / evidence-backed decision

The current study design intentionally disables the old 24-cluster cap. After rerunning, choose production budgets from the report's `clusterBudgetEvidence` section and document:

- the selected budget;
- the percent of current successful positives retained by that budget;
- the assets lost beyond that budget, if any;
- the estimated decode-attempt/time savings;
- why the tradeoff is acceptable.

No future budget constant should be introduced without this evidence in the study doc or linked report.
