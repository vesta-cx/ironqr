# Pipeline Stage Contracts

Related: [[Ranked Proposal Pipeline]], [[Proposal Clusters]], [[Early Exit Heuristics]], [[Diagnostics and Benchmark Boundary]]

## Purpose
Describe the target end-to-end pipeline in terms of stage responsibilities, inputs, outputs, and search order.

## Guiding idea
Views are cheap. Full decode attempts are not.

The pipeline should spend as much cheap work as needed to find good QR candidates, then spend expensive work only where the evidence is strongest.

## Stage 0 — frame normalization
### What
Convert supported input into one validated internal frame object.

### Why
Every later stage should receive the same trusted image representation.

### How
- validate dimensions and RGBA length at the trust boundary
- store width, height, RGBA data
- expose caches for derived scalar and binary views

## Stage 1 — scalar view construction
### What
Build a bank of scalar views from one frame.

### Why
Different views surface different QR evidence. A channel that localizes well may differ from the one that decodes best.

### How
Start with:
- grayscale / luminance
- `r`, `g`, `b`
- `oklab-l`
- signed `oklab±a`
- signed `oklab±b`

Optional later additions should be benchmark-earned rather than guessed.

## Stage 2 — binary view construction
### What
Create binary views from scalar views.

### Why
Proposal generation and decode both operate on binary evidence, but the generation of those binaries should be data-driven and cached.

### How
At minimum support:
- Otsu
- local adaptive thresholding
- inverted polarity where useful

Binary views should be lazy and cached, not precomputed blindly.

## Stage 3 — proposal generation
### What
Generate QR-like proposals from prioritized **proposal views**.

### Why
The scanner should search over candidate QR explanations rather than over isolated threshold attempts.

### How
Proposal generation should accept an ordered binary-view list.
That ordered list is the **proposal-view order**.

Proposal sources should include at least:
- row-scan finder detector
- connected-component / flood detector
- transform-aware matcher
- quad-style photo fallback detector

Output should be proposals, not winners.

### Contract note
Proposal-view order is a real tuning seam.
It is separate from:
- cluster representative policy
- decode-neighborhood ordering
- decode-stage rescue order

## Stage 4 — proposal ranking
### What
Rank proposals globally by QR-specific evidence.

### Why
The strongest candidate should get the expensive budget first.

### How
Score with QR-specific signals such as:
- detector confidence
- geometry plausibility
- module-size consistency
- version plausibility
- quiet-zone support
- cheap lattice / timing support
- alignment support when expected

Do **not** rank by generic contrast alone.

## Stage 5 — proposal clustering
### What
Coarsely group near-duplicate proposals that appear to describe the same physical QR.

### Why
Different views and threshold variants often rediscover the same candidate. The expensive work is repeated decode, not proposal generation.

### How
Follow the policy in [[Proposal Clusters]].

This note is canonical for the overall pipeline shape, but the dedicated clustering note is canonical for cluster rationale and representative policy.

## Stage 6 — initial geometry candidates
### What
Turn one proposal into one or more cheap geometry candidates.

### Why
Ranking should pick likely QR candidates, then geometry should cheaply test which interpretation of that proposal deserves more work.

### How
Support at least:
- finder-triple homography resolution
- center-based homography resolution
- inferred-quad geometry seeds carried by finder-triple proposals
- explicit-corner / quad resolution when an independent detector produces boundary corners

Finder-derived quads should be geometry seeds, not duplicate proposals. The geometry layer should not care which detector created the proposal.

## Stage 7 — early structural rejection
### What
Run cheap structural checks on the strongest geometry candidates before full decode.

### Why
Many false positives collapse as soon as they are asked to explain a believable QR lattice.

### How
Follow the policy in [[Early Exit Heuristics]].

This note is canonical for pipeline ordering, but the dedicated early-exit note is canonical for the rationale and thresholds philosophy.

## Stage 8 — decode cascade for one surviving proposal
### What
Run the expensive decode search for one proposal.

### Why
A proposal can localize well on one view and decode better on another. Geometry is valuable and should be reused before spending work on lower-ranked candidates.

### How
For the top surviving proposal, try in order:
1. source view + initial geometry
2. nearby decode views reusing that geometry
3. refined geometry + source view
4. refined geometry + related decode views
5. alignment-assisted refits
6. alternate samplers
7. only then move to the next proposal or cluster representative

### Contract note
The ordered decode views used here form the **decode neighborhood**.
This is a different policy surface from proposal-view order.
A future public API might expose proposal-view ordering without exposing decode-neighborhood ordering.

## Stage 9 — strict QR-spec decode
### What
Decode a logical QR grid into payload and metadata.

### Why
Once geometry and sampling are plausible, decoding should stay a strict spec-layer concern.

### How
Keep the decoder mostly isolated from localization logic.

It may support narrowly-targeted rescue behavior such as mirrored logical-grid retry, but it should not become a dumping ground for localization heuristics.

## Stage 10 — result aggregation
### What
Return scan results and enough metadata to support future ranked multi-result behavior.

### Why
Even if single-result scanning stays the common path, the internal design should not assume exactly one winner forever.

### How
Keep result objects attributable to proposal, view, and decode path.

## Search-order contract
The intended search order is:
1. build views lazily
2. generate proposals broadly from prioritized proposal views
3. rank proposals globally
4. cluster near-duplicates
5. probe a small number of diverse representatives
6. apply cheap structural rejection
7. spend decode budget on the strongest surviving representative first
8. reuse geometry before redetecting

If an implementation choice fights this search order, it is probably regressing toward the old architecture.

## Public-API guidance
If `ironqr` eventually exposes tuning here, prefer constrained tuning surfaces over arbitrary pipeline reordering.

Good candidates:
- ordered proposal-view allowlists
- preset scanner profiles built on those allowlists
- proposal budgets and other policy knobs

Avoid exposing arbitrary reordering of:
- clustering
- structural rejection
- geometry resolution
- decode rescue passes

Those are internal architectural stages with invariants, not a good long-term user surface.
