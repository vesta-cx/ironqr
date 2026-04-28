# Binary View ID

`BinaryViewId` is the canonical source of scalar-view, threshold-method, and polarity metadata:

```text
scalarViewId : thresholdMethod : polarity
```

Code that needs those parts parses the id once or uses registry metadata keyed by `BinaryViewId`, rather than duplicating the fields on every `BinaryView`.

Examples:

```text
gray:otsu:normal
gray:otsu:inverted
ok-l:sauvola:normal
ok-a:otsu:inverted
b:hybrid:normal
```
