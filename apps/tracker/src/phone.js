/**
 * Phone numbers, as people type them and as WhatsApp wants them.
 *
 * Its own module because two places need it and they should not need each
 * other: the reminder rules decide who has a number worth messaging, and the
 * WhatsApp transport addresses the message. Neither has any business importing
 * the other.
 *
 * Nothing here touches the network or a Node built-in, so the rules stay
 * testable on their own and the browser can use the same formatting.
 */

/**
 * The country code assumed for a number typed the local way.
 *
 * `966` is Saudi Arabia: the plant is at Yasref and the team writes their
 * numbers as `05x xxx xxxx`. A deployment elsewhere sets
 * `TRACKER_WHATSAPP_COUNTRY`.
 */
export const DEFAULT_COUNTRY = '966';

/**
 * Turn whatever somebody typed into the digits WhatsApp wants.
 *
 * WhatsApp addresses a person by their number in full international form with
 * no `+`, no spaces and no leading zero — `966551234567`. People do not type it
 * that way. They type `0551234567`, or `+966 55 123 4567`, or
 * `00966-55-123-4567`, and all three are the same phone.
 *
 * Returns null rather than a guess when the result could not be a real number,
 * so a mistyped digit becomes a visible "no WhatsApp number" instead of a
 * message quietly prepared for a stranger.
 */
export function normalisePhone(value, country = DEFAULT_COUNTRY) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const cc = String(country ?? DEFAULT_COUNTRY).replace(/\D/g, '') || DEFAULT_COUNTRY;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  const full = (() => {
    // `00` is the international prefix dialled from most of the world and `+`
    // is the same thing written down. Either way, what follows is complete.
    if (raw.startsWith('+')) return digits;
    if (digits.startsWith('00')) return digits.slice(2);
    // A leading zero is the national trunk code — dropped, and the country code
    // put in its place. `0551234567` at Yanbu is `966551234567`.
    if (digits.startsWith('0')) return cc + digits.replace(/^0+/, '');
    // Already carries its country code. The length test matters: a local number
    // that happens to begin with the same digits as the country code is not an
    // international one, and `9661234` should become `9669661234`, not stay.
    if (digits.startsWith(cc) && digits.length > cc.length + 5) return digits;
    // A bare local number — `551234567`.
    return cc + digits;
  })();

  // E.164 allows fifteen digits at most, and nothing shorter than eight is a
  // mobile number anywhere.
  if (full.length < 8 || full.length > 15) return null;
  return full;
}

/** `966551234567` → `+966 55 123 4567`, for showing a number back to a person. */
export function displayPhone(value, country = DEFAULT_COUNTRY) {
  const digits = normalisePhone(value, country);
  if (!digits) return '';
  const tail = digits.slice(-9);
  const cc = digits.slice(0, digits.length - 9);
  return `+${cc} ${tail.slice(0, 2)} ${tail.slice(2, 5)} ${tail.slice(5)}`.trim();
}
