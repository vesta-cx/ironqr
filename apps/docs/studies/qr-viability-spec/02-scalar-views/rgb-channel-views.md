# RGB Channel Views

```text
r
g
b
```

Each view is one alpha-composited RGB channel scaled to `0..255`:

```text
r = R8
g = G8
b = B8
```

`R8`, `G8`, and `B8` are the 0..255 alpha-composited canonical SDR RGB bytes from `SimpleImageData`.

## Purpose

- Some QR-like contrast appears strongly in one color channel.
- Blue/yellow or red/cyan artwork can be weak in grayscale but strong in one channel.
- RGB channel views are cheap to compute after normalization.
