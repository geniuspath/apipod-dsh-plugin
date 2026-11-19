import { createHash, randomUUID } from 'node:crypto'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApiClient } from '../client/http.ts'
import type { Settings } from '../config.ts'

export interface ToolDeps {
  readonly client: ApiClient
  readonly settings: Settings
}

/** Model-facing content for a canonical value: the JSON itself, nothing to parse out of prose. */
export function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Budget for a tool that makes `requests` calls, each of which may be attempted up to three times. */
export function toolTimeoutMs(settings: Settings, requests: number): number {
  return requests * (settings.requestTimeoutMs * 3 + 2000) + 2000
}

/** Stands in for the session when a call has no agent, so two such processes never share a key. */
const PROCESS_NONCE = randomUUID()

/**
 * Idempotency key for one tool call: the call's identity plus the exact request body.
 * A repeat of the same call reuses it, so APIPod replays the first response instead of
 * creating (and charging for) a second job. Hashed to stay opaque and bounded.
 */
export function idempotencyKey(
  exec: Pick<ToolRunContext, 'agent' | 'rootCallId' | 'callId'>,
  body: Readonly<Record<string, unknown>>,
): string {
  const identity = [exec.agent?.id ?? PROCESS_NONCE, exec.rootCallId, exec.callId, JSON.stringify(body)].join('\n')
  return `dsh-${createHash('sha256').update(identity).digest('hex')}`
}

const MAX_MEDIA_URLS = 16
const MAX_URL_LENGTH = 2048
const DATA_URI = /^data:(image|video|audio)\/[a-z0-9.+-]+;base64,/i

function isHttpsUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Reference media must be a public https URL or inline base64; a local path or other scheme is refused. */
export function checkMediaUrls(field: string, urls: readonly string[] | undefined): string[] {
  if (!urls) return []
  const violations: string[] = []
  if (urls.length > MAX_MEDIA_URLS) violations.push(`${field}: at most ${MAX_MEDIA_URLS} items`)
  urls.forEach((url, index) => {
    if (!isHttpsUrl(url) && !DATA_URI.test(url)) {
      violations.push(`${field}[${index}]: must be an https URL or a data:<image|video|audio>/...;base64 payload`)
    }
  })
  return violations
}

/** Keys the model may not set: they redirect results, impersonate, or are set by the tool itself. */
const DENIED_EXTRAS = new Set(['callback_url', 'user', 'model'])

export interface CleanExtras {
  readonly extras: Readonly<Record<string, unknown>>
  readonly violations: readonly string[]
}

export function cleanExtras(extras: Readonly<Record<string, unknown>> | undefined, maxKeys: number): CleanExtras {
  if (!extras) return { extras: {}, violations: [] }
  const kept = Object.fromEntries(Object.entries(extras).filter(([key]) => !DENIED_EXTRAS.has(key)))
  const count = Object.keys(kept).length
  return {
    extras: kept,
    violations: count > maxKeys ? [`extras: at most ${maxKeys} keys, got ${count}`] : [],
  }
}

export function assertValid(violations: readonly string[]): void {
  if (violations.length > 0) throw new ToolArgsError([...violations])
}

/** Drop absent members so the canonical value never carries `undefined`. */
export function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)) as T
}
