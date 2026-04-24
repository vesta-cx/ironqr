# Early Exit Heuristics

Related: [[Ranked Proposal Pipeline]], [[Proposal Clusters]]

## Goal
Reject proposals that cannot plausibly describe a QR module lattice before paying the full decode-cascade cost.

## Guiding rule
Use cheap structural checks as **strong negative tests**.

Do **not** require a proposal to look like a perfect textbook QR before allowing decode. Hard real-world symbols can be weird, blurred, stylized, low-contrast, or only visible in one view.

## Current cheap checks
For the strongest geometry candidates on the proposal's source view:
- sample a coarse logical grid with a cheap sampler
- measure timing-line support between the finders
- measure finder-signature support around the three canonical finder centers
- measure separator support on the inward sides of the finders
- measure projected module-pitch smoothness along the timing row/column

These signals are combined into a conservative pass/fail gate.

## Why timing support matters
A fake finder triple can still look plausible locally. The timing row and column are where many false candidates break down.

Question being asked:
> do these three finders induce a believable QR lattice?

If the answer is clearly "no", the proposal should never reach the expensive decode path.

## Why the thresholds are conservative
Hard cases can have:
- damaged timing corridors
- stylized modules
- strong perspective
- low contrast
- channel-specific visibility

So the early-exit gate should only reject candidates that look structurally implausible, not merely imperfect.

## Future refinements
- better neighbor-alignment checks around finders
- stronger module-pitch coherence measures under perspective warp
- empirically tuned thresholds from corpus traces
- separating "strong structural fail" from "weak decode fail" in diagnostics
