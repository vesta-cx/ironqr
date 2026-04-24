# Corpus Strategy

Related: [[corpus-cli/Generated Corpus]]

## Scope
This note documents corpus growth and evaluation policy owned by `tools/corpus-cli` and the corpus data layout.

It is not an `ironqr` architecture note, even though `ironqr` and `@ironqr/bench` consume the resulting corpus.

## Goal
Grow the corpus in a way that improves decision quality.

The target is not "more files." The target is a corpus that supports better scanner tuning, better benchmarking, and more trustworthy regressions.

## Growth policy
Expand the corpus **strategically**.

Prioritize more examples from these strata:
- stylized positives
- geometry-stress positives
- hard negatives
- multi-code assets
- polarity edge cases
- photographic screen/print captures when useful

A corpus that grows only by easy, similar examples creates misleading confidence.

## Tagging policy
Per-asset tags or strata should become first-class metadata.

Useful tags include dimensions such as:
- `stylized`
- `photographic`
- `screen`
- `print`
- `perspective`
- `blur`
- `contrast`
- `polarity`
- `multi-code`
- `negative-patterned`

These tags exist to improve reporting and sampling, not to replace the human review record.

## Evaluation split policy
Maintain a held-out evaluation split.

Reason:
- corpus-driven policy changes are valuable
- corpus-driven overfitting is also easy

A held-out slice makes it possible to ask whether a tuning change generalizes beyond the assets that inspired it.

## Reporting policy
Bench and study reporting should become stratum-aware where possible.

That means future reporting should be able to answer questions like:
- did this change help stylized positives?
- did it reduce hard-negative false positives?
- did it only help the already-easy print subset?

Headline accuracy alone is not enough.

## Policy-freezing rule
Do not freeze long-term scanner policy from the current corpus alone.

Current corpus studies are useful for steering decisions, but they are not broad enough to justify treating one ranking or threshold choice as final forever.

This is especially important for:
- proposal-view ordering
- cluster representative policy
- early-exit thresholds

## Real vs synthetic balance
Use both real and generated data, but do not collapse them into one undifferentiated pool.

- real reviewed assets remain the main source of truth
- generated assets provide controlled stress and extra coverage
- evaluation should preserve the distinction

## Duplicate policy
Exact duplicates can be removed aggressively.
Perceptual near-duplicates should not be auto-deleted without review.

Near-duplicate families can still be useful when they differ by:
- label
- stratum
- acquisition context
- distortion severity

## Review-correction policy
Sometimes a benchmarked "false positive" is actually a mislabeled corpus asset.
When review confirms that an asset really contains a decodable QR code, correct the canonical manifest instead of treating the scanner result as a hallucination forever.

When correcting a reviewed asset in `corpus/data/manifest.json`:
- update `label` to match the corrected truth
- update `groundTruth` to the verified QR content and kind
- record `verifiedWith` when the correcting decoder is known
- preserve historical `autoScan` data unless the intent is to rewrite review-time scan history

This keeps the corpus truth separate from historical automation metadata.

## Practical target
A reasonable near-term target is a deliberately selected corpus in roughly the low hundreds, not an unbounded dump.

The point is broad, reviewable coverage with meaningful strata, not maximum raw asset count.
