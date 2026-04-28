import { finderGridRealismStudyPlugin } from './finder-grid-realism.js';
import {
  binaryBitHotPathStudyPlugin,
  binaryPrefilterSignalsStudyPlugin,
  finderRunMapStudyPlugin,
  moduleSamplingHotPathStudyPlugin,
  scalarMaterializationFusionStudyPlugin,
  sharedBinaryDetectorArtifactsStudyPlugin,
  thresholdStatsCacheStudyPlugin,
} from './image-processing.js';
import { proposalClusterRepresentativePrioritizationStudyPlugin } from './proposal-cluster-representative-prioritization.js';
import { proposalDetectorPolicyStudyPlugin } from './proposal-detector-policy.js';
import { proposalDetectorPolicyDecodeConfirmationStudyPlugin } from './proposal-detector-policy-decode-confirmation.js';
import { proposalGenerationVariantsStudyPlugin } from './proposal-generation-variants.js';
import { proposalGeometryDecodeConfirmationStudyPlugin } from './proposal-geometry-decode-confirmation.js';
import { proposalGeometryViabilityStudyPlugin } from './proposal-geometry-viability.js';
import { proposalRankingDecodeConfirmationStudyPlugin } from './proposal-ranking-decode-confirmation.js';
import type { StudyPlugin } from './types.js';
import { viewOrderStudyPlugin, viewProposalsStudyPlugin } from './view-order.js';

export const defaultStudyPlugins: readonly StudyPlugin[] = [
  binaryBitHotPathStudyPlugin,
  binaryPrefilterSignalsStudyPlugin,
  finderRunMapStudyPlugin,
  moduleSamplingHotPathStudyPlugin,
  scalarMaterializationFusionStudyPlugin,
  sharedBinaryDetectorArtifactsStudyPlugin,
  thresholdStatsCacheStudyPlugin,
  proposalClusterRepresentativePrioritizationStudyPlugin,
  proposalDetectorPolicyStudyPlugin,
  proposalDetectorPolicyDecodeConfirmationStudyPlugin,
  proposalGenerationVariantsStudyPlugin,
  proposalGeometryViabilityStudyPlugin,
  proposalGeometryDecodeConfirmationStudyPlugin,
  proposalRankingDecodeConfirmationStudyPlugin,
  finderGridRealismStudyPlugin,
  viewProposalsStudyPlugin,
  viewOrderStudyPlugin,
];

export const defaultStudyWorkerPlugins: readonly StudyPlugin[] = defaultStudyPlugins.filter(
  (plugin) => plugin.runAsset,
);
