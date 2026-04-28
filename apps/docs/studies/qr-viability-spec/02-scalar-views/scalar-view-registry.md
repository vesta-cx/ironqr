# Scalar View Registry

Current scalar views:

```text
gray
r
g
b
oklab-l
oklab+a
oklab-a
oklab+b
oklab-b
```

They fall into three groups:

| Group | View ids | Purpose |
| --- | --- | --- |
| [Grayscale](./grayscale-view.md) | `gray` | Cheap Rec. 601 luma baseline. |
| [RGB channel views](./rgb-channel-views.md) | `r`, `g`, `b` | Capture contrast isolated to one RGB channel. |
| [OKLab views](./oklab-views.md) | `oklab-l`, `oklab+a`, `oklab-a`, `oklab+b`, `oklab-b` | Capture perceptual lightness and chroma-axis contrast. |

The static registry owns grouping and formula metadata keyed by `ScalarViewId`.
