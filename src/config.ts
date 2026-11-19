import Schema from '@deepseek-ai/schemastery'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'

export type ApprovalMode = 'generation' | 'always' | 'never'

export interface Config {
  apiKeyRef: string
  baseUrl: string
  allowInsecureBaseUrl: boolean
  approvalMode: ApprovalMode
  requestTimeoutMs: number
  maxExtrasKeys: number
  topupUrl: string
}

export const Config: Schema<Config> = Schema.object({
  apiKeyRef: Schema.string().default('APIPOD_API_KEY')
    .description('Name of the credential reference that holds the APIPod API key. A name, never the key itself.'),
  baseUrl: Schema.string().default('https://api.apipod.ai')
    .description('APIPod API origin. Must be https.'),
  allowInsecureBaseUrl: Schema.boolean().default(false)
    .description('Allow an http:// baseUrl, and only for a loopback host. For local development.'),
  approvalMode: Schema.union(['generation', 'always', 'never']).default('generation')
    .description('Which tools ask the user first: generation (tools that spend balance), always, or never.'),
  requestTimeoutMs: Schema.number().min(1000).max(120000).step(1).default(30000)
    .description('Deadline for one HTTP request to APIPod.'),
  maxExtrasKeys: Schema.number().min(0).max(64).step(1).default(32)
    .description('Most model-specific keys accepted in a generation call\'s extras.'),
  topupUrl: Schema.string().default('https://www.apipod.ai/console/billing')
    .description('Billing page returned with the balance. Empty to omit it.'),
}) as Schema<Config>

/** Validated, immutable view of Config that the rest of the plugin reads. */
export interface Settings {
  readonly apiKeyRef: string
  readonly baseUrl: string
  readonly approvalMode: ApprovalMode
  readonly requestTimeoutMs: number
  readonly maxExtrasKeys: number
  readonly topupUrl: string | undefined
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseHttpUrl(value: string, field: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`apipod: ${field} is not a valid URL`)
  }
  if (url.username || url.password) throw new TypeError(`apipod: ${field} must not contain credentials`)
  return url
}

/**
 * Check the constraints the schema cannot express and freeze the result.
 * Throwing here fails the plugin load, so a bad deployment never reaches a request.
 */
export function resolveSettings(config: Config): Settings {
  if (!isCredentialRefName(config.apiKeyRef)) {
    throw new TypeError('apipod: apiKeyRef must be a credential reference name such as APIPOD_API_KEY, not a key')
  }

  const base = parseHttpUrl(config.baseUrl, 'baseUrl')
  if (base.search || base.hash) throw new TypeError('apipod: baseUrl must not contain a query or fragment')
  const insecureAllowed = config.allowInsecureBaseUrl && base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname)
  if (base.protocol !== 'https:' && !insecureAllowed) {
    throw new TypeError('apipod: baseUrl must use https (http is accepted only for a loopback host with allowInsecureBaseUrl)')
  }

  let topupUrl: string | undefined
  if (config.topupUrl.trim() !== '') {
    const topup = parseHttpUrl(config.topupUrl, 'topupUrl')
    if (topup.protocol !== 'https:') throw new TypeError('apipod: topupUrl must use https')
    topupUrl = topup.href
  }

  return Object.freeze({
    apiKeyRef: config.apiKeyRef,
    baseUrl: base.origin + base.pathname.replace(/\/+$/, ''),
    approvalMode: config.approvalMode,
    requestTimeoutMs: config.requestTimeoutMs,
    maxExtrasKeys: config.maxExtrasKeys,
    topupUrl,
  })
}
