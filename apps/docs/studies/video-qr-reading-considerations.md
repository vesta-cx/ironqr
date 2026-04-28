# Video QR Reading Considerations

This note is outside the math-based realism pipeline spec on purpose.

The staged realism spec defines how one decoded frame becomes views, finder evidence, grid candidates, semantic checks, and decode outcomes. Video scanning adds a second dimension: time.

For video, running the full still-image pipeline independently for every frame is correct but often wasteful. A video scanner can learn from previous frames and adapt work for the next frames.

## Goal

Design a future video QR scanner that can:

```text
process frames continuously
reuse safe temporal state
adapt view/proposal priorities over time
track likely QR locations
avoid stale-state false positives
fall back to full-frame search when tracking fails
```

## Non-goal for now

This doc does not change the current scanner pipeline or artifact spec.

It records future design considerations so the single-frame pipeline does not accidentally block a good video architecture.

## Core idea

A still-image scan has no memory:

```text
frame → full pipeline → result
```

A video scan should have session memory:

```text
frame N → pipeline + session state → result + updated session state
frame N+1 → prioritized pipeline using updated session state
```

The session state must be explicit. It should not be hidden inside `NormalizedImage` or global caches.

## Proposed conceptual objects

```ts
interface VideoQrSession {
  readonly decoderCache: MediaDecoderCache;
  readonly viewPriorityState: ViewPriorityState;
  readonly temporalGeometryState: TemporalGeometryState;
  readonly resultHistory: DecodeResultHistory;
}
```

Each frame still has its own per-frame context:

```ts
interface FrameScanContext {
  readonly frame: NormalizedImage;
  readonly views: ViewBank;
  readonly timestampMs?: number;
}
```

So the separation is:

```text
VideoQrSession
  cross-frame memory

FrameScanContext
  one decoded frame and its per-frame derived views
```

## Media decode reuse

For a video stream, the encoded source format usually does not change every frame.

Potential reusable state:

```text
codec/container information
decoder backend selection
pixel format conversion path
frame dimensions
rotation/orientation metadata
color profile / transfer behavior
```

The scanner should not rediscover this from scratch for every frame if the video source is stable.

Possible policy:

```text
initialize media decode session once
validate dimensions once at stream start
validate decoded frame dimensions cheaply per frame
reuse decoder/conversion path until stream metadata changes
```

## Dynamic view prioritization

In still-image scanning, view order is static or study-derived.

In video, the scanner can learn which views work for the current scene.

Examples:

```text
gray:otsu:normal produced the last 20 successful finder triples
oklab-l:hybrid:normal produced strong timing evidence
inverted views produced no useful proposals for 60 frames
sauvola produced many false candidates in this scene
```

Then the next frame can prioritize:

```text
views that recently decoded
views that recently produced high-confidence finder geometry
views that are cheap and stable
```

But it should occasionally probe lower-priority views so it can recover when lighting or QR appearance changes.

Possible state:

```ts
interface ViewPriorityState {
  readonly recentSuccessesByView: Record<string, number>;
  readonly recentFalseSignalsByView: Record<string, number>;
  readonly lastWinningViewId?: string;
  readonly explorationBudget: number;
}
```

## Region-of-interest tracking

If a QR was found in frame N, frame N+1 probably contains it nearby.

Reusable state:

```text
last QR corners
last homography
last finder centers
last module pitch
last bounding box
last decoded payload
```

Next frame can scan a region of interest first:

```text
expand last bounds by margin
try last successful view first
try local finder/geometry refinement near previous corners
attempt decode before full-frame search
```

If local tracking fails, fall back to full-frame search.

## Finder and cluster temporal state

Potential cross-frame state:

```text
finder positions and velocities
cluster ids / stable candidate identities
estimated QR grid size/version
module pitch trend
homography trend
confidence over time
```

This allows predictions like:

```text
finder center should move roughly here next frame
module pitch should stay near this value
QR corners should not teleport
```

Useful temporal checks:

```text
position continuity
scale continuity
rotation/skew continuity
payload continuity
view continuity
```

These are not hard truth. A user can move the camera quickly, switch codes, or show multiple codes.

## Decode-result memory

If the same QR payload is decoded for many frames, the scanner should avoid spamming duplicate results.

Possible policies:

```text
emit first decode immediately
suppress repeated same-payload results for a cooldown window
emit again if payload disappears then reappears
track confidence over consecutive frames
```

For multi-QR video, the session needs per-code identities:

```text
payload + approximate geometry
or geometry track id before decode
```

## Adaptive budgets

Video scanning has a frame-time budget.

Example:

```text
30 FPS → ~33ms/frame
60 FPS → ~16ms/frame
```

A video scanner may need budgets such as:

```text
max views per frame
max proposals per view
max decode attempts per frame
max local-tracking attempts
full-frame refresh every N frames
```

Possible strategy:

```text
local tracked decode first
then high-priority views
then partial full-frame search if budget remains
periodic full refresh to avoid stale lock-in
```

## Avoiding stale-state bugs

Temporal state can help, but it can also make the scanner stubborn.

Failure modes:

```text
keeps searching old QR location after camera moved
keeps prioritizing a view that used to work but no longer does
suppresses a new QR because payload dedupe is too aggressive
trusts old geometry and misses a new code
tracks a false positive across frames
```

Mitigations:

```text
confidence decay over time
full-frame fallback after local failure
exploration budget for non-winning views
track invalidation on large motion or repeated decode failure
separate raw decoder successes from accepted results
empty-payload rejections should not create stable tracks
```

## Interaction with the single-frame realism pipeline

The single-frame pipeline should remain pure and testable:

```text
one frame in → scored frontier/decode outcome out
```

Video should wrap it with temporal policy:

```text
session state chooses priorities and budgets
single-frame pipeline computes evidence on current frame
session state updates from evidence and outcomes
```

Do not hide temporal state inside single-frame artifacts such as `NormalizedImage`, `FinderEvidence`, or `ViewBank`.

## Future study questions

A video QR study should measure:

| Question | Why |
| --- | --- |
| How many frames to first decode? | User-perceived latency. |
| How many decode attempts per successful frame? | CPU/battery budget. |
| Does view-priority adaptation reduce work without increasing misses? | Dynamic ordering value. |
| Does ROI tracking recover the same QR faster than full-frame scanning? | Temporal geometry value. |
| How often does stale tracking miss new codes? | Safety guard. |
| How often do false positives persist across frames? | Result acceptance policy. |
| Does empty-payload rejection reduce repeated video false positives? | Acceptance-policy validation. |

## Open design questions

1. Should video scanning live in the core package or as a higher-level session wrapper?
2. What is the public API shape?

```ts
scanner.scanFrame(frame)
scanner.scanVideoFrame(frame, timestamp)
scanner.createSession(options)
```

3. How should browser `VideoFrame`, `<video>`, canvas, and native frames be normalized?
4. Should temporal state be serializable for worker handoff?
5. How should multi-code tracking work before payload decode?
6. How often should full-frame search run when tracking is successful?
7. What should happen when the same payload appears in two different locations?

## Recommended future architecture

```text
MediaDecodeSession
  knows how to decode frames from a stable video source

VideoQrSession
  owns temporal scanner state and budgets

FrameScanContext
  owns one normalized frame and one ViewBank

SingleFramePipeline
  remains deterministic and mostly stateless
```

This keeps video intelligence additive instead of contaminating the single-frame QR realism pipeline.
