import type { StagedRemoteAsset } from './contracts.js';
import { isAllowedImageHost, normalizeHost } from './policy.js';

const PIXABAY_HOST = 'pixabay.com';
const PIXABAY_LICENSE = 'Pixabay License';

/** Trusted staged-asset fields used to infer a platform-guaranteed license. */
export type TrustedLicenseAsset = Pick<
  StagedRemoteAsset,
  'sourceHost' | 'sourcePageUrl' | 'imageUrl'
>;

/**
 * Returns a platform-guaranteed license string when the staged asset comes from
 * a host whose terms are fixed at the platform level and the recorded source
 * URLs still match the expected domain/CDN pair.
 */
export const getTrustedPlatformLicense = (asset: TrustedLicenseAsset): string | undefined => {
  const sourceHost = normalizeHost(asset.sourceHost);
  if (sourceHost !== PIXABAY_HOST) {
    return undefined;
  }

  try {
    const sourcePageHost = normalizeHost(new URL(asset.sourcePageUrl).hostname);
    if (sourcePageHost !== PIXABAY_HOST) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  if (!isAllowedImageHost(PIXABAY_HOST, asset.imageUrl)) {
    return undefined;
  }

  return PIXABAY_LICENSE;
};
