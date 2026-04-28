# Flood Detector History

Flood-style finder detection looked for connected dark rings and center stones.

It can estimate module size from area:

```text
moduleSize = sqrt(ringPixelCount / 24)
```

It accepts components with at least:

```text
pixelCount >= 16
```

So flood could theoretically emit module estimates below 1 px/module.

Flood is historical context only for the current spec. It is not part of the canonical detector policy.
