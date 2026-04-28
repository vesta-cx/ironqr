import type { FinderEvidenceDetectionPolicy } from '../../../../packages/ironqr/src/pipeline/proposals.js';
import { makeProposalDecodeStudyPlugin } from './proposal-decode-study.js';

const STUDY_VERSION = 'study-v1';

type PolicyId = 'full-current' | 'no-flood';

const POLICIES = ['full-current', 'no-flood'] as const satisfies readonly PolicyId[];

const detectorPolicyForId = (policy: PolicyId): FinderEvidenceDetectionPolicy | undefined => {
  if (policy === 'no-flood') return { enabledFamilies: ['row-scan', 'matcher'] };
  return undefined;
};

export const proposalDetectorPolicyDecodeConfirmationStudyPlugin = makeProposalDecodeStudyPlugin({
  id: 'proposal-detector-policy-decode-confirmation',
  title: 'IronQR proposal detector policy decode confirmation study',
  description: 'Compares proposal detector-family policies against decode outcomes and costs.',
  version: STUDY_VERSION,
  variants: POLICIES,
  controlVariant: 'full-current',
  variantFlagName: 'policies',
  variantFlagLabel: 'policies',
  unknownVariantLabel: 'proposal detector policy',
  runtimeOptions: (policy) => {
    const proposalDetectorPolicy = detectorPolicyForId(policy);
    return proposalDetectorPolicy === undefined ? {} : { proposalDetectorPolicy };
  },
  recommendation: [
    'Promote only detector policies with zero positive decode loss and no false-positive increase relative to full-current.',
    'Use proposal, cluster, representative, decode-attempt, and timing deltas to decide whether detector work can be removed from the default pipeline.',
  ],
});
