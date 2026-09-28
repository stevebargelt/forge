// FG-781 RF-1 / FG-820: the free-text denylist redactor, in core so the attention-inbox
// derivation (src/v2/attention-inbox-sources.ts) and the dashboard's remote projection
// share ONE definition. Pure: no I/O.

/** RF-1 (FG-781 AC4): `reason`/`requestedAction` are operator-authored free text on the
 *  attention source — the only unbounded strings that cross the remote boundary. Invariant #6
 *  forbids the DTO from carrying arbitrary filesystem paths or credentials/auth metadata, so
 *  every free-text field is passed through this redactor first: a defense-in-depth denylist
 *  layered UNDER the positive field allowlist (the allowlist keeps unnamed fields out; this
 *  keeps a path or secret from riding inside a named one). It is deliberately conservative —
 *  on a read-only remote surface an over-redacted word is strictly safer than a leaked path. */
const REMOTE_REDACTED = "[redacted]";
const REMOTE_FREE_TEXT_REDACTIONS: readonly RegExp[] = [
  // key=value / key: value credential pairs (token, secret, password, api_key, bearer, …).
  // RF-5: after the key, consume the COMPLETE construct — an optional auth scheme word
  // (Bearer/Basic/Token/Digest/Negotiate/NTLM/ApiKey/OAuth) AND the credential token that
  // follows. Without the optional scheme group, `\S+` stops at the scheme word alone, so a
  // standard echo "Authorization: Bearer shortSecret1" redacts to "[redacted] shortSecret1"
  // and the (short, non-prefixed) secret survives. Proxy-Authorization is included as a key.
  /\b(?:tokens?|secrets?|passwords?|passwd|pwd|api[_-]?keys?|access[_-]?keys?|secret[_-]?keys?|(?:proxy[_-]?)?auth(?:orization)?|bearer|credentials?)\b\s*[:=]\s*(?:(?:bearer|basic|token|digest|negotiate|ntlm|apikey|oauth)\s+)?\S+/gi,
  // RF-5: a bare "Bearer <token>" construct with no key — the Authorization header VALUE on its
  // own, as a provider commonly echoes it back in an error. Scheme word + the credential token.
  /\bbearer\s+\S+/gi,
  // Known credential token shapes (GitHub/OpenAI/Slack/AWS prefixes).
  /\b(?:ghp|gho|ghs|ghr|ghu|sk|xox[baprs]|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g,
  // RF-5: any scheme://host[:port][/path] URL, REGARDLESS of path depth. The POSIX-path rule
  // below only catches URLs with two or more path segments; a bare scheme://host with no path
  // (e.g. https://control.invalid, ws://relay:9000) would otherwise slip. Runs before the path
  // rule so the whole URL is redacted in one shot, not just its trailing path.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,
  // RF-5: a bare host:port authority with no scheme — a dotted hostname followed by a numeric
  // port (e.g. control.invalid:8443). Requires the dotted domain + colon + digits so ordinary
  // prose, a "key: value" pair, or a fraction like "9/8" is left untouched.
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}:\d{2,5}\b/gi,
  // Windows absolute path.
  /[A-Za-z]:\\[^\s"']+/g,
  // POSIX absolute path (two or more segments), so a lone "/" or a fraction like "9/8" is left.
  /\/(?:[\w.@~%+-]+\/)+[\w.@~%+-]*/g,
  // Generic high-entropy token: 24+ chars mixing letters and digits (catches opaque secrets).
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g,
];

export function redactRemoteFreeText(text: string): string {
  let out = text;
  for (const pattern of REMOTE_FREE_TEXT_REDACTIONS) out = out.replace(pattern, REMOTE_REDACTED);
  return out;
}
