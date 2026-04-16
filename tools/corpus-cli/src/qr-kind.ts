export type QrKind =
  | 'url'
  | 'otpauth'
  | 'crypto'
  | 'bookmark'
  | 'email'
  | 'phone'
  | 'sms'
  | 'mms'
  | 'geo'
  | 'wifi'
  | 'vcard'
  | 'vevent'
  | 'mecard'
  | 'text';

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

export const detectQrKind = (text: string): QrKind => {
  const t = text.trim();

  // ── URI schemes validated strictly with new URL() ───────────────────────────
  // These must be structurally valid (no unencoded whitespace, parseable).
  // URL check runs before MEBKM so that a valid URL containing "MEBKM:" in its
  // path (e.g. https://example.com/api/MEBKM:foo) is not misclassified.
  if (isValidUrl(t, ['http:', 'https:', 'ftp:'])) return 'url';
  if (isValidUrl(t, ['otpauth:'])) return 'otpauth';
  if (isValidUrl(t, ['bitcoin:', 'bitcoincash:', 'ethereum:'])) return 'crypto';

  // ── MEBKM bookmark ──────────────────────────────────────────────────────────
  // Japanese mobile bookmark standard. Payload often begins with a plain URL
  // fallback (for basic readers) followed by the MEBKM: record, e.g.:
  //   http://sagasou.mobi MEBKM:TITLE:…;URL:http\://sagasou.mobi;;
  // That URL prefix has an unencoded space so it failed isValidUrl above.
  if (/MEBKM:/i.test(t)) return 'bookmark';

  // ── Structured schemes — prefix matching only ───────────────────────────────
  // Spaces are allowed within the value portion of these formats (SSID, phone
  // number display form, email subject/body, etc.) so strict URL parsing would
  // produce false negatives.
  if (/^mailto:/i.test(t)) return 'email';
  if (/^tel:/i.test(t)) return 'phone';
  if (/^sms:|^smsto:/i.test(t)) return 'sms';
  if (/^mms:|^mmsto:/i.test(t)) return 'mms';
  if (/^geo:/i.test(t)) return 'geo';
  if (/^WIFI:/i.test(t)) return 'wifi';
  if (/^BEGIN:VCARD/i.test(t)) return 'vcard';
  if (/^BEGIN:VEVENT/i.test(t)) return 'vevent';
  if (/^MECARD:/i.test(t)) return 'mecard';

  // ── Bare email address (no scheme) ─────────────────────────────────────────
  if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(t)) return 'email';

  return 'text';
};
