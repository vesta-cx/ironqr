# Thresholding Research Notes

Related: [[View Study]], [[ScanFrame End-to-End]], [[Pipeline Stage Contracts]], [[Diagnostics and Benchmark Boundary]]

## Scope
This note captures future thresholding / segmentation ideas for stylized QR support.

It is a research backlog, not an adopted scan policy. Any new threshold family should earn its place through `tools/bench` / corpus evidence before entering the default proposal-view list.

## Current baseline
Current binary views are built from:
- scalar plane: `gray`, `r`, `g`, `b`, `oklab-l`, `oklab+a`, `oklab-a`, `oklab+b`, `oklab-b`
- threshold family: `otsu`, `sauvola`, `hybrid`
- polarity: `normal`, `inverted`

Useful mental model:
- **Otsu**: one global threshold; fast and good for clean/even images.
- **Sauvola**: local adaptive threshold; shadow-tolerant because it judges pixels relative to their neighborhood.
- **Hybrid**: project-specific combined threshold path that often catches cases neither simple global nor local thresholding handles alone.

## Research candidates

### Phansalkar thresholding
Phansalkar is a Sauvola/Niblack-family local adaptive threshold that is often used for low-contrast foreground extraction.

Hypothesis:
- Useful for low-contrast stylized QR codes.
- Potentially helpful for soft colored modules, anti-aliased modules, and rounded modules where local contrast exists but global contrast is weak.

Risks:
- Can amplify paper grain, compression artifacts, and textured backgrounds.
- Has tunable parameters that may overfit small corpora.

Initial views to test, not adopt blindly:
- `gray:phansalkar:normal`
- `oklab-l:phansalkar:normal`
- `b:phansalkar:normal`
- `gray:phansalkar:inverted`

### Wolf-Jolion thresholding
Wolf-Jolion is another local adaptive threshold that accounts for local statistics and global contrast range.

Hypothesis:
- Useful for photographed QR codes with uneven illumination, weak contrast, or background gradients.
- Could outperform Sauvola on some shadow / glare cases.

Risks:
- More expensive than simpler local methods.
- Parameter-sensitive.
- May create extra junk proposals if added broadly across scalar planes.

### Bradley-Roth adaptive thresholding
Bradley-Roth thresholds each pixel against a local average, usually via an integral image.

Hypothesis:
- Cheap shadow-tolerant baseline.
- May be useful as a fast proposal-view candidate for broad illumination correction.

Risks:
- Less nuanced than Sauvola / Phansalkar / Wolf-Jolion.
- May not add unique wins beyond existing `sauvola` / `hybrid` views.

### Local-background normalization + existing thresholds
Instead of adding a new threshold formula, estimate local background first, flatten illumination, then run existing thresholders.

Possible variants:
- local mean subtraction + Otsu
- morphological top-hat / bottom-hat preprocessing + Otsu
- local contrast normalization + Otsu or Sauvola
- CLAHE-style contrast normalization before thresholding

Hypothesis:
- Good for broad shadows and gradients.
- May be less noisy than purely local adaptive thresholding.

Risks:
- More preprocessing cost.
- Morphological parameters depend on QR scale.
- Can damage finder/timing structure if the background window is poorly sized.

### OKLab color-distance segmentation
For stylized QR codes, another grayscale threshold may be less useful than perceptual color segmentation.

Idea:
- Work in OKLab.
- Estimate likely foreground/background color clusters.
- Produce binary masks based on perceptual color distance rather than luminance alone.

Hypothesis:
- Useful for branded / colorful QR codes where foreground and background differ more by hue/chroma than lightness.
- Could help pastel, colored-module, and low-luminance-contrast designs.

Risks:
- Needs robust foreground/background estimation.
- False positives on decorative colored backgrounds.
- More complex than scalar threshold families, so observability must show whether it adds unique wins.

Possible future view names:
- `oklab-cluster:normal`
- `oklab-cluster:inverted`
- `oklab-distance:normal`
- `oklab-distance:inverted`

## Dotted / rounded QR caveat
Thresholding alone is probably not enough for dotted or heavily rounded modules.

Those failures are often **module-shape** failures, not just binarization failures.

More promising companion work:
- module-shape-aware sampling
- center-weighted module voting
- template-based finder detection for rounded / dotted finder patterns
- connected-component or blob analysis to infer module centers

Thresholding can make dots visible. It does not automatically teach the sampler that a valid dark module may be a circle with light corners.

## Evaluation requirements
Before adopting any candidate threshold family:
1. Add it behind an internal/study-only view path.
2. Run proposal-view observability with `scan.proposals: 'summary'`.
3. Measure unique wins, not just proposal volume.
4. Track junk proposal rate and downstream decode-attempt cost.
5. Compare speed + accuracy against the current top-18 proposal subset.
6. Prefer a small targeted set of new views over full cartesian expansion.

Useful metrics:
- assets newly decoded
- first-winner assets
- first-correct rank movement
- proposal count per view
- cluster contribution per view
- decode attempts caused by the view
- false-positive / junk proposal rate
- per-view generation time

## Current recommendation
Research order:
1. Phansalkar on a tiny selected view set.
2. OKLab color-distance segmentation for colorful stylized codes.
3. Local-background normalization + Otsu/Sauvola.
4. Wolf-Jolion if Phansalkar shows promise but misses shadow / weak-contrast cases.
5. Bradley-Roth only as a cheap baseline or speed-oriented fallback.

Do not treat these as replacements for dotted-module work. For dotted / rounded codes, prioritize module-shape-aware sampling and finder templates alongside any threshold experiments.
