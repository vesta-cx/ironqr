# 05 — Finder Evidence Construction

Finder evidence construction is the handoff between “a detector saw something” and “later math can use this as a QR-grid anchor.”

This is the stage we need to redesign most carefully.

The current pipeline stores a compact finder summary. The target math-based realism pipeline should store enough local geometry to fit and judge a QR unwarp accurately.

## Current input

Input comes from a finder detector on one binary view.

A detector usually knows:

```text
where it saw the finder center
how wide the 1:1:3:1:1 runs were
which axis was horizontal/vertical
how well the local ratio matched
which binary view produced it
```

## Current output

Current `FinderEvidence` shape:

```ts
interface FinderEvidence {
  readonly source: ProposalSource;
  readonly centerX: number;
  readonly centerY: number;
  readonly moduleSize: number;
  readonly hModuleSize: number;
  readonly vModuleSize: number;
  readonly score?: number;
}
```

Meaning:

| Field | Meaning |
| --- | --- |
| `centerX`, `centerY` | Estimated finder center in image coordinates. |
| `moduleSize` | Average estimated pixels per QR module. |
| `hModuleSize` | Horizontal module-size estimate. |
| `vModuleSize` | Vertical module-size estimate. |
| `source` | Detector family, such as row-scan or matcher. |
| `score` | Detector-local confidence. |

This is enough to seed finder triples. It is not enough for robust, math-based QR realism.

## Why current evidence is too compressed

A real finder pattern is not one point. It is a 7×7 module lattice.

Current evidence reduces that lattice to:

```text
one center point + rough scale
```

That throws away:

```text
outer finder corners
edge centers
module centers
module intersections
local skew
local perspective
which individual modules matched the template
reprojection residuals
```

Because of that, later stages have to infer too much from too little.

## Target principle

Finder evidence should have two layers:

1. **Finder seed**: cheap detector output.
2. **Finder geometry evidence**: refined local lattice with continuous image-space coordinates.

The seed tells us where to look. The geometry evidence tells us what math should fit.

## Coordinate policy

All geometry points should be continuous image-space coordinates:

```ts
interface Point {
  readonly x: number;
  readonly y: number;
}
```

Coordinates may be fractional:

```text
(123.5, 88.6666667)
```

They are not integer pixel indices.

Policy:

```text
rounding is forbidden during geometry fitting
rounding/interpolation only happens at image sampling boundaries
```

Current convention to document:

```text
integer pixel coordinates are pixel centers
```

So:

```text
pixel center:       (10, 20)
edge between pixels: (10.5, 20)
```

## Target finder evidence shape

Proposed high-level shape:

```ts
interface FinderEvidence {
  readonly source: ProposalSource;
  readonly centerX: number;
  readonly centerY: number;
  readonly moduleSize: number;
  readonly hModuleSize: number;
  readonly vModuleSize: number;
  readonly score?: number;

  /** Optional refined local geometry. */
  readonly geometry?: FinderGeometryEvidence;
}
```

The compact fields stay because they are cheap and useful for compatibility.

The new field carries the rich math.

## Target refined finder geometry

```ts
interface FinderGeometryEvidence {
  /** Continuous image-space center of the finder pattern. */
  readonly center: Point;

  /** One-module local basis vectors in continuous image space. */
  readonly basis: {
    readonly right: Point;
    readonly down: Point;
  };

  /** Outer 7x7 finder boundary corners. */
  readonly outerCorners: {
    readonly topLeft: Point;
    readonly topRight: Point;
    readonly bottomRight: Point;
    readonly bottomLeft: Point;
  };

  /** Centers of the four outer finder edges. */
  readonly edgeCenters: {
    readonly top: Point;
    readonly right: Point;
    readonly bottom: Point;
    readonly left: Point;
  };

  /** 49 module centers in the 7x7 finder lattice. */
  readonly moduleCenters: readonly FinderModuleCenter[];

  /** 64 lattice intersections for the 8x8 module-edge grid. */
  readonly moduleIntersections: readonly FinderModuleIntersection[];

  /** How well this local finder fit the image. */
  readonly fit: FinderGeometryFit;
}
```

### Module centers

```ts
interface FinderModuleCenter {
  readonly row: number; // 0..6
  readonly col: number; // 0..6
  readonly image: Point;
  readonly expectedDark: boolean;
  readonly observedDarkScore?: number;
}
```

There are 49 of these:

```text
7 rows × 7 cols = 49 centers
```

The expected finder template is:

```text
#######
#.....#
#.###.#
#.###.#
#.###.#
#.....#
#######
```

So `expectedDark` is true for:

```text
outer ring
3x3 center
```

and false for the white ring.

### Module intersections

```ts
interface FinderModuleIntersection {
  readonly edgeRow: number; // 0..7
  readonly edgeCol: number; // 0..7
  readonly image: Point;
}
```

There are 64 of these:

```text
8 horizontal edge lines × 8 vertical edge lines = 64 intersections
```

They describe the corners of all 49 modules.

Why intersections matter:

```text
homography fitting likes point correspondences
module edges/corners give stronger geometry than only module centers
```

## Local basis vectors

The local basis says:

```text
if I move one finder module to the right, image point changes by this vector
if I move one finder module down, image point changes by this vector
```

Example:

```ts
basis.right = { x: 3.2, y: 0.4 }
basis.down  = { x: -0.2, y: 3.1 }
```

These are not points on their own. They are displacements, but they can use the same `{x, y}` shape.

## Fit metrics

```ts
interface FinderGeometryFit {
  readonly templateScore: number;
  readonly edgeContrastScore: number;
  readonly latticeResidualPx: number;
  readonly modulePitchPx: number;
  readonly axisRatio: number;
  readonly darkLightSeparation: number;
}
```

Meaning:

| Field | Meaning |
| --- | --- |
| `templateScore` | How well the 7×7 expected finder pattern matches. |
| `edgeContrastScore` | Whether module boundaries have strong black/white transitions. |
| `latticeResidualPx` | Pixel error after fitting local finder lattice. Lower is better. |
| `modulePitchPx` | Estimated pixels per module. |
| `axisRatio` | Ratio of horizontal/vertical local module scales. |
| `darkLightSeparation` | How distinct expected dark and light modules are in sampled scalar/binary data. |

## How refined geometry could be built

This should be a new refinement step after cheap detection:

```text
finder seed
→ choose local search window using center and module size
→ fit local 7x7 finder lattice
→ sample expected dark/light modules
→ adjust center/basis/corners to minimize residual
→ output FinderGeometryEvidence or reject
```

Possible fitting methods:

### Method A: axis-aligned local lattice from h/v sizes

Start simple:

```text
center = detector center
right = (hModuleSize, 0)
down = (0, vModuleSize)
```

Then sample the 7×7 template.

Pros:

```text
cheap, easy, good first diagnostic
```

Cons:

```text
bad under rotation/perspective
```

### Method B: oriented local lattice from run centers

Use horizontal and vertical cross-check centers and run edges to estimate the local right/down basis.

Pros:

```text
captures small rotation/skew better
```

Cons:

```text
still mostly local-affine, not full perspective
```

### Method C: local homography for finder patch

Fit the 7×7 finder template to the local image with a small homography.

Pros:

```text
best math signal
produces module intersections and residuals
```

Cons:

```text
more expensive
needs careful implementation and empirical validation
```

## How this helps triple realism

Given three refined finder geometries, later stages can build correspondences.

For top-left finder:

```text
finder local module center (row=0,col=0)
→ global QR grid module center (row=0,col=0)
```

For top-right finder:

```text
finder local module center (row=0,col=0)
→ global QR grid module center (row=0,col=size-7)
```

For bottom-left finder:

```text
finder local module center (row=0,col=0)
→ global QR grid module center (row=size-7,col=0)
```

With all module centers:

```text
3 finders × 49 centers = 147 correspondences
```

With all intersections:

```text
3 finders × 64 intersections = 192 correspondences
```

Then a later stage can fit one shared QR homography and measure:

```text
reprojection error = distance(predicted image point, observed image point)
```

This is far stronger than center-only geometry.

## Empirical questions

The study should measure:

| Question | Why |
| --- | --- |
| Do low-res finder seeds with module size near 1 px ever produce valid decodes? | Decide min module-size policy. |
| Does finder lattice residual separate positives from negatives? | Candidate ranking/filter signal. |
| Do valid decodes come from finders with strong template scores? | Validate finder refinement. |
| Do false positives have weak quiet/separator/lattice signals? | Build FP filters. |
| Which views produce refined finders that survive to decode? | View prioritization. |
| Does row-scan or matcher produce better refined geometry? | Detector policy. |

## Cache boundary

Current L4 cache stores finder evidence.

For the target pipeline, split this conceptually:

```text
L4a finder seeds
L4b refined finder geometry
```

Bump L4a when cheap detector output changes.

Bump L4b when local finder-refinement math, sampled coordinates, fit metrics, or template semantics change.

## Important design decision

The current compact `FinderEvidence` should be treated as a **seed**, not as the final geometry truth.

For math-based realism, the important artifact is:

```text
refined finder geometry with subpixel lattice points and residuals
```

That is the object that should drive future unwarp and realism studies.
