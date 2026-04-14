/**
 * Detects the semantic type of a QR code payload string.
 * Returns a short lowercase label suitable for `GroundTruthCode.kind`.
 */

const isValidUrl = (text: string, protocols: readonly string[]): boolean => {
  // URLs cannot contain unencoded whitespace. The WHATWG URL parser silently
  // percent-encodes spaces rather than throwing, so we must guard explicitly.
  if (/\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return protocols.includes(url.protocol);
  } catch {
    return false;
  }
};

export const detectQrKind = (text: string): string => {
  const t = text.trim();

  // MEBKM bookmark — Japanese mobile standard; may begin with a plain URL
  // fallback before the MEBKM: record. Must be checked before the URL rule
  // because the payload can start with http:// yet not be a plain URL.
  if (/MEBKM:/i.test(t)) return 'bookmark';

  // Validate URLs strictly — unencoded spaces or other invalid chars disqualify.
  if (isValidUrl(t, ['http:', 'https:', 'ftp:'])) return 'url';

  // Structured schemes — prefix matching is correct here; spaces are allowed
  // within the value portion of these formats (e.g. SSID, phone number display).
  if (/^mailto:/i.test(t)) return 'email';
  if (/^tel:/i.test(t)) return 'phone';
  if (/^sms:|^smsto:/i.test(t)) return 'sms';
  if (/^mms:|^mmsto:/i.test(t)) return 'mms';
  if (/^geo:/i.test(t)) return 'geo';
  if (/^WIFI:/i.test(t)) return 'wifi';
  if (/^BEGIN:VCARD/i.test(t)) return 'vcard';
  if (/^BEGIN:VEVENT/i.test(t)) return 'vevent';
  if (/^MECARD:/i.test(t)) return 'mecard';
  if (/^otpauth:/i.test(t)) return 'otpauth';
  if (/^bitcoin:|^bitcoincash:|^ethereum:/i.test(t)) return 'crypto';

  // Bare email address with no scheme
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(t)) return 'email';

  return 'text';
};
