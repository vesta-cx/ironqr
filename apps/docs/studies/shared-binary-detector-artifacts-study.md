# Shared Binary Detector Artifacts Study

## Problem / question

Normal and inverted binary views now share polarity-free threshold planes, but detector artifacts such as run maps, component labels, transition counts, and view-level masks may still be rebuilt separately per polarity. The study asks:

> Which detector artifacts can be shared between normal and inverted views, and does sharing them reduce detector time without changing scan results?

The unit of decision is artifact caching keyed by threshold plane rather than full binary view id. A clear result would change production to cache reusable detector artifacts beside `BinaryPlane` and apply polarity as metadata where possible.

## Hypothesis / thesis

Many detector artifacts are color-labeled structures over the same threshold plane. Normal and inverted views reinterpret dark/light, but the underlying runs and connected components are identical with flipped color labels. Sharing polarity-neutral artifacts should reduce repeated image-processing work, especially in exhaustive studies and any production shortlist containing both polarities.

Null hypothesis: detector artifacts depend too deeply on polarity-aware semantics, or conversion from polarity-neutral artifacts costs as much as rebuilding.

## Designed experiment / study

Run paired baseline/candidate studies with all 54 views enabled. Include a production-shortlist run if the shortlist includes inverted views.

Candidate artifacts to evaluate independently:

1. polarity-neutral run maps;
2. polarity-neutral connected-component labels with color bit metadata;
3. transition-density and black/white ratio summaries;
4. finder candidate pre-evidence derived from runs/components.

Do not skip inverted views. The candidate must still process the same view ids and proposals; the only change is artifact reuse.

## Metrics table

| Metric | Unit | Source | Decision use |
| --- | --- | --- | --- |
| Artifact build duration by kind | ms | new timing spans | Primary subsystem metric. |
| Artifact cache hits/misses | count | study metrics | Confirms sharing. |
| Detector duration by polarity | ms | proposal-view spans | Primary end-to-end detector metric. |
| Normal/inverted proposal counts | count | per-view report | Must preserve behavior. |
| Finder evidence counts by source | count | proposal summary | Detects detector drift. |
| Positive decoded assets | assets | study summary | Must not regress. |
| False-positive assets | assets | study summary | Must not increase. |
| Artifact memory bytes | bytes | study metadata | Memory tradeoff. |
| Result/proposal diff | exact diff | paired comparator | Must be empty or explained. |

## Decision rule

Adopt an artifact-sharing layer if:

- positive decoded assets do not decrease;
- false positives do not increase;
- proposal/finder evidence differences are absent or proven ordering-only;
- detector duration across paired normal/inverted views improves by at least 15%;
- added memory is less than rebuilding equivalent artifacts per polarity.

Adopt artifacts incrementally. For example, ship shared run maps even if shared connected components are not yet worth it.

## Implementation checklist

- [ ] Define polarity-neutral artifact keys based on `BinaryPlane` identity.
- [ ] Add artifact timing spans and cache hit/miss counters.
- [ ] Implement shared run summaries first, because they support multiple detector paths.
- [ ] Evaluate shared connected components separately.
- [ ] Add paired-report diffs for normal/inverted proposal and decode results.
- [ ] Document which artifacts are safe to share and which remain polarity-specific.

## Results

Placeholder. Include per-artifact timing, memory, cache hit rate, and behavior diffs.

## Interpretation plan

Separate exhaustive-study wins from production wins. Exhaustive studies always process both polarities for every threshold plane; production may not. If production rarely includes paired polarities, the artifact must still pay for itself through reuse across detectors within one view.

## Conclusion / evidence-backed decision

Placeholder. Document adopted shared artifacts and link the evidence proving no scan-result regression.
