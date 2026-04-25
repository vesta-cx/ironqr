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
- `maxClusterRepresentatives: 10_000`, `maxClusterStructuralFailures: 10_000`, and `continueAfterDecode: true` so successful decodes do not hide later rescue/cluster behavior;
- full IronQR trace collection;
- timing spans for scalar view materialization, binary plane materialization, binary view wrapper creation, proposal generation, ranking, clustering, structure screening, geometry, module sampling, decode attempts, and decode cascade.

The report is expected at:

```text
tools/bench/reports/full/study/study-view-proposals.json
tools/bench/reports/study/study-view-proposals.summary.json
```

Production scan behavior may stop after a cluster decodes because each cluster is treated as one potential QR code. The study intentionally does not stop: it probes the remaining cluster representatives so budget decisions can be inferred from complete path evidence.

The report should include:

- per-asset pass/fail and first decoded cluster rank;
- per-view finder/proposal counts and timings;
- per-view confidence metrics from proposal score breakdowns;
- per-view cluster representative counts and decode/module sampling timings;
- summary cluster-budget evidence including p50/p90/p95/max first decoded cluster rank.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Positive decoded assets | assets | study summary | Primary recall metric. |
| False-positive assets | assets | study summary | Must remain zero or be explicitly accepted. |
| Exclusive successful views | view ids | per-view success evidence | Mandatory production inclusion. |
| Marginal successful positives | assets | greedy coverage summary | Orders overlapping views. |
| Detector duration by view | ms | `proposal-view` spans | Cost tie-breaker and hotspot evidence. |
| Scalar/binary materialization duration | ms | materialization spans | Identifies view-construction optimization targets. |
| Proposal and ranked proposal count | count | proposal trace/report | Explains detector workload and ranking effects. |
| Cluster count and representative count | count | scan summary/trace | Explains decode frontier size. |
| First decoded cluster rank | rank | cluster trace | Derives any future cluster budget. |
| Decode attempts and module samples | count/ms | decode/module spans | Shows downstream cost caused by view/proposal paths. |
| Cluster outcomes | count | cluster trace | Separates decoded, duplicate, killed, and exhausted paths. |

## Decision rule

- Include every view that uniquely decodes at least one QR-positive asset.
- Order remaining candidate views by marginal positive coverage per measured cost, with confidence and false-positive behavior as tie-breakers.
- Do not introduce a default cluster budget unless the first-success cluster-rank distribution shows the chosen budget retains the agreed recall target.
- Future production policy should expose an explicit scanner effort mode. Low/cheap effort can intentionally trade recall for very fast easy-code detection, while balanced/high effort can spend more of the proposal/decode search space. Study mode remains exhaustive so those effort budgets are evidence-backed rather than guessed.
- If the p95 or max successful cluster rank is high, document the budget as a product tradeoff rather than an algorithmic invariant.
- Treat timing hotspots as optimization candidates only after separating nested decode timings from independent wall-clock timings.

## Implementation checklist

- [x] Run all 54 binary view identities instead of the production shortlist.
- [x] Disable the old arbitrary cluster cap for the study.
- [x] Continue probing cluster representatives after successful decode in study mode.
- [x] Record materialization, proposal, clustering, structure, module-sampling, decode, and cluster-rank evidence.
- [ ] Rerun the full study after clustering/representative changes.
- [ ] Record final results and evidence-backed production decisions in this document.

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
