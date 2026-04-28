# Validation

The implementation and reports must measure:

| Metric | Purpose |
| --- | --- |
| Valid decodes by detector family | Validate row-scan/matcher policy. |
| False positives or empty-payload decodes by detector family | Understand detector risk. |
| Recall by finder-seed cap per view | Tune work caps. |
| Row-scan/matcher agreement on the same finder | Build confidence/support signals. |
| Valid decodes by small module-size finders | Decide minimum module-size policy. |
