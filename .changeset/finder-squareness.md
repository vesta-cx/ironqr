---
'ironqr': patch
---

`detectFinderPatterns` and `sampleGrid` got two fixes that lift the
real-world corpus decode rate together:

- **Squareness pre-filter + L-shape triple scoring.** Finder detection
  used to return the top 3 candidates by averaged module size. False
  positives in stylized data regions slipped through (e.g. a candidate
  with h=56, v=43) and evicted real finders. The detector now drops
  candidates whose horizontal and vertical module sizes disagree by
  more than 20%, keeps a wider pool (12 instead of 3), and picks the
  triple whose three centres best satisfy a real QR L-shape: matching
  module sizes, two perpendicular legs of equal length, and a
  hypotenuse ≈ √2 × leg.

- **5-point majority sampling per module.** `sampleGrid` no longer
  reads a single centre pixel per cell. It samples the centre plus
  four ¼-module-inset corners and takes a majority vote (centre
  weighted ×2). Stylized QRs and mild geometry drift no longer flip
  modules wholesale on a single bad sample.

Net real-world corpus impact across this PR's geometry/sampling work:
13/35 → 16/35 decode rate (37% → 46%). Synthetic moderate keystone
(10%) now decodes through the existing homography path.
