# Ranked Proposal Pipeline

## Goal
Spend decode budget on the most QR-like candidates first, while keeping enough fallback behavior to recover hard real-world symbols.

## Current stages
1. Normalize the frame.
2. Build scalar and binary views.
3. Generate finder-driven proposals per view.
4. Rank proposals globally.
5. [[Proposal Clusters|Cluster]] near-duplicate proposals that appear to describe the same QR candidate.
6. Probe a small number of diverse representatives per cluster.
7. Use [[Early Exit Heuristics|cheap structural checks]] to reject obviously bad candidates before full decode.
8. Run the full decode cascade only on representatives that survive the early checks.

## Why clustering exists
Without clustering, the pipeline treats each threshold/channel variant as independent work even when they all describe the same underlying QR candidate. That multiplies expensive decode work across many near-duplicates.

## Why early exits exist
A proposal can look locally finder-like while still failing to induce a believable QR module lattice. Cheap lattice checks are much cheaper than full decode retries, so they should run first.

## Design constraints
- Preserve the normal single-result path for ordinary scans.
- Prefer strong negative tests over strict positive tests.
- Avoid hard rules that delete difficult-but-real codes just because only one view surfaced them.

## Current corpus-driven hardening priorities
The present benchmark frontier is not broad proposal generation. The hard misses already reach proposal generation, ranking, clustering, structural checks, and many decode attempts.

Recent corpus-driven hardening already landed:
1. **Adaptive version estimation**
   - strong proposals can widen beyond their initial estimated versions when finder geometry and payload evidence suggest underestimation
2. **Version-neighborhood rescue for strong proposals**
   - nearby versions are now retried before a structurally strong candidate is abandoned
3. **Softer timing-pattern rejection for near-miss grids**
   - timing support is now treated as a scored rescue signal, not only a hard kill switch
4. **Decode-header rescue inside strict grid decode**
   - near-miss format-info candidates are tried after strict BCH decode fails
   - size-implied and nearby version candidates are tried when version bits are noisy

The highest-value next hardening steps are now:
1. **Stronger geometry rescue**
   - the remaining hard misses look more like corner-placement / homography quality problems than version-header problems
   - explicit-corner rescue should expand beyond the current far-corner-heavy fallback
2. **Better sampler / phase rescue**
   - stylized and photographic symbols often appear to fail because of module-phase error rather than total localization failure
   - this is especially relevant when a proposal decodes to structurally plausible but text-shifted junk
3. **Multi-symbol recovery after the first decode**
   - some assets appear to contain at least one decodable symbol plus additional missed symbols
   - this likely needs decoded-region suppression or a second-pass search rather than only better first-symbol ranking

## What is not the current frontier
The current evidence does **not** prioritize:
- major rework of proposal-view ordering
- broad proposal-generation expansion
- perf-focused trimming of the view tail

Those may matter later, but the present accuracy gap is more decode/geometry/version driven than proposal-order driven.
