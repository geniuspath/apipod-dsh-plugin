import { HarnessError } from '@deepseek-ai/dsh-error'

/** Stable codes callers and policies can branch on. */
export type ApipodErrorCode =
  | 'APIPOD_MISSING_CREDENTIAL'
  | 'APIPOD_INVALID_CREDENTIAL'
  | 'APIPOD_UNAUTHORIZED'
  | 'APIPOD_FORBIDDEN'
  | 'APIPOD_INSUFFICIENT_QUOTA'
  | 'APIPOD_RATE_LIMITED'
  | 'APIPOD_MODEL_NOT_FOUND'
  | 'APIPOD_JOB_NOT_FOUND'
  | 'APIPOD_NOT_FOUND'
  | 'APIPOD_INVALID_ARGS'
  | 'APIPOD_INVALID_REQUEST'
  | 'APIPOD_DUPLICATE_REQUEST'
  | 'APIPOD_TIMEOUT'
  | 'APIPOD_NETWORK'
  | 'APIPOD_BAD_RESPONSE'
  | 'APIPOD_UPSTREAM'

export class ApipodError extends HarnessError {
  /** HTTP status from APIPod, when the failure came from a response. */
  readonly status: number | undefined

  constructor(message: string, code: ApipodErrorCode, options: { status?: number; cause?: unknown } = {}) {
    super(message, code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApipodError'
    this.status = options.status
  }
}

const MAX_MESSAGE_LENGTH = 300

/** Make server-supplied text safe to show: no secret, no control characters, bounded. */
export function scrub(text: string, secret?: string): string {
  let out = secret ? text.split(secret).join('[redacted]') : text
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH)}…` : out
}

const MACHINE_CODES: Readonly<Record<string, ApipodErrorCode>> = {
  invalid_api_key: 'APIPOD_UNAUTHORIZED',
  insufficient_quota: 'APIPOD_INSUFFICIENT_QUOTA',
  rate_limit_exceeded: 'APIPOD_RATE_LIMITED',
  model_not_available: 'APIPOD_MODEL_NOT_FOUND',
  idempotency_conflict: 'APIPOD_DUPLICATE_REQUEST',
  idempotency_in_progress: 'APIPOD_DUPLICATE_REQUEST',
}

function codeForStatus(status: number, notFound: ApipodErrorCode): ApipodErrorCode {
  if (status === 401) return 'APIPOD_UNAUTHORIZED'
  if (status === 402) return 'APIPOD_INSUFFICIENT_QUOTA'
  if (status === 403) return 'APIPOD_FORBIDDEN'
  if (status === 404) return notFound
  if (status === 409) return 'APIPOD_DUPLICATE_REQUEST'
  if (status === 429) return 'APIPOD_RATE_LIMITED'
  if (status >= 400 && status < 500) return 'APIPOD_INVALID_REQUEST'
  return 'APIPOD_UPSTREAM'
}

const HINTS: Partial<Record<ApipodErrorCode, string>> = {
  APIPOD_UNAUTHORIZED: 'The APIPod API key was rejected. Ask the user to check the configured credential.',
  APIPOD_INSUFFICIENT_QUOTA: 'The APIPod balance is too low for this request. Ask the user to add funds.',
  APIPOD_MODEL_NOT_FOUND: 'Unknown or unavailable model. Call apipod_list_models for valid ids.',
  APIPOD_JOB_NOT_FOUND: 'No such job for this account. Use the job_id an apipod_generate_* call returned.',
  APIPOD_DUPLICATE_REQUEST: 'APIPod is already handling this same call. Do not submit it again.',
}

interface ErrorBody {
  message: string | undefined
  machineCode: string | undefined
}

function readErrorBody(body: unknown): ErrorBody {
  if (typeof body !== 'object' || body === null) return { message: undefined, machineCode: undefined }
  const root = body as Record<string, unknown>
  const nested = typeof root.error === 'object' && root.error !== null ? root.error as Record<string, unknown> : root
  const message = typeof nested.message === 'string' ? nested.message : typeof root.message === 'string' ? root.message : undefined
  const machineCode = typeof nested.code === 'string' ? nested.code : undefined
  return { message, machineCode }
}

/** APIPod's machine-readable error code, when the body carries one. */
export function machineCodeOf(body: unknown): string | undefined {
  return readErrorBody(body).machineCode
}

/** Turn a non-2xx APIPod response into one ApipodError with a stable code. */
export function errorFromResponse(status: number, body: unknown, notFound: ApipodErrorCode, secret?: string): ApipodError {
  const { message, machineCode } = readErrorBody(body)
  const code = (machineCode && MACHINE_CODES[machineCode]) || codeForStatus(status, notFound)
  const detail = message ? scrub(message, secret) : `HTTP ${status}`
  const hint = HINTS[code]
  return new ApipodError(hint ? `${hint} (${detail})` : `APIPod request failed: ${detail}`, code, { status })
}
