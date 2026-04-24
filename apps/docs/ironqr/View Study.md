# View Study

Related: [[Proposal Clusters]], [[Ranked Proposal Pipeline]], [[Pipeline Stage Contracts]], [[Diagnostics and Benchmark Boundary]], [[Thresholding Research Notes]]

## Scope
This note documents how `packages/ironqr` uses corpus evidence to choose proposal-view policy.

The study tooling and reports may live in `tools/bench` and one-off scripts, but this note is about the `ironqr` policy surface they inform.

## Goal
Measure which binary views are actually useful for surfacing real QR candidates, so proposal and cluster representative order can be driven by corpus evidence instead of intuition.

## Terminology
Use **views** consistently.

- **scalar view**: one grayscale-like plane such as `gray`, `r`, `g`, `b`, `oklab-l`, `oklab+a`
- **binary view**: scalar view + threshold family + polarity, such as `gray:otsu:normal`
- **proposal views**: the prioritized binary views used during proposal generation
- **decode neighborhood**: the ordered binary views tried later when reusing geometry for decode rescue

These are related but not interchangeable. Reordering **proposal views** is a different decision from reordering the **decode neighborhood**.

## Study inputs
The study can run all 54 binary views:
- scalar plane
- threshold family
- polarity

## What it tries to learn
Per view:
- how often it contributes proposals
- how often it produces early correct candidates
- how often it produces false positives
- how early in the global ranking its proposals appear
- how much runtime the proposals it creates cost

## Scoring model
This is **not** ranked-choice voting or elimination voting.

The study is a rank-sensitive evidence aggregation pass over one global proposal order.

Important implications:
- all proposals from all views enter one global ranking
- a single asset can give useful credit to multiple views
- per-view usefulness includes counts like decoded assets, first-winner assets, false positives, and first-correct rank
- any composite score should stay secondary to the primary metrics, not replace them

A soft composite can still be useful as a tie-breaker, but only with guardrails.

## Runtime reality
An exhaustive study is expensive because each asset can produce hundreds of ranked proposals. That is why the study code stores resumable cache state, partial progress, and per-proposal timings.

## Files
- report output: `tools/bench/reports/ironqr-view-study*.json`
- resumable cache: `tools/bench/.cache/ironqr-view-study*.json`

## Current adopted fast path
The current proposal-generation fast path in `packages/ironqr/src/pipeline/views.ts` is based on the exhaustive 88-asset study that was used to replace the older heuristic family ordering.

Current ordered top subset:
1. `gray:otsu:normal`
2. `oklab-l:hybrid:normal`
3. `gray:sauvola:normal`
4. `oklab-l:sauvola:normal`
5. `oklab-l:otsu:normal`
6. `b:hybrid:normal`
7. `gray:hybrid:normal`
8. `r:otsu:normal`
9. `r:sauvola:normal`
10. `g:sauvola:normal`
11. `b:otsu:normal`
12. `g:otsu:normal`
13. `g:hybrid:normal`
14. `b:sauvola:normal`
15. `r:hybrid:normal`
16. `oklab+b:hybrid:normal`
17. `gray:hybrid:inverted`
18. `gray:otsu:inverted`

Two inverted grayscale views remain in the fast path because removing inverted views entirely broke existing stylized inverted coverage.

## Source-of-truth rule
Report snapshots can drift as the corpus, labels, or aggregation logic change.

The production source of truth for the active fast path is:
- `packages/ironqr/src/pipeline/views.ts`
- the regression test that locks the ordered proposal-view list

Treat checked-in report JSON as supporting evidence, not as the authoritative runtime policy.

## What the study is good at
This report is strongest at answering:
- which binary views deserve early proposal-generation budget
- which views are good cluster representatives
- which views are mostly tail/rescue material

It is **not** strong evidence for changing the overall scan-stage order, and by itself it is **not** strong evidence for changing decode-neighborhood ordering.

## Current practical takeaway
The study produced a better proposal-generation order, but it did **not** move the main accuracy frontier away from decode and geometry hardening.

Current misses are still dominated by proposals that already:
- get generated
- rank well enough to be tried
- survive clustering
- reach geometry creation
- spend large decode budgets anyway

That means the next accuracy gains are still more likely to come from:
- better version estimation and version-neighborhood rescue
- softer timing-pattern rejection for near-miss grids
- stronger sampler / phase rescue for stylized and photographic symbols

## API implications
If `ironqr` ever exposes tuning for this area, the safest public concept is **proposal-view ordering**, not arbitrary pipeline-stage reordering.

Good future surface area:
- ordered proposal-view allowlist / priority
- optional preset/profile names built on top of that

Bad future surface area:
- arbitrary stage reordering in `scanFrame(..., options)`
- public promises about every internal decode-rescue path remaining customizable forever

The likely future shape is a constrained advanced API such as:
- `proposalViews: readonly BinaryViewId[]`
- or an experimental scanner profile that includes proposal-view order

## Practical takeaway
The study is not the production scan path. It is instrumentation to help shape:
- proposal view ordering
- cluster representative order
- early exit thresholds
- future constrained tuning APIs for proposal views
