# Finder Grid Realism Pipeline, Explained Like You Are 10

This document explains the scanner's **finder-grid realism** pipeline from the raw image to decode-confirmation reports.

The short version:

```text
image
→ many black/white views
→ find finder-pattern-looking blobs
→ try groups of 3 finders
→ ask “could these be a real QR code?”
→ build a QR grid map
→ score finder/template/timing/quiet-zone evidence
→ rank or threshold proposals
→ decode some representatives
→ measure work saved vs real decodes lost
```

The goal is not just “can we decode this image?” The goal is to measure whether QR-realism signals can safely reduce scanner work or false positives without losing real QR codes.

---

## 1. The mental model: a QR code is a warped checkerboard map

A QR code is a square grid of tiny black/white squares called **modules**.

Version 1 has:

```text
21 × 21 modules
```

Every larger QR version adds 4 modules per side:

```text
size = 4 × version + 17
```

Examples:

| QR version | Modules per side |
| ---: | ---: |
| 1 | 21 |
| 2 | 25 |
| 3 | 29 |
| 4 | 33 |
| 10 | 57 |
| 40 | 177 |

A camera image usually does not see this square grid perfectly. The code may be rotated, tilted, skewed, small, blurry, or photographed at an angle.

So the scanner needs to answer:

```text
Can this messy image region be explained as a perspective-warped QR grid?
```

Think of placing a transparent QR grid on top of the image and stretching its four corners until it lines up. If that stretched grid explains the finder patterns, timing patterns, quiet zone, and module sizes, the candidate is realistic. If not, it is probably random texture.

---

## 2. Stage L1-L3: make many views of the image

The scanner starts with an image. A normal image has colors. QR detection works best on black/white structure, so the scanner creates many **binary views**.

A binary view is just:

```text
black pixel or white pixel
```

Different views are useful because QR codes can be visible in one color channel but weak in another.

Examples of view families:

```text
gray:otsu:normal
gray:otsu:inverted
gray:sauvola:normal
oklab-l:hybrid:normal
oklab+a:otsu:inverted
b:hybrid:normal
```

A view id usually means:

```text
channel : threshold method : polarity
```

Where:

- `gray` means grayscale brightness.
- `oklab-l`, `oklab+a`, `oklab+b` are perceptual color-space channels.
- `otsu`, `sauvola`, `hybrid` are ways to choose black/white thresholds.
- `normal` means dark stays dark.
- `inverted` means black/white is flipped.

Why do this? Because a QR code may be clear in blue-yellow contrast but weak in grayscale, or may be light-on-dark instead of dark-on-light.

The study limits this with:

```text
maxViews
```

Current default:

```text
all default binary views
```

---

## 3. Stage L4: find finder evidence

QR codes have three big square markers called **finder patterns**:

```text
┌───────┐       ┌───────┐
│ finder│       │ finder│
└───────┘       └───────┘

┌───────┐
│ finder│
└───────┘
```

They are at:

```text
top-left
top-right
bottom-left
```

Each finder pattern is a 7×7 module shape:

```text
black black black black black black black
black white white white white white black
black white black black black white black
black white black black black white black
black white black black black white black
black white white white white white black
black black black black black black black
```

The scanner uses robust finder detectors to produce **finder evidence**. A finder evidence record says:

```ts
{
  centerX,
  centerY,
  moduleSize,
  hModuleSize,
  vModuleSize,
  source,
  score
}
```

Explained simply:

| Field | Meaning |
| --- | --- |
| `centerX`, `centerY` | Where the finder center is in the image. |
| `moduleSize` | How many image pixels one QR module seems to be. |
| `hModuleSize` | Horizontal module-size estimate. |
| `vModuleSize` | Vertical module-size estimate. |
| `source` | Which detector found it, such as row-scan or matcher. |
| `score` | Detector-local confidence. |

Current canonical detector families:

```ts
['row-scan', 'matcher']
```

Flood is retired from the default scanner policy.

### Row-scan detector

The row-scan detector looks across rows for the famous QR finder ratio:

```text
black : white : black : white : black
  1   :   1   :   3   :   1   :   1
```

Imagine sliding a ruler across the image. When the black/white run lengths look like `1:1:3:1:1`, that row may be crossing the middle of a finder pattern.

### Matcher detector

The matcher detector compares local image patches to expected finder-like patterns. It is more template-like: “does this neighborhood look like a finder?”

### Deduping finder evidence

Different detectors or views may find the same physical finder. The scanner deduplicates nearby evidence so one finder does not appear as 20 identical finders.

---

## 4. Stage L5: turn finder evidence into triples

One QR code needs three finders.

So after a view has finder evidence, the scanner tries groups of three:

```text
finder A + finder B + finder C = candidate triple
```

If there are `n` finder candidates, the number of possible triples is:

```text
n choose 3 = n × (n - 1) × (n - 2) / 6
```

Example:

```text
5 finders → 10 triples
8 finders → 56 triples
12 finders → 220 triples
```

The scanner caps this so it does not explode:

```text
MAX_TRIPLE_COMBINATIONS
maxProposalsPerView
maxProposals
```

A triple is not trusted yet. It is just a hypothesis:

```text
maybe these three square-ish things are the QR finders
```

---

## 5. Orienting a finder triple: who is top-left?

Three points alone do not say which is top-left, top-right, or bottom-left. The scanner must orient them.

Imagine three dots making an L shape:

```text
A ---- B
|
|
C
```

The corner of the L is top-left. The two arms point right and down.

The scanner can use distances and vector math to decide this.

### Vector

A vector is an arrow from one point to another.

If point A is `(x1, y1)` and point B is `(x2, y2)`, then:

```text
vector A→B = (x2 - x1, y2 - y1)
```

### Dot product

The **dot product** tells whether two arrows point in similar directions.

```text
dot(a, b) = ax × bx + ay × by
```

If the dot product is:

- big positive: arrows point similar directions.
- near zero: arrows are close to perpendicular.
- negative: arrows point opposite directions.

For QR finders, the top-left-to-top-right arm and top-left-to-bottom-left arm should be roughly perpendicular in **QR grid space**, though perspective can make them look skewed in the image.

### Cross product sign

The 2D cross product tells whether one vector turns clockwise or counter-clockwise from another:

```text
cross(a, b) = ax × by - ay × bx
```

This helps decide orientation and avoid mirrored geometry.

Important caveat: we should not hard-reject just because the triangle is not a perfect right triangle in image space. Perspective can make a real QR look non-right-angle in the photo.

---

## 6. Estimating QR version from finder distances

A QR version determines grid size:

```text
size = 4 × version + 17
```

The three finder centers are at known grid coordinates approximately:

```text
top-left finder center:     (row=3, col=3)
top-right finder center:    (row=3, col=size-4)
bottom-left finder center:  (row=size-4, col=3)
```

The distance between top-left and top-right finder centers is approximately:

```text
size - 7 modules
```

Because each finder center is 3 modules from the edge:

```text
left center col = 3
top-right center col = size - 4
distance = (size - 4) - 3 = size - 7
```

If the image says the finder centers are 140 pixels apart, and the finder module size looks like 5 pixels/module, then:

```text
estimated modules between centers = 140 / 5 = 28 modules
```

Then:

```text
size ≈ 28 + 7 = 35 modules
```

But valid sizes are:

```text
21, 25, 29, 33, 37, 41, ...
```

So 35 does not exactly fit. The closest valid sizes are 33 and 37.

That gives candidate versions:

```text
size 33 → version 4
size 37 → version 5
```

This is called **version fitting**.

A realistic triple should imply a QR version that fits both arms:

```text
top-left → top-right
top-left → bottom-left
```

If one arm implies version 4 and the other implies version 20, something is probably wrong.

---

## 7. Building the QR grid map: homography

Once the scanner has a triple and a candidate version, it tries to build a map from QR-grid coordinates to image pixels.

This map is called a **homography**.

### What is a homography?

A homography is a 3×3 matrix that maps points on one flat plane to another flat plane under perspective.

Here the two planes are:

```text
logical QR grid plane → image pixel plane
```

In simple words:

```text
homography = the stretchy camera-perspective map
```

It lets us ask:

```text
Where is QR module (row=6, col=12) in the image?
```

The code stores a homography as nine numbers:

```ts
type Homography = [
  h00, h01, h02,
  h10, h11, h12,
  h20, h21, h22,
]
```

The math looks like this:

```text
x' = h00 × col + h01 × row + h02
y' = h10 × col + h11 × row + h12
w' = h20 × col + h21 × row + h22

imageX = x' / w'
imageY = y' / w'
```

Why divide by `w'`? That is the perspective part. It lets far-away parts shrink and tilted squares become trapezoids.

### Correspondences

To fit a homography, the scanner needs pairs like:

```text
QR grid point → image point
```

For finder triples, it knows approximate QR-grid locations of finder edges and centers, then matches them to image finder evidence.

Example logical points:

```text
top-left finder center:     (3, 3)
top-right finder center:    (3, size-4)
bottom-left finder center:  (size-4, 3)
```

Finder edges help too, not just centers.

### Degenerate geometry

A homography can fail if the points are nonsense, such as:

```text
all points almost on one line
zero-size triangle
mirrored/crossed corners
unreasonable perspective
```

If fitting fails, the candidate is not realistic.

---

## 8. Geometry candidate output

A resolved geometry candidate contains:

```ts
{
  version,
  size,
  homography,
  corners,
  bounds,
  samplePoint(row, col),
  geometryScore,
  geometryMode
}
```

Important fields:

| Field | Meaning |
| --- | --- |
| `version` | QR version, 1 through 40. |
| `size` | Modules per side, `4 × version + 17`. |
| `homography` | Perspective map from QR grid to image. |
| `corners` | The predicted four QR code corners in image pixels. |
| `bounds` | Box around those corners. |
| `samplePoint(row, col)` | Function that tells where a QR module lives in the image. |
| `geometryScore` | Heuristic score for this geometry. |

This is the key moment:

```text
Before geometry: “maybe these are three finders.”
After geometry: “here is a full QR grid hypothesis.”
```

---

## 9. Grid realism scoring: asking if the grid behaves like a real QR

The finder-grid-realism study scores each representative candidate using several sub-scores.

Current major scores:

```text
projective
module
bounds
finder
quiet
timing
combined
```

### 9.1 Projective score

Question:

```text
Does the projected QR shape look geometrically possible?
```

The study looks at things like:

- Does the projected quadrilateral have area?
- Is it not degenerate?
- Is the geometry score reasonable?

A real QR code should project to a four-corner shape with nonzero area.

### 9.2 Bounds score

Question:

```text
Do the QR corners land reasonably inside or near the image?
```

If the homography predicts the QR code mostly outside the image, that is suspicious.

The score allows some tolerance because real codes can be cropped or near the edge.

It also checks average module pitch.

### 9.3 Module consistency score

Question:

```text
Do the finder-reported module sizes agree with the grid's module size?
```

Each finder detector estimated a module size in pixels:

```text
finder.moduleSize
finder.hModuleSize
finder.vModuleSize
```

The geometry implies a module size too. If the geometry says:

```text
one module ≈ 4 pixels
```

but the finder detector says:

```text
one module ≈ 12 pixels
```

that is suspicious.

The score compares ratios:

```text
ratio = min(finderSize, predictedSize) / max(finderSize, predictedSize)
```

This gives:

```text
1.0 = perfect match
0.5 = one is twice the other
0.25 = one is four times the other
```

It also checks horizontal vs vertical module estimates:

```text
axisRatio = min(hModuleSize, vModuleSize) / max(hModuleSize, vModuleSize)
```

A finder that is wildly stretched locally may be less trustworthy.

### 9.4 Finder template score

Question:

```text
When we unwarp the grid, do the three finder areas look like 7×7 QR finders?
```

The QR grid tells us exactly where the finders should be:

```text
top-left:     rows 0..6, cols 0..6
top-right:    rows 0..6, cols size-7..size-1
bottom-left:  rows size-7..size-1, cols 0..6
```

For each module in those 7×7 areas, the study samples the image and checks whether it matches the expected finder template.

Expected finder template:

```text
#######
#.....#
#.###.#
#.###.#
#.###.#
#.....#
#######
```

Where:

```text
# = expected dark
. = expected light
```

This is much stronger than asking “are there three blobs?” It asks whether the blobs become real QR finder patterns when placed into the candidate grid.

### 9.5 Separator score

Around each finder, QR codes have a light separator border.

Roughly:

```text
........
.#######
.#.....#
.#.###.#
.#.###.#
.#.###.#
.#.....#
.#######
```

The study samples around the finder and expects light modules.

This matters because many random textures can have black square-ish patterns, but fewer have the correct light border around them.

### 9.6 Quiet-zone score

A real QR code should have a quiet zone: blank light area around the outside.

The spec quiet zone is commonly 4 modules wide.

The study samples outside the grid:

```text
row = -1, -2, -3, -4
row = size, size+1, size+2, size+3
col = -1, -2, -3, -4
col = size, size+1, size+2, size+3
```

It expects those samples to be light.

This is called **grid-coordinate quiet-zone scoring** because it uses the QR grid map, not image-axis rectangles.

### 9.7 Timing-pattern score

QR codes have timing patterns on row 6 and column 6.

They alternate black/white/black/white:

```text
# . # . # . # . # ...
```

The important coordinates are:

```text
row y = 6, columns x = 8 .. size-9
column x = 6, rows y = 8 .. size-9
```

Why start at 8 and end at `size-9`? Because the finder patterns occupy the corners. The timing corridor runs between them.

The phase is known:

```text
even index → dark
odd index  → light
```

So the study checks:

```text
at col 8 on row 6: dark
at col 9 on row 6: light
at col 10 on row 6: dark
...
```

and similarly down column 6.

The corrected phase-locked score includes:

| Sub-signal | Meaning |
| --- | --- |
| match score | How often sampled modules match expected black/white phase. |
| run score | How long the longest correct run is. |
| axis agreement | Whether row 6 and col 6 agree. |
| jitter penalty | Whether the sample only works after nudging around. |

#### Why phase matters

A weak timing check might say:

```text
it alternates somehow
```

But a real QR grid says exactly which modules should be dark and light.

Wrong:

```text
white black white black
```

may still alternate, but it is out of phase.

Correct phase-locked logic asks:

```text
Does it alternate in the exact QR phase implied by the grid?
```

That is much stronger.

---

## 10. Combined realism score

The current `grid-realism-ranking` / `realism-phase-locked` combined score is:

```text
combined =
  finder × 0.35
+ timing × 0.30
+ module × 0.15
+ quiet  × 0.10
+ min(projective, bounds) × 0.10
```

Why these weights?

- Finder template is strong semantic evidence.
- Timing corridor is strong QR-specific evidence.
- Module consistency checks scale coherence.
- Quiet zone helps reject busy backgrounds.
- Projective/bounds sanity catches broken geometry but is often saturated.

The study also compares other ranking objectives, such as:

```text
realism-module-heavy
realism-decode-likelihood
realism-low-risk
realism-geomean
realism-lexicographic
```

These are not canonized production decisions. They are experimental ways to ask:

```text
Which score shape ranks real decodes earlier and false positives later?
```

---

## 11. Ranking vs filtering

This distinction matters a lot.

### Ranking

Ranking means:

```text
try better-looking candidates first
```

No candidate is thrown away. If the best one fails, the scanner can still try later ones.

Ranking is safer because it usually cannot lose a valid QR unless there is a decode-attempt budget.

### Filtering

Filtering means:

```text
throw away candidates below threshold
```

Filtering can save work, but it can lose real codes.

Example:

```text
score >= 0.65
```

If a real QR candidate scores `0.64`, it gets dropped.

That is why the study now has threshold sweeps.

---

## 12. Clustering: grouping near-duplicate proposals

Many views may find nearly the same QR candidate.

Example:

```text
gray:otsu:normal found it
gray:hybrid:normal found it
oklab-l:otsu:normal found it
```

Trying all duplicates wastes decode attempts.

So the scanner groups similar proposals into **clusters**.

A cluster is:

```ts
{
  id,
  proposals,
  representatives,
  bestProposalScore,
  clusterScore,
  supportCount,
  viewDiversity
}
```

Explained:

| Field | Meaning |
| --- | --- |
| `proposals` | All similar candidates in the group. |
| `representatives` | Small number selected to try decoding. |
| `supportCount` | How many proposals support this cluster. |
| `viewDiversity` | How many different views agree. |
| `clusterScore` | Overall cluster strength. |

The study currently uses:

```text
maxClusterRepresentatives = 1 by default
```

So each cluster contributes one representative to the decode frontier.

---

## 13. Decode frontier: the actual order of work

After ranking and clustering, the scanner has an ordered list of representatives.

This is the decode frontier:

```text
representative 1
representative 2
representative 3
...
```

For each representative, decode may try multiple geometry candidates and sampling strategies. So one representative can cost many concrete decode attempts.

The study tracks:

```text
representatives processed
decode attempts
successes
false positives
```

---

## 14. Decode confirmation: what counts as success?

For a positive corpus asset:

```text
label = qr-pos
expectedTexts = [known payloads]
```

A decode is a match only if:

```text
decodedText ∈ expectedTexts
```

For a negative corpus asset:

```text
label = qr-neg
expectedTexts = []
groundTruth.qrCount = 0
```

Any accepted decoded payload is a false positive.

Recent unbounded runs found that all observed false positives decoded to:

```text
""
```

That is an empty payload. Empty-payload acceptance is a separate result-policy issue. It does not reduce decode attempts by itself, but it can prevent bogus accepted scan results and avoid stopping early on useless empty decodes.

---

## 15. The study's layered artifact cache

The study uses a layered cache so we do not recompute everything every time.

Layers:

| Layer | Name | Meaning |
| --- | --- | --- |
| L1 | normalized frame | Loaded/normalized image. |
| L2 | scalar views | Grayscale/color scalar channels. |
| L3 | binary views | Black/white thresholded views. |
| L4 | finder evidence | Finder detector results. |
| L5 | proposal batches | Finder triples/proposals per view. |
| L6 | ranked frontier | Globally ranked proposals. |
| L7 | cluster frontier | Clustered representatives. |
| L8 | decode outcome | Cached scanner decode outcomes when applicable. |

`finder-grid-realism` mostly consumes L1-L7, then derives its own per-variant rankings and optional decode comparisons.

Derived study stage versions:

```ts
stageVersions: {
  rankingPolicy: number,
  decodeComparison: number,
  visualization: number,
}
```

Bump:

- `rankingPolicy` when score formulas/order changes.
- `decodeComparison` when decode accounting/threshold/provenance semantics change.
- `visualization` when report charts change.

---

## 16. What the threshold sweep answers

The updated study now records per-representative frontier rows:

```ts
{
  signature,
  proposalId,
  binaryViewId,
  baselineRank,
  variantRank,
  clusterRank,
  representativeRank,
  score,
  proposalScore,
  components
}
```

And per-representative decode attempts:

```ts
{
  signature,
  rank,
  score,
  attemptCount,
  successCount,
  decodedText,
  matchedExpected,
  falsePositive
}
```

Then it simulates thresholds:

```text
keep candidate if score >= threshold
```

For each threshold it reports:

```text
representatives kept
representatives dropped
representative reduction %
decode attempts kept
decode attempts avoided
decode attempt reduction %
positive decoded assets kept
positive decoded assets lost
false-positive assets kept
false-positive assets removed
which positive asset ids were lost
which false-positive asset ids were removed
```

This directly answers the user's actual question:

```text
If we applied this confidence threshold, how much work would be reduced,
and how many valid decodes would we lose?
```

---

## 17. Example from the unbounded phase-locked run

For `grid-realism-ranking`, threshold behavior looked like:

| Threshold | Decode attempts avoided | Positives lost | False positives removed |
| ---: | ---: | ---: | ---: |
| 0.50 | 1.17% | 0 | 1 |
| 0.55 | 7.08% | 1 | 1 |
| 0.60 | 24.08% | 1 | 4 |
| 0.65 | 48.34% | 1 | 6 |
| 0.70 | 71.76% | 2 | 7 |
| 0.75 | 89.59% | 2 | 7 |

This says:

```text
The score is useful, but hard filtering is not free.
```

At `0.65`, it removes most false positives and about half the decode attempts, but loses one valid positive decode.

That means:

```text
Good candidate for prioritization or budget gating.
Not yet safe as a hard rejection policy.
```

---

## 18. Why false positives happen here

The false-positive assets were corpus negatives:

```text
label = qr-neg
groundTruth.qrCount = 0
```

The decoder returned a payload anyway.

In the inspected unbounded run, every false positive decoded as:

```text
""
```

So they are not convincing wrong QR messages. They are empty-payload accepts from QR-like texture.

This suggests a separate accepted-result policy:

```text
empty payload should be rejected from public scan results by default
```

But this is post-decode. It does not prevent the decode attempt from happening. It only prevents a useless result from being accepted and may allow scanning to continue to a later real payload.

---

## 19. What still needs stronger math

Current realism scoring is better than the first approximation, but there are more valuable signals to add.

Potential stronger signals:

```text
version-fit residual by both finder arms
finder edge/corner unwarp residual
per-finder 7x7 template score before averaging
row/col timing phase disagreement as a hard-ish penalty
format-info BCH plausibility
alignment-pattern plausibility for version >= 2
module pitch gradient consistency
perspective Jacobian sanity
cluster support weighted by view diversity
empty-payload likelihood diagnostics
```

### Version-fit residual

If the estimated size is 35 modules, nearest valid sizes are 33 and 37. Residual is:

```text
residual = distance_to_nearest_valid_size
```

Smaller is better.

### Jacobian sanity

A homography has local scale and direction at every grid point. The Jacobian describes how one tiny step in grid space changes image position.

In simple words:

```text
Jacobian = local ruler for the warped grid
```

It can tell whether module size changes smoothly or insanely across the QR code.

A real planar QR under perspective changes smoothly. Random triples may imply weird stretching.

### Format-info BCH plausibility

QR format information is protected by BCH error-correcting code. If the grid is real, the format bits near the finders should decode to a valid BCH-protected value.

This can be a very strong semantic signal, but it is more involved than timing/finder checks.

### Alignment pattern plausibility

QR versions 2 and above have alignment patterns. Once version is known, their positions are known.

The scanner can sample those predicted positions and ask:

```text
Do alignment-like marks exist where the QR spec says they should?
```

---

## 20. Final pipeline summary

Here is the whole realism pipeline in order:

```text
1. Load image.
2. Normalize frame.
3. Materialize scalar color/brightness views.
4. Threshold scalar views into binary black/white views.
5. Run row-scan and matcher finder detectors per view.
6. Deduplicate finder evidence.
7. Build finder triples.
8. Estimate candidate QR versions from finder distances and module sizes.
9. Build homography/grid candidates for each triple/version.
10. Score projective and bounds sanity.
11. Score finder module-size consistency.
12. Unwarp and score 7×7 finder templates.
13. Score finder separators.
14. Score quiet zone in grid coordinates.
15. Score phase-locked row 6 / column 6 timing patterns.
16. Combine scores into a realism score.
17. Rank representatives by baseline or realism objective.
18. Decode representatives in that order.
19. Record decode attempts, successes, mismatches, false positives, and empty payloads.
20. Simulate thresholds to measure work avoided vs valid decodes lost.
```

The key idea:

```text
Do not ask only “does this candidate look kind of QR-ish?”
Ask “can one mathematically valid QR grid explain this candidate, and does the QR spec show up where that grid predicts it should?”
```

That is finder-grid realism.
