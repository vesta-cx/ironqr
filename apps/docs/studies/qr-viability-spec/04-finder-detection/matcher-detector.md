# Matcher Detector

The matcher detector checks likely center pixels and runs horizontal/vertical finder cross-checks.

Current flow:

```text
step through image pixels
→ skip pixels that are not dark centers
→ horizontal cross-check
→ vertical cross-check
→ combine into matcher evidence
```

The step size adapts to image size:

```text
step = max(1, floor(min(width, height) / 180))
```

Small images are scanned densely. Larger images skip some pixels for speed.

Matcher evidence rejects combined module sizes below:

```text
0.8 px/module
```

The shared cross-check ratio scorer rejects total run length below 7, so accepted row/matcher evidence is practically still around:

```text
moduleSize >= 1 px/module
```
