const ALLOWED_SOURCE_HOSTS = new Set([
  'pixabay.com',
  'commons.wikimedia.org',
  'publicdomainpictures.net',
  'pexels.com',
  'pdimagearchive.org',
  'unsplash.com',
]);

const PAGE_LINK_PATTERNS: Record<string, readonly RegExp[]> = {
  'pixabay.com': [/^\/(photos|illustrations|vectors)\//],
  'commons.wikimedia.org': [/^\/wiki\/File:/],
  'publicdomainpictures.net': [/^\/view-image\.php/, /^\/picture\//],
  'pexels.com': [/^\/photo\//],
  // pdimagearchive.org serves images directly from seed pages — there are no
  // detail page URLs to navigate to, so no patterns are needed.
  'pdimagearchive.org': [],
  'unsplash.com': [/^\/photos\//],
};

const ALLOWED_IMAGE_HOSTS: Record<string, ReadonlySet<string>> = {
  'pixabay.com': new Set(['pixabay.com', 'cdn.pixabay.com']),
  'commons.wikimedia.org': new Set(['commons.wikimedia.org', 'upload.wikimedia.org']),
  'publicdomainpictures.net': new Set(['publicdomainpictures.net']),
  'pexels.com': new Set(['pexels.com', 'images.pexels.com']),
  'pdimagearchive.org': new Set(['pdimagearchive.org']),
  'unsplash.com': new Set(['unsplash.com', 'images.unsplash.com']),
};

export interface StagedRemoteAssetUrls {
  readonly seedUrl: string;
  readonly sourceHost: string;
  readonly sourcePageUrl: string;
  readonly imageUrl: string;
}

/** Strips a leading `www.` prefix and lowercases a hostname. */
export const normalizeHost = (value: string): string => {
  return value.replace(/^www\./, '').toLowerCase();
};

/** Parses `seedUrl` and throws if its host is not in the scraping allowlist. */
export const assertAllowedSeed = (seedUrl: string): URL => {
  const url = new URL(seedUrl);
  const host = normalizeHost(url.hostname);

  if (!ALLOWED_SOURCE_HOSTS.has(host)) {
    throw new Error(`Seed host is not in the allowlist: ${host}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Seed URL must use HTTPS: ${seedUrl}`);
  }

  return url;
};

/** Returns the URL path patterns used to identify detail pages for `host`. */
export const getPageLinkPatterns = (host: string): readonly RegExp[] => {
  return PAGE_LINK_PATTERNS[host] ?? [];
};

/** Returns `true` if `imageUrl`'s host is in the CDN allowlist for `sourceHost`. */
export const isAllowedImageHost = (sourceHost: string, imageUrl: string): boolean => {
  try {
    const imageHost = normalizeHost(new URL(imageUrl).hostname);
    const allowed = ALLOWED_IMAGE_HOSTS[sourceHost];
    if (!allowed) return imageHost === sourceHost;
    return allowed.has(imageHost);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
};

/** Validates that a staged asset's seed, source-page, and image URLs are self-consistent and allowlisted. */
export const assertAllowedStagedAssetUrls = ({
  seedUrl,
  sourceHost,
  sourcePageUrl,
  imageUrl,
}: StagedRemoteAssetUrls): void => {
  const seed = assertAllowedSeed(seedUrl);
  const expectedSourceHost = normalizeHost(seed.hostname);

  if (normalizeHost(sourceHost) !== expectedSourceHost) {
    throw new Error(`Source host does not match seed host: ${sourceHost}`);
  }

  let sourcePageHost: string;
  try {
    sourcePageHost = normalizeHost(new URL(sourcePageUrl).hostname);
  } catch {
    throw new Error(`Source page URL is invalid: ${sourcePageUrl}`);
  }
  if (sourcePageHost !== expectedSourceHost) {
    throw new Error(`Source page host is not allowlisted: ${sourcePageHost}`);
  }

  if (!isAllowedImageHost(expectedSourceHost, imageUrl)) {
    throw new Error(`Image host is not in CDN allowlist for ${expectedSourceHost}`);
  }
};
