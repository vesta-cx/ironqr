---
name: study-analyze
description: Analyze a generated benchmark study report against its designed study document and extract evidence-backed recommendations. Use when reading tools/bench/reports/study-*.json, comparing study runs, or deciding whether report data answers the question in apps/docs/studies/<study-id>.md.
---

# Study Analyze

Use this after a study report has been generated. Always analyze the report against the corresponding study design document, not as a free-form metrics dump.

## Workflow

1. **Load the report and study design**
   - Read `tools/bench/reports/study-<id>.json`.
   - Read `apps/docs/studies/<study-id>.md` when present.
   - Extract the study doc's Problem / question, Hypothesis / thesis, Designed experiment / study, Metrics table, and Decision rule.
   - Record generated timestamp, git commit, dirty state, corpus size, filters, seed, cache hits/misses, and study config.

2. **Map report data to the designed question**
   - For each question in the study doc, identify which report fields can answer it.
   - For each metric in the study doc, mark it as present, missing, stale, or insufficient.
   - Explain how the measured data supports, weakens, or fails to test the hypothesis.
   - If the report cannot answer the problem statement, say so before producing recommendations.

3. **Validate report fitness**
   - Confirm the report measured the intended corpus and all required variants.
   - Check whether cache hits make the run unsuitable for timing analysis.
   - Check whether arbitrary caps were active when the question needs exhaustive evidence.

4. **Compute headline outcomes**
   - Positive pass/fail counts.
   - Negative false-positive counts.
   - Unique successful contributors by decision unit.
   - Overlap matrix or greedy coverage order.

5. **Separate capability from cost**
   - Capability: unique positives, total positives, false positives, confidence scores.
   - Cost: materialization, proposal generation, clustering, structure, module sampling, decode attempts.
   - Treat nested timing spans as nested; do not sum parent and child spans as independent time.

6. **Derive budget evidence**
   - Use first-success rank distributions for cluster/decode budgets.
   - Report p50, p90, p95, max, and recall retained at candidate budgets.
   - Identify assets lost by each proposed budget.

7. **Produce recommendations**
   - Mandatory inclusions first.
   - Then order overlapping contributors by marginal capability per cost.
   - Explicitly list exclusions and why.

8. **Update study documentation**
   - Fill `apps/docs/studies/<study-id>.md` Results and Interpretation sections.
   - Link report path and commit.
   - Explicitly state which parts of the original question were answered, partially answered, or not answered by this run.

## Output

Return:
- study question and decision rule from the doc;
- report-to-question mapping;
- metric coverage table (present/missing/insufficient);
- validation notes;
- outcome summary;
- mandatory inclusions;
- recommended order/budget;
- slowest bottlenecks;
- answered / partially answered / unanswered questions;
- documentation updates made or needed.
