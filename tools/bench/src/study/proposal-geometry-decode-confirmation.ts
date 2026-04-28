import type { ProposalGeometryVariant } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import { makeProposalDecodeStudyPlugin } from './proposal-decode-study.js';

const STUDY_VERSION = 'study-v1';

const VARIANTS = [
  'baseline',
  'aspect-reject-conservative',
  'timing-corridor-reject-conservative',
  'aspect-timing-penalty',
] as const satisfies readonly ProposalGeometryVariant[];

export const proposalGeometryDecodeConfirmationStudyPlugin = makeProposalDecodeStudyPlugin({
  id: 'proposal-geometry-decode-confirmation',
  title: 'IronQR proposal geometry decode confirmation study',
  description: 'Confirms semantic proposal geometry filters against decode outcomes and costs.',
  version: STUDY_VERSION,
  variants: VARIANTS,
  controlVariant: 'baseline',
  unknownVariantLabel: 'geometry decode',
  runtimeOptions: (variant) => ({ proposalGeometryVariant: variant }),
  recommendation: [
    'Promote only variants with zero positive decode loss and no false-positive increase relative to baseline.',
    'Treat proposal, cluster, decode-attempt, and timing deltas as downstream work indicators after accuracy is preserved.',
  ],
});
