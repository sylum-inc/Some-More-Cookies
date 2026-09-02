import type { ApiErrorCode, JsonValue } from '@somemore/protocol';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  idempotency_key_conflict: 409,
  idempotency_key_required: 400,
  illegal_state_transition: 409,
  rate_limited: 429,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  payment_provider_not_configured: 503,
  payment_failed: 402,
  webhook_signature_invalid: 400,
  reward_already_claimed: 409,
  anti_abuse_rejected: 403,
  content_invalid: 422,
  code_invalid: 400,
  code_already_redeemed: 409,
  code_revoked: 403,
  service_not_configured: 503,
  schema_version_unsupported: 400,
  raw_card_data_rejected: 400,
  internal_error: 500,
};

/**
 * The only error type the HTTP layer knows how to render. Anything else that
 * escapes a handler becomes a 500 with a request id and is logged in full.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: JsonValue | undefined;
  readonly headers: Record<string, string>;

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { details?: JsonValue; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export const badRequest = (m: string, details?: JsonValue) => new ApiError('bad_request', m, { details });
export const unauthorized = (m = 'Authentication required.') => new ApiError('unauthorized', m);
export const forbidden = (m = 'You do not have access to that.') => new ApiError('forbidden', m);
export const notFound = (m = 'Not found.') => new ApiError('not_found', m);
export const conflict = (m: string, details?: JsonValue) => new ApiError('conflict', m, { details });
export const preconditionFailed = (m: string, details?: JsonValue) =>
  new ApiError('precondition_failed', m, { details });
export const illegalTransition = (m: string, details?: JsonValue) =>
  new ApiError('illegal_state_transition', m, { details });
export function statusForCode(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}
