# Threshold Methods

Current threshold methods:

```text
otsu
sauvola
hybrid
```

Each method converts a scalar view into normal-polarity threshold output. Stage 03 then materializes inverted polarity from the normal binary view.

## Otsu thresholding

Otsu is a global threshold.

Detailed math lives in [Otsu Threshold Math](./math-otsu.md).

Use it for:

- cheap first-pass thresholding,
- images with clear global contrast,
- stable baseline signal.

Limits:

- uneven lighting,
- shadows,
- local glare,
- QR over textured backgrounds.

## Sauvola thresholding

Sauvola is a local adaptive threshold.

Detailed math lives in [Sauvola Threshold Math](./math-sauvola.md).

Use it for:

- local lighting changes,
- photographed QR codes,
- finders missed by global thresholding.

Risk:

- texture can become QR-like black/white structure,
- busy images can produce many false finder candidates.

## Hybrid thresholding

Hybrid blends global and local threshold ideas.

Detailed math lives in [Hybrid Threshold Math](./math-hybrid.md).

Use it when:

- Otsu is stable but too global,
- Sauvola is local but too noisy,
- hard photographed assets need rescue thresholding.
