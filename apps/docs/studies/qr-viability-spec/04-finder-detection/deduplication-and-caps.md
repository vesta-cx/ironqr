# Deduplication and Caps

Detectors can emit many nearby hits for the same physical finder.

The pipeline clusters nearby finder evidence. The distance threshold scales with module size but has a floor:

```text
distance < max(2, min(moduleSizeA, moduleSizeB) × factor)
```

This prevents tiny module estimates from making duplicate clustering too strict.

Current caps keep finder work bounded:

```text
MAX_FINDER_EVIDENCE_TOTAL = 12
```

Caps are detector-work controls. Later decode-confirmation reports must verify that a cap preserves valid positives before it becomes a production policy change.
