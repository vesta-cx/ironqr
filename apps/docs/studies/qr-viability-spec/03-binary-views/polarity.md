# Polarity

Every scalar-view/threshold-method pair exposes both polarities:

```text
normal
inverted
```

Both polarities are tested because QR artwork can be dark-on-light or light-on-dark:

```text
normal QR:   black code on white background
inverted QR: light code on dark background
```

Normal polarity is threshold output. Inverted polarity is materialized from normal polarity:

```text
normal.data[index] = thresholdResult[index]
inverted.data[index] = 1 - normal.data[index]
```

The inverted view is derived from the already-materialized normal binary view, not from `SimpleImageData` and not by re-running thresholding.

Detector hot loops read `view.data[index]` directly. They do not dispatch through polarity-aware getters.
