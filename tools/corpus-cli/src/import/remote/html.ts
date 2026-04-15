import { getPageLinkPatterns, normalizeHost } from './policy.js';
import { htmlToText, stripAnsi } from './text.js';

const absolutize = (baseUrl: string, value: string | null): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

const parseSrcset = (value: string, baseUrl: string): readonly string[] => {
  return value
    .split(',')
    .map((entry) => entry.trim().split(/\s+/, 1)[0] ?? '')
    .map((candidate) => absolutize(baseUrl, candidate))
    .filter((candidate): candidate is string => candidate !== null);
};

const dedupe = (values: readonly string[]): string[] => {
  return [...new Set(values)];
};

const matchAllGroups = (pattern: RegExp, value: string, groupIndex = 1): string[] => {
  if (!pattern.global) {
    throw new Error('matchAllGroups requires a global regular expression');
  }

  const matches: string[] = [];
  let match = pattern.exec(value);

  while (match !== null) {
    const candidate = match[groupIndex];
    if (candidate) {
      matches.push(candidate);
    }
    match = pattern.exec(value);
  }

  return matches;
};

// ── Attribution extraction ──────────────────────────────────────────────────

const MAX_ATTRIBUTION_LENGTH = 200;
const MAX_EVIDENCE_CONTEXT_LENGTH = 80;

/**
 * For Wikimedia Commons file pages the file info table uses
 * id="fileinfotpl_aut" to mark the Author row. The adjacent <td> holds the
 * author name, possibly wrapped in a link.
 */
export const extractCommonsAttribution = (html: string): string | null => {
  const rowMatch =
    /id=["']fileinfotpl_aut["'][^<]*<\/[^>]+>\s*<\/td>\s*<td[^>]*>(.*?)<\/td>/is.exec(html);
  if (rowMatch?.[1]) {
    const text = stripAnsi(htmlToText(rowMatch[1]));
    if (text.length > 0 && text.length < MAX_ATTRIBUTION_LENGTH) return text;
  }
  return null;
};

// ── License detection helpers ────────────────────────────────────────────────

const extractOgLicense = (html: string): string | null => {
  const m =
    /<meta\b[^>]*(?:property|name)=["']og:license["'][^>]*content=["']([^"']+)["'][^>]*>/i.exec(
      html,
    ) ??
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:license["'][^>]*>/i.exec(
      html,
    );
  return m?.[1]?.trim() ?? null;
};

const extractCcUrl = (html: string): string | null => {
  // Match CC license URLs in href/content attributes to avoid matching inside
  // longer redirect URLs. The lookbehind anchors to a quote or whitespace.
  const m = /(?<=["'\s])https:\/\/creativecommons\.org\/licenses\/([a-z-]+)\/([0-9.]+)/i.exec(html);
  if (m?.[1] && m[2]) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  if (/(?<=["'\s])https?:\/\/creativecommons\.org\/publicdomain\/zero/i.test(html))
    return 'CC0 1.0';
  return null;
};

/**
 * For Wikimedia Commons file pages the license template renders a
 * <span class="licensetpl_short"> element with the canonical short name
 * (e.g. "CC BY-SA 4.0", "Public domain"). This is the most reliable signal.
 */
const detectCommonsLicense = (
  html: string,
): { bestEffortLicense?: string; licenseEvidenceText?: string } => {
  const shortSpan = /<span[^>]*class="[^"]*licensetpl_short[^"]*"[^>]*>([^<]+)<\/span>/i.exec(html);
  if (shortSpan?.[1]) {
    return { bestEffortLicense: shortSpan[1].trim(), licenseEvidenceText: shortSpan[0] };
  }

  const ogLicense = extractOgLicense(html);
  if (ogLicense) return { bestEffortLicense: ogLicense, licenseEvidenceText: ogLicense };

  const ccUrl = extractCcUrl(html);
  if (ccUrl) return { bestEffortLicense: ccUrl, licenseEvidenceText: ccUrl };

  if (/public.?domain/i.test(html)) {
    const evidence = new RegExp(`public.?domain[^<]{0,${MAX_EVIDENCE_CONTEXT_LENGTH}}`, 'i')
      .exec(html)?.[0]
      ?.trim();
    return {
      bestEffortLicense: 'Public domain',
      ...(evidence ? { licenseEvidenceText: evidence } : {}),
    };
  }

  return { bestEffortLicense: 'Unknown (verify Commons file page)' };
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Heuristically detects a license string from page HTML for the given host.
 * Returns `bestEffortLicense` and optional `licenseEvidenceText`; both may be absent.
 */
export const detectBestEffortLicense = (
  host: string,
  html: string,
): { bestEffortLicense?: string; licenseEvidenceText?: string } => {
  if (host === 'commons.wikimedia.org') {
    return detectCommonsLicense(html);
  }

  // Try og:license meta tag first — most reliable when present
  const ogLicense = extractOgLicense(html);
  if (ogLicense) return { bestEffortLicense: ogLicense, licenseEvidenceText: ogLicense };

  // CC license URL present anywhere on the page
  const ccUrl = extractCcUrl(html);
  if (ccUrl) return { bestEffortLicense: ccUrl, licenseEvidenceText: ccUrl };

  // Host-specific known licenses
  if (host === 'pdimagearchive.org') {
    return { bestEffortLicense: 'Public domain (verify page)' };
  }
  if (host === 'unsplash.com') {
    return { bestEffortLicense: 'Unsplash License (free to use, no attribution required)' };
  }

  // Keyword fallbacks — match the text surrounding the keyword for evidence
  const lowerHtml = html.toLowerCase();
  if (lowerHtml.includes('pixabay license')) {
    return { bestEffortLicense: 'Pixabay License', licenseEvidenceText: 'Pixabay License' };
  }
  if (lowerHtml.includes('pexels license')) {
    return { bestEffortLicense: 'Pexels License', licenseEvidenceText: 'Pexels License' };
  }
  if (/\bcc0\b/i.test(html) || lowerHtml.includes('public domain')) {
    const evidence = new RegExp(`(?:cc0|public domain)[^<]{0,${MAX_EVIDENCE_CONTEXT_LENGTH}}`, 'i')
      .exec(html)?.[0]
      ?.trim();
    return {
      bestEffortLicense: 'CC0 / Public domain',
      ...(evidence ? { licenseEvidenceText: evidence } : {}),
    };
  }
  if (lowerHtml.includes('royalty-free') || lowerHtml.includes('royalty free')) {
    const evidence = new RegExp(`royalty.free[^<]{0,${MAX_EVIDENCE_CONTEXT_LENGTH}}`, 'i')
      .exec(html)?.[0]
      ?.trim();
    return {
      bestEffortLicense: 'Royalty free (verify page)',
      ...(evidence ? { licenseEvidenceText: evidence } : {}),
    };
  }

  return {};
};

/** Extracts absolute image URLs from `og:image`, `twitter:image`, and `image_src` link tags. */
export const extractMetaImageCandidates = (pageUrl: string, html: string): readonly string[] => {
  return dedupe(
    [
      ...matchAllGroups(
        /<meta\b[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
        html,
      ),
      ...matchAllGroups(
        /<link\b[^>]*rel=["']image_src["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
        html,
      ),
    ]
      .map((value) => absolutize(pageUrl, value))
      .filter((candidate): candidate is string => candidate !== null),
  );
};

/** Extracts absolute image URLs from `<img>` and `<source>` `src`/`srcset` attributes. */
export const extractInlineImageCandidates = (pageUrl: string, html: string): readonly string[] => {
  return dedupe(
    [
      ...matchAllGroups(/<(?:img|source)\b[^>]*src=["']([^"']+)["'][^>]*>/gi, html),
      ...matchAllGroups(/<(?:img|source)\b[^>]*srcset=["']([^"']+)["'][^>]*>/gi, html).flatMap(
        (srcset) => parseSrcset(srcset, pageUrl),
      ),
    ]
      .map((value) => absolutize(pageUrl, value))
      .filter((candidate): candidate is string => candidate !== null),
  );
};

const normalizePageLinks = (pageUrl: string, matches: readonly string[]): readonly string[] => {
  const baseUrl = new URL(pageUrl);
  const host = normalizeHost(baseUrl.hostname);
  const patterns = getPageLinkPatterns(host);
  if (patterns.length === 0) return [];

  return dedupe(
    matches
      .map((href) => absolutize(pageUrl, href))
      .filter((href): href is string => href !== null)
      .filter((href) => normalizeHost(new URL(href).hostname) === host)
      .filter((href) => patterns.some((pattern) => pattern.test(new URL(href).pathname))),
  );
};

const extractWrappedPageLinks = (
  pageUrl: string,
  html: string,
): readonly { href: string; imageCandidates: readonly string[] }[] => {
  const baseUrl = new URL(pageUrl);
  const host = normalizeHost(baseUrl.hostname);
  const patterns = getPageLinkPatterns(host);
  if (patterns.length === 0) return [];

  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      href: absolutize(pageUrl, match[1] ?? ''),
      imageCandidates: extractInlineImageCandidates(pageUrl, match[2] ?? ''),
    }))
    .filter(
      (
        match,
      ): match is {
        href: string;
        imageCandidates: readonly string[];
      } => match.href !== null,
    )
    .filter((match) => match.imageCandidates.length > 0)
    .filter((match) => normalizeHost(new URL(match.href).hostname) === host)
    .filter((match) => patterns.some((pattern) => pattern.test(new URL(match.href).pathname)));
};

/**
 * Extracts detail-page URLs from `html` that match the host's configured link patterns.
 * `allowFanOut` enables fallback to bare `<a href>` scanning when no wrapped links are found.
 */
export const extractPageLinks = (
  pageUrl: string,
  html: string,
  allowFanOut: boolean,
): readonly string[] => {
  const wrappedLinks = extractWrappedPageLinks(pageUrl, html);
  const metaImageCandidates = extractMetaImageCandidates(pageUrl, html);

  if (wrappedLinks.length === 0) {
    if (!allowFanOut) {
      return [];
    }

    return extractInlineImageCandidates(pageUrl, html).length === 0
      ? normalizePageLinks(pageUrl, matchAllGroups(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, html))
      : [];
  }

  if (metaImageCandidates.length > 0) {
    const metaMatchingWraps = wrappedLinks.filter((link) =>
      link.imageCandidates.some((candidate) => metaImageCandidates.includes(candidate)),
    );

    if (metaMatchingWraps.length > 0) {
      return normalizePageLinks(pageUrl, dedupe(metaMatchingWraps.map((link) => link.href)));
    }

    if (!allowFanOut) {
      return [];
    }
  }

  if (!allowFanOut) {
    return [];
  }

  return normalizePageLinks(pageUrl, dedupe(wrappedLinks.map((link) => link.href)));
};

/**
 * Returns the most relevant image candidates for a page.
 * On detail pages prefers meta candidates; on listing pages returns a deduplicated union.
 */
export const extractImageCandidates = (
  pageUrl: string,
  html: string,
  isDetail: boolean,
): readonly string[] => {
  const metaCandidates = extractMetaImageCandidates(pageUrl, html);

  if (isDetail && metaCandidates.length > 0) {
    return metaCandidates;
  }

  const inlineCandidates = extractInlineImageCandidates(pageUrl, html);
  if (isDetail) {
    return inlineCandidates;
  }

  return dedupe([...metaCandidates, ...inlineCandidates]);
};
