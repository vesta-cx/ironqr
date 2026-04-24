# Proposal Clusters

Related: [[Ranked Proposal Pipeline]], [[Early Exit Heuristics]], [[View Study]]

## Concept
A proposal cluster is a coarse grouping of ranked proposals that appear to describe the same physical QR candidate.

Typical duplicates come from:
- different scalar views (`gray`, `r`, `g`, `b`, `oklab-*`)
- different threshold families (`otsu`, `sauvola`, `hybrid`)
- polarity variants (`normal`, `inverted`)
- multiple geometry seeds on one finder-triple proposal

## Why cluster?
The expensive work is usually not proposal generation itself. It is the repeated decode cascade across many nearly identical proposals.

Clustering converts the budget unit from:
- "every ranked proposal"

to:
- "a small number of diverse representatives for one QR candidate"

## Representative policy
Current representative selection is greedy:
1. always keep the best-ranked proposal
2. prefer new view families (`gray`, `rgb`, `oklab-l`, `oklab-chroma`)
3. then prefer unseen threshold/polarity profiles
4. finally fill with the next best-ranked proposals

This is a heuristic placeholder until the [[View Study]] produces an empirical ordering.

## Cluster kill policy
For one cluster:
- probe representatives in priority order
- if a representative passes early structural checks, spend full decode budget on that representative
- if representatives fail early structural checks repeatedly before any success, reject the cluster

This policy is intentionally asymmetric:
- one success is enough to keep the cluster alive
- repeated strong structural failures are enough to stop spending work on it

## Important caveat
Overlap across views is useful evidence, but not proof.
- real QRs often recur across multiple views
- noise can also recur across multiple correlated views

That is why clustering is used for budget control and ranking, not as a hard truth label.
