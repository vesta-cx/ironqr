# Validation

The implementation and reports must capture:

| Metric | Purpose |
| --- | --- |
| Finder evidence reaching valid decode by scalar view | Avoid spending detector work on low-value views. |
| False-positive empty decodes by scalar view | Identify risky channels. |
| Positives rescued by chroma views after grayscale miss | Justify chroma-view cost. |
| Proposal volume without valid decode by scalar view | Identify views for lower priority or budget caps. |
| View usefulness by corpus family | Generated/stylized/photographic QR may need different view order. |
