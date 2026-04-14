/**
 * Detects the semantic type of a QR code payload string.
 * Returns a short lowercase label suitable for `GroundTruthCode.kind`.
 */
export const detectQrKind = (text: string): string => {
  const t = text.trim();

  if (/^https?:\/\//i.test(t)) return 'url';
  if (/^ftp:\/\//i.test(t)) return 'url';
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
