# Scalar Selection Policy

The scalar set catches QR contrast across:

```text
brightness
red channel
green channel
blue channel
perceptual lightness
red/green chroma
blue/yellow chroma
```

The goal is to create enough independent views that real finder patterns show up in at least one of them.

## Current proposal-view subset

The scanner has a prioritized proposal-view subset derived from a prior exhaustive view report. These are binary view ids, but they imply scalar view ids that have historically helped.

Current first entries:

```text
gray:otsu:normal
oklab-l:hybrid:normal
gray:sauvola:normal
oklab-l:sauvola:normal
oklab-l:otsu:normal
b:hybrid:normal
...
```

This means `gray`, `oklab-l`, and `b` have been strong early contributors in previous measured runs.
