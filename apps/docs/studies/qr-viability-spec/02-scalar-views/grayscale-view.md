# Grayscale View

```text
gray
```

Formula after alpha compositing on white:

```text
gray = round(0.299 × R8 + 0.587 × G8 + 0.114 × B8)
```

`R8`, `G8`, and `B8` are the 0..255 alpha-composited canonical SDR RGB bytes from `SimpleImageData`. The coefficients are Rec. 601-style luma (`Y'`) in gamma-encoded RGB, not linear luminance (`Y`).

## Purpose

- Most QR codes are dark-on-light contrast.
- Grayscale is cheap.
- Grayscale is the baseline signal users expect.

## Limits

- Colored QR codes may hide contrast in grayscale.
- Background color can reduce luminance contrast.
- Stylized assets may have useful chroma contrast but weak brightness contrast.
