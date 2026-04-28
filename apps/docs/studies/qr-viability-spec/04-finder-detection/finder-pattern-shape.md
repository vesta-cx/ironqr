# Finder Pattern Shape

A QR finder pattern has a 1:1:3:1:1 run ratio through its center:

```text
black white black white black
  1     1     3     1     1
```

Across a center row it looks like:

```text
# . ### . #
```

The same structure appears vertically through the center.

Finder detectors use this ratio as a cheap local signal. This stage only identifies local finder-shaped candidates; later stages validate triples, grid geometry, homography, and QR semantics.
