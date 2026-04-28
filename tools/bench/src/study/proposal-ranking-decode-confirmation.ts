import type { ProposalRankingVariant } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import { makeProposalDecodeStudyPlugin } from './proposal-decode-study.js';

const STUDY_VERSION = 'study-v1';

const VARIANTS = [
  'baseline',
  'timing-heavy',
  'quiet-timing-heavy',
  'decode-signal-heavy',
] as const satisfies readonly ProposalRankingVariant[];

export const proposalRankingDecodeConfirmationStudyPlugin = makeProposalDecodeStudyPlugin({
  id: 'proposal-ranking-decode-confirmation',
  title: 'IronQR proposal ranking decode confirmation study',
  description: 'Compares proposal ranking formulas against decode outcomes and costs.',
  version: STUDY_VERSION,
  variants: VARIANTS,
  controlVariant: 'baseline',
  unknownVariantLabel: 'proposal ranking',
  runtimeOptions: (variant) => ({ proposalRankingVariant: variant }),
  recommendation: [
    'Promote only ranking variants with zero positive decode loss and no false-positive increase relative to baseline.',
    'Prefer variants that reduce decode attempts and scan time after accuracy is preserved.',
  ],
});
