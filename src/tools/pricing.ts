import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ApipodError } from '../client/errors.ts'
import type { ApiClient } from '../client/http.ts'
import { asNumber, asRecord, asString } from '../client/read.ts'
import { defined, renderJson, toolTimeoutMs } from './shared.ts'
import type { ToolDeps } from './shared.ts'

interface Balance {
  readonly balance_usd: number
  readonly level: string
}

async function readBalance(client: ApiClient, signal: AbortSignal): Promise<Balance> {
  const { data } = await client.request({ method: 'GET', path: '/v1/account/balance', auth: true, signal })
  const balance = asNumber(asRecord(data)?.balance_usd)
  if (balance === undefined) throw new ApipodError('APIPod returned no balance.', 'APIPOD_BAD_RESPONSE')
  return { balance_usd: balance, level: asString(asRecord(data)?.level) ?? '' }
}

export function getBalanceTool({ client, settings }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_get_balance',
    description: 'Read the remaining balance, in USD, of the connected APIPod account. Generation tools deduct from it; a failed generation is refunded.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          balance_usd: { type: 'number', required: true },
          level: { type: 'string', required: true },
          topup_url: { type: 'string', description: 'Where the user can add funds. Share it only when the balance is insufficient or the user asks.' },
        },
      },
      render: renderJson,
    },
    timeoutMs: toolTimeoutMs(settings, 1),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const balance = await readBalance(client, exec.signal)
      return defined({ ...balance, topup_url: settings.topupUrl })
    },
  })
}

export function estimateCostTool({ client, settings }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_estimate_cost',
    description: 'Quote the price of a generation before running it, with the same pricing apipod_generate_* uses. Call it when the user asks about cost, gives a budget, or before an expensive video job. Spends nothing.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id from apipod_list_models' },
      dimensions: {
        type: 'object',
        additionalProperties: true,
        description: 'Pricing dimensions as strings, e.g. {"duration":"5","resolution":"1080p"} for video or {"n":"2","quality":"2K"} for image. Omit for the model\'s defaults.',
      },
      has_video_input: { type: 'boolean', description: 'Set when a reference video will be supplied; some models bill it extra' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          estimated_usd: { type: 'number', required: true },
          is_pre_deduct: { type: 'boolean', description: 'True when the model bills by actual usage: this amount is reserved and adjusted on completion' },
          balance_usd: { type: 'number', required: true },
          sufficient: { type: 'boolean', required: true, description: 'Whether the balance covers the estimate' },
        },
      },
      render: renderJson,
    },
    timeoutMs: toolTimeoutMs(settings, 2),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const model = args.model.trim()
      // The API takes string dimensions; numbers and booleans are accepted from the model and stringified.
      const dimensions = Object.fromEntries(
        Object.entries(args.dimensions ?? {})
          .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
          .map(([key, value]) => [key, String(value)]),
      )
      const { data } = await client.request({
        method: 'POST',
        path: '/v1/pricing/estimate',
        auth: true,
        signal: exec.signal,
        notFound: 'APIPOD_MODEL_NOT_FOUND',
        body: defined({
          model_id: model,
          dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
          has_video_material: args.has_video_input ? true : undefined,
        }),
      })
      const price = asNumber(asRecord(data)?.price)
      if (price === undefined) throw new ApipodError('APIPod returned no price.', 'APIPOD_BAD_RESPONSE')
      const { balance_usd } = await readBalance(client, exec.signal)
      return defined({
        model,
        estimated_usd: price,
        is_pre_deduct: asRecord(data)?.is_pre_deduct === true ? true : undefined,
        balance_usd,
        sufficient: balance_usd >= price,
      })
    },
  })
}
