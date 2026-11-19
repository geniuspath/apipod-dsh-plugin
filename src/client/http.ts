import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Settings } from '../config.ts'
import { ApipodError, errorFromResponse, machineCodeOf } from './errors.ts'
import type { ApipodErrorCode } from './errors.ts'

export type FetchLike = typeof globalThis.fetch

export interface ApiLogger {
  debug(message: string): void
}

export interface ApiRequest {
  readonly method: 'GET' | 'POST'
  /** Path under baseUrl, built by this plugin. Encode any dynamic segment. */
  readonly path: string
  /** Send the API key. Public catalog endpoints never receive it. */
  readonly auth: boolean
  readonly signal: AbortSignal
  readonly body?: Readonly<Record<string, unknown>>
  /** Makes a POST safe to repeat: APIPod replays the first response instead of charging twice. */
  readonly idempotencyKey?: string
  /** Code a 404 maps to for this endpoint. */
  readonly notFound?: ApipodErrorCode
}

export interface ApiResponse {
  /** The `data` member of APIPod's envelope, or the whole body when there is none. */
  readonly data: unknown
  readonly headers: Headers
}

export interface ApiClient {
  request(req: ApiRequest): Promise<ApiResponse>
}

export interface ApiClientDeps {
  readonly settings: Settings
  readonly credentials: Pick<CredentialProvider, 'resolve'>
  readonly fetch: FetchLike
  readonly logger?: ApiLogger
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 500
const RETRY_STATUSES = new Set([502, 503, 504])
/** APIPod is still creating the response for this idempotency key; the same key returns it shortly. */
const IN_PROGRESS = 'idempotency_in_progress'
/** Printable ASCII only: a key with a space or line break could otherwise smuggle a header. */
const KEY_PATTERN = /^[\x21-\x7e]{8,512}$/

async function resolveKey(deps: ApiClientDeps): Promise<string> {
  // Resolved on every request and never stored: a rotated key applies to the next call.
  const resolved = await deps.credentials.resolve(credentialRef(deps.settings.apiKeyRef))
  const key = resolved?.value.trim()
  if (!key) {
    throw new ApipodError(
      `No APIPod API key is configured. Ask the user to set the ${deps.settings.apiKeyRef} credential.`,
      'APIPOD_MISSING_CREDENTIAL',
    )
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApipodError(
      `The ${deps.settings.apiKeyRef} credential is not a valid APIPod API key.`,
      'APIPOD_INVALID_CREDENTIAL',
    )
  }
  return key
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new ApipodError('APIPod returned a response that is too large.', 'APIPOD_BAD_RESPONSE', { status: response.status })
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type Attempt =
  | { readonly kind: 'done'; readonly response: ApiResponse }
  | { readonly kind: 'retry'; readonly error: ApipodError }

async function attempt(deps: ApiClientDeps, req: ApiRequest, key: string | undefined): Promise<Attempt> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'apipod-dsh-plugin' }
  if (key) headers.authorization = `Bearer ${key}`
  if (req.body) headers['content-type'] = 'application/json'
  if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey

  const timeout = AbortSignal.timeout(deps.settings.requestTimeoutMs)
  let response: Response
  let text: string
  try {
    response = await deps.fetch(deps.settings.baseUrl + req.path, {
      method: req.method,
      headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.any([req.signal, timeout]),
      // A redirect could carry the Authorization header to another origin.
      redirect: 'error',
    })
    text = await readCapped(response)
  } catch (error) {
    // Keep the caller's own abort reason so the harness records a cancellation, not a failure.
    if (req.signal.aborted) throw req.signal.reason
    if (error instanceof ApipodError) throw error
    if (timeout.aborted) {
      return { kind: 'retry', error: new ApipodError('APIPod did not respond in time.', 'APIPOD_TIMEOUT') }
    }
    return { kind: 'retry', error: new ApipodError('Could not reach APIPod.', 'APIPOD_NETWORK') }
  }

  deps.logger?.debug(`${req.method} ${req.path} -> ${response.status}`)
  const body = parseJson(text)

  if (!response.ok) {
    const error = errorFromResponse(response.status, body, req.notFound ?? 'APIPOD_NOT_FOUND', key)
    if (RETRY_STATUSES.has(response.status) || machineCodeOf(body) === IN_PROGRESS) return { kind: 'retry', error }
    throw error
  }
  if (typeof body !== 'object' || body === null) {
    throw new ApipodError('APIPod returned a response that is not JSON.', 'APIPOD_BAD_RESPONSE', { status: response.status })
  }
  const data = 'data' in body ? (body as { data: unknown }).data : body
  return { kind: 'done', response: { data, headers: response.headers } }
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  return {
    async request(req) {
      const key = req.auth ? await resolveKey(deps) : undefined
      // Only a request APIPod can safely see more than once is repeated.
      const attempts = req.method === 'GET' || req.idempotencyKey !== undefined ? MAX_ATTEMPTS : 1

      for (let tried = 1; ; tried++) {
        const result = await attempt(deps, req, key)
        if (result.kind === 'done') return result.response
        if (tried >= attempts) throw result.error
        await delay(RETRY_DELAY_MS * tried, req.signal)
      }
    },
  }
}
