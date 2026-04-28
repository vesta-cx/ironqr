import type { ClusterRepresentativeVariant } from '../../../../packages/ironqr/src/pipeline/clusters.js';
import { makeProposalDecodeStudyPlugin } from './proposal-decode-study.js';

const STUDY_VERSION = 'study-v1';

const VARIANTS = [
  'proposal-score',
  'timing-score',
  'quiet-timing-score',
  'decode-signal-score',
  'view-diverse-score',
] as const satisfies readonly ClusterRepresentativeVariant[];

export const proposalClusterRepresentativePrioritizationStudyPlugin = makeProposalDecodeStudyPlugin(
  {
    id: 'proposal-cluster-representative-prioritization',
    title: 'IronQR proposal cluster representative prioritization study',
    description:
      'Compares representative ordering policies within proposal clusters against decode outcomes and costs.',
    version: STUDY_VERSION,
    variants: VARIANTS,
    controlVariant: 'proposal-score',
    unknownVariantLabel: 'cluster representative',
    runtimeOptions: (variant) => ({ proposalClusterRepresentativeVariant: variant }),
    recommendation: [
      'Promote only representative variants with zero positive decode loss and no false-positive increase relative to proposal-score.',
      'Use processed representatives, decode attempts, cluster, and timing deltas to decide whether representative ordering reduces downstream work.',
    ],
  },
);
