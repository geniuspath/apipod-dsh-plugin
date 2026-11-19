import { Context, Service } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'

export const TEST_KEY = 'sk-test-0123456789abcdef'

export interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export type Responder = (request: Recorded, index: number) => Response | Promise<Response>

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers: { 'content-type': 'application/json', ...init.headers } })
}

export const ok = (data: unknown, headers?: Record<string, string>) => json({ code: 200, message: 'success', data }, { headers })
export const fail = (status: number, message: string, code?: string) => json({ error: { message, type: 'error', code } }, { status })

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface HarnessOptions {
  readonly config?: Record<string, unknown>
  readonly key?: string | undefined
  readonly approval?: ApprovalOutcome
  readonly respond?: Responder
}

export interface Harness {
  readonly ctx: Context
  readonly requests: Recorded[]
  readonly approvals: string[]
  call(name: string, args: unknown, options?: { id?: string; signal?: AbortSignal }): Promise<ToolExecutionResult>
  unload(): Promise<void>
}

export async function boot(options: HarnessOptions = {}): Promise<Harness> {
  const requests: Recorded[] = []
  const approvals: string[] = []
  const key = 'key' in options ? options.key : TEST_KEY

  class Credentials extends CredentialProvider {
    async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
      return key ? { value: key, source: 'test' } : undefined
    }
    async describe(): Promise<CredentialInfo> { return { configured: Boolean(key), writable: false } }
    async set(): Promise<void> {}
    async unset(): Promise<void> {}
    async readRecord(): Promise<CredentialRecord | undefined> { return undefined }
    async describeRecord(): Promise<CredentialRecordInfo> { return { configured: false, writable: false } }
    async listRecords(): Promise<readonly CredentialRecordEntry[]> { return [] }
    async modifyRecord(): Promise<CredentialRecord | undefined> { return undefined }
    async deleteRecord(): Promise<void> {}
  }

  class Approval extends Service {
    constructor(ctx: Context) { super(ctx, 'approval') }
    async request(req: { toolName: string }): Promise<ApprovalOutcome> {
      approvals.push(req.toolName)
      return options.approval ?? 'allowed-once'
    }
  }

  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    requests.push(recorded)
    init?.signal?.throwIfAborted()
    const respond = options.respond ?? (() => ok({}))
    return respond(recorded, requests.length - 1)
  }) as typeof globalThis.fetch

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  await ctx.plugin(nativeExecutor)
  await ctx.plugin(Credentials)
  await ctx.plugin(Approval)
  const fiber = await ctx.plugin({
    name: plugin.name,
    inject: plugin.inject,
    Config: plugin.Config,
    apply: (c: Context, config: plugin.Config) => plugin.apply(c, config, { fetch: fetchStub }),
  }, (options.config ?? {}) as never)

  return {
    ctx,
    requests,
    approvals,
    async call(name, args, callOptions = {}) {
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: (callOptions.id ?? 'call_1') as never, name, arguments: JSON.stringify(args) }],
        signal: callOptions.signal ?? new AbortController().signal,
        // The pipeline only reads the agent's identity; a full Agent needs a running session.
        agent: { id: 'session_1' } as never,
      })
      return batch.results[0]!.result
    },
    async unload() { await fiber.dispose() },
  }
}

/** Everything a failed or successful result exposes, for leak checks. */
export function exposed(result: ToolExecutionResult): string {
  return JSON.stringify(result)
}
