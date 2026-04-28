# Tier 4 — Actionable Rejection

Use this branch when the source cannot be decoded into browser `ImageData` by platform decode, an existing format library, or an IronQR-owned decoder.

## Error contract

Unsupported formats fail with an actionable error:

```text
unsupported_image_format
```

The error message tells the caller how to proceed:

```text
convert to PNG/JPEG/WebP
enable or install the required decoder package
provide an already-decoded ImageData input
```

## Common causes

```text
unsupported source kind
unsupported image format
missing decoder package
malformed source bytes
encrypted or protected media
multi-page or multi-frame format without a selected frame policy
source byte limit exceeded
metadata dimensions over budget
decoder failure
```

## Output

This branch has no `ImageData` output.

```text
source → actionable media-decode error
```

## Reporting

Reports count rejection outcomes by:

```text
source kind
format signal
error code
runtime
configured decoder packages
```

These counts guide future support decisions and decoder-package installation guidance.
