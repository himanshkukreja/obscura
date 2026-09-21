/**
 * Field names that must never reach a log sink. Used as the pino redaction list and
 * asserted against by a test, so a new secret-bearing field cannot be added silently.
 */
export const SENSITIVE_FIELDS = [
  'token', 'playback_token', 'playbackToken', 'access_token', 'refresh_token',
  'key', 'content_key', 'contentKey', 'master_key', 'masterKey',
  'secret', 'secretAccessKey', 'secret_access_key', 'password',
  'authorization', 'cookie', 'set-cookie',
  'apiKey', 'api_key', 'privateKey', 'private_key', 'seed',
] as const;

export const PINO_REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.query.t',
  'query.t',
  ...SENSITIVE_FIELDS.map((f) => `*.${f}`),
  ...SENSITIVE_FIELDS.map((f) => f),
];

/** Strip a token query parameter from a URL before it is logged or echoed back. */
export function scrubUrl(url: string): string {
  return url.replace(/([?&])t=[^&]*/g, '$1t=REDACTED');
}
