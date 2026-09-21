/** Stable, documented error codes. Never invent one at a call site. */
export const ErrorCodes = {
  // request / auth
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INVALID_TOKEN: 'invalid_token',
  TOKEN_EXPIRED: 'token_expired',
  SESSION_REVOKED: 'session_revoked',
  SESSION_EXPIRED: 'session_expired',
  CONCURRENT_SESSION_LIMIT: 'concurrent_session_limit',
  RATE_LIMITED: 'rate_limited',
  // assets
  NOT_FOUND: 'not_found',
  ASSET_NOT_READY: 'asset_not_ready',
  ASSET_DELETED: 'asset_deleted',
  INVALID_REQUEST: 'invalid_request',
  CONFLICT: 'conflict',
  // pipeline
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PROBE_FAILED: 'PROBE_FAILED',
  TRANSCODING_FAILED: 'TRANSCODING_FAILED',
  PACKAGING_FAILED: 'PACKAGING_FAILED',
  ENCRYPTION_FAILED: 'ENCRYPTION_FAILED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
  DELETION_FAILED: 'DELETION_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  INTERNAL: 'internal_error',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ObscuraError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ObscuraError';
    this.code = code;
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail ?? {};
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, ...this.detail };
  }
}

export const badRequest = (m: string, d?: Record<string, unknown>) =>
  new ObscuraError(ErrorCodes.INVALID_REQUEST, m, { status: 400, detail: d });
export const unauthorized = (m = 'Missing or invalid credentials') =>
  new ObscuraError(ErrorCodes.UNAUTHORIZED, m, { status: 401 });
export const forbidden = (m = 'Not permitted') =>
  new ObscuraError(ErrorCodes.FORBIDDEN, m, { status: 403 });
export const notFound = (m = 'Not found') =>
  new ObscuraError(ErrorCodes.NOT_FOUND, m, { status: 404 });
export const conflict = (m: string, d?: Record<string, unknown>) =>
  new ObscuraError(ErrorCodes.CONFLICT, m, { status: 409, detail: d });
