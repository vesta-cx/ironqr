# Pipeline Stage Contracts

Related: [[Ranked Proposal Pipeline]], [[Proposal Clusters]], [[Early Exit Heuristics]], [[Diagnostics and Benchmark Boundary]]

## Purpose
Describe the target end-to-end pipeline in terms of stage responsibilities, inputs, outputs, and search order.

## Guiding idea
Views are cheap. Full decode attempts are not.

The pipeline should spend as much cheap work as needed to find good QR candidates, then spend expensive work only where the evidence is strongest.

## End-to-end latency target
Interactive video scanning targets one complete frame decision inside a 60 FPS frame budget:

```text
1000 ms / 60 fps = 16.67 ms per frame
```

That budget covers the full `scanFrame` path for a single frame: input normalization, view construction, proposal generation, clustering, structure/refinement, module sampling, decode, and returning either decoded QR payloads or a confident “no QR code found.” A candidate optimization is strategically valuable when it moves the measured end-to-end path toward this 16.67 ms budget or removes a bottleneck that blocks reaching it.

Future temporal optimization may allow some frames to reuse prior-frame state or run slightly slower than realtime on occasional frames, but the durable baseline target remains a standalone 16.67 ms frame decision.

## Effort / search-depth option
IronQR should expose an explicit effort option that controls how hard the scanner searches before returning “no QR code found.” This lets callers choose latency vs. recall instead of baking one global policy into the pipeline.

A likely shape:

| Effort | Product intent | Search behavior |
| --- | --- | --- |
| `low` / `cheap` | Find easy QR codes very quickly in realtime video. | Use the cheapest/highest-yield views and detectors, tight proposal/decode budgets, and early exits after strong easy evidence. May miss stylized, low-contrast, damaged, or unusual QR codes. |
| `balanced` | Default production mode. | Use the evidence-backed view order and budgets that preserve most corpus recall while still respecting interactive latency. |
| `high` / `exhaustive` | Offline, diagnostic, or “try hard” scans. | Broaden views, detector candidates, rescue paths, and decode attempts. Optimizes recall and evidence collection over per-frame latency. |

The effort option should be part of the public scan contract, not a hidden benchmark-only setting. It can map to internal knobs such as proposal-view count/order, detector families, cluster budgets, max representatives per cluster, structural failure limits, decode-attempt limits, and `continueAfterDecode` behavior.

Study and benchmark modes may still force exhaustive settings when the question requires complete evidence. That is separate from production effort: studies measure what is possible; effort modes decide how much of that search a caller is willing to spend at runtime.

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

The matcher should use row/column run-map-backed cross-checks rather than repeated pixel walking. This keeps the same finder-ratio semantics while making the matcher cheap enough to be the default detector path. Any extra matcher pruning must prove identical finder output or include a fallback path; cheap center filters alone are not a safe replacement.

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
