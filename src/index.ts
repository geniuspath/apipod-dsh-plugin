import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-tools'
import { createApiClient } from './client/http.ts'
import type { FetchLike } from './client/http.ts'
import { Config, resolveSettings } from './config.ts'
import type { Settings } from './config.ts'
import { getModelParamsTool, listModelsTool } from './tools/catalog.ts'
import { checkJobTool, generateImageTool, generateVideoTool, SPENDING_TOOLS } from './tools/generation.ts'
import { estimateCostTool, getBalanceTool } from './tools/pricing.ts'
import type { ToolDeps } from './tools/shared.ts'

export const name = 'apipod'
export const inject = ['tools', 'credentials']
export { Config }

const TOOLS = [
  listModelsTool,
  getModelParamsTool,
  estimateCostTool,
  getBalanceTool,
  generateImageTool,
  generateVideoTool,
  checkJobTool,
] as const

/** Names of every tool this plugin registers. */
export const TOOL_NAMES: readonly string[] = [
  'apipod_list_models',
  'apipod_get_model_params',
  'apipod_estimate_cost',
  'apipod_get_balance',
  'apipod_generate_image',
  'apipod_generate_video',
  'apipod_check_job',
]

function needsApproval(settings: Settings, toolName: string): boolean {
  if (settings.approvalMode === 'never') return false
  return settings.approvalMode === 'always' ? TOOL_NAMES.includes(toolName) : SPENDING_TOOLS.includes(toolName)
}

/** Test seam: production always uses the platform fetch. */
export interface ApplyOptions {
  readonly fetch?: FetchLike
}

export function apply(ctx: Context, config: Config, options: ApplyOptions = {}): void {
  const settings = resolveSettings(config)
  const logger = ctx.logger('apipod')
  const deps: ToolDeps = {
    settings,
    client: createApiClient({
      settings,
      credentials: ctx.credentials,
      fetch: options.fetch ?? globalThis.fetch,
      logger: { debug: (message) => logger.debug(message) },
    }),
  }

  for (const tool of TOOLS) ctx.tools.register(tool(deps))

  // Only ever tightens: a call other policy already denied stays denied, and a
  // call other policy allowed still needs the user's yes before it spends money.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !needsApproval(settings, exec.name)) return decision
    const spends = SPENDING_TOOLS.includes(exec.name)
    return {
      kind: 'ask',
      reason: spends ? 'APIPod generation spends the account balance' : 'APIPod API call',
      displayReason: spends
        ? { en: 'This call spends your APIPod balance.', zh: '此调用会消耗你的 APIPod 余额。' }
        : { en: 'This call reaches the APIPod API.', zh: '此调用会访问 APIPod API。' },
    }
  })
}
