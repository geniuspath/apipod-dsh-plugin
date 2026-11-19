import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ApipodError } from '../client/errors.ts'
import { asArray, asNumber, asRecord, asString } from '../client/read.ts'
import { assertValid, checkMediaUrls, cleanExtras, defined, idempotencyKey, renderJson, toolTimeoutMs } from './shared.ts'
import type { ToolDeps } from './shared.ts'

/** Tools that spend the account balance. The approval policy keys on this list. */
export const SPENDING_TOOLS: readonly string[] = ['apipod_generate_image', 'apipod_generate_video']

type Kind = 'image' | 'video'

const JOB_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      job_id: { type: 'string', required: true, description: 'Pass to apipod_check_job with `kind` until status is completed or failed' },
      kind: { type: 'string', required: true, enum: ['image', 'video'] },
      status: { type: 'string', required: true },
      estimated_usd: { type: 'number', description: 'Amount reserved from the balance; adjusted to actual usage on completion' },
      replayed: { type: 'boolean', description: 'True when APIPod recognised a repeat of an earlier call and returned that job; nothing new was started or charged' },
    },
  },
  render: renderJson,
} as const

const EXTRAS = {
  type: 'object',
  additionalProperties: true,
  description: 'Model-specific parameters from apipod_get_model_params. Top-level fields win over the same key here.',
} as const

interface Submission {
  readonly kind: Kind
  readonly fields: Readonly<Record<string, unknown>>
  readonly extras: Readonly<Record<string, unknown>> | undefined
  readonly mediaUrls: readonly string[] | undefined
  readonly violations: readonly string[]
}

function parseCost(header: string | null): number | undefined {
  if (!header) return undefined
  const cost = Number(header.replace(/^\$/, ''))
  return Number.isFinite(cost) && cost > 0 ? cost : undefined
}

async function submit({ client, settings }: ToolDeps, exec: ToolRunContext, job: Submission) {
  const extras = cleanExtras(job.extras, settings.maxExtrasKeys)
  assertValid([...job.violations, ...checkMediaUrls('image_urls', job.mediaUrls), ...extras.violations])

  const body = { ...extras.extras, ...defined({ ...job.fields }) }
  const { data, headers } = await client.request({
    method: 'POST',
    path: `/v1/${job.kind}s/generations`,
    auth: true,
    signal: exec.signal,
    notFound: 'APIPOD_MODEL_NOT_FOUND',
    idempotencyKey: idempotencyKey(exec, body),
    body,
  })
  const jobId = asString(asRecord(data)?.task_id)
  if (!jobId) throw new ApipodError('APIPod accepted the request but returned no job id.', 'APIPOD_BAD_RESPONSE')
  return defined({
    job_id: jobId,
    kind: job.kind,
    status: asString(asRecord(data)?.status) ?? 'pending',
    estimated_usd: parseCost(headers.get('x-request-cost')),
    replayed: headers.get('x-idempotent-replay') === 'true' ? true : undefined,
  })
}

export function generateImageTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_generate_image',
    description: 'Generate an image from a prompt, or edit reference images, on APIPod. SPENDS the account balance (quote with apipod_estimate_cost). Returns a job_id at once; poll apipod_check_job for the result URLs. Never call it twice for one request.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id from apipod_list_models (category image)' },
      prompt: { type: 'string', required: true, description: 'What to generate, or how to edit the reference images' },
      image_urls: { type: 'array', items: { type: 'string' }, description: 'Reference images: public https URLs or data:image/...;base64 payloads. Local file paths are not accepted.' },
      aspect_ratio: { type: 'string', description: 'e.g. 1:1, 16:9, 9:16, 3:4, 4:3' },
      n: { type: 'integer', description: 'Number of images, default 1' },
      extras: EXTRAS,
    },
    output: JOB_OUTPUT,
    timeoutMs: toolTimeoutMs(deps.settings, 1),
    execute(args, exec) {
      return submit(deps, exec, {
        kind: 'image',
        fields: { model: args.model.trim(), prompt: args.prompt, image_urls: args.image_urls, aspect_ratio: args.aspect_ratio, n: args.n },
        extras: args.extras,
        mediaUrls: args.image_urls,
        violations: [
          ...(args.prompt.trim() === '' ? ['prompt: must not be empty'] : []),
          ...(args.n !== undefined && args.n < 1 ? ['n: must be at least 1'] : []),
        ],
      })
    },
  })
}

export function generateVideoTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_generate_video',
    description: 'Generate a video from a prompt and/or reference images on APIPod. SPENDS the account balance and video is the most expensive category: quote with apipod_estimate_cost first unless the user confirmed a budget. Returns a job_id at once; poll apipod_check_job every 5-10 s (videos take 1-5 minutes). Never call it twice for one request.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id from apipod_list_models (category video)' },
      prompt: { type: 'string', description: 'Scene description. Optional for pure image-to-video on some models' },
      image_urls: { type: 'array', items: { type: 'string' }, description: 'First frame, first+last frame, or reference images: public https URLs or data:...;base64 payloads. Local file paths are not accepted.' },
      duration: { type: 'integer', description: 'Seconds; allowed values come from apipod_get_model_params' },
      aspect_ratio: { type: 'string', description: 'e.g. 16:9, 9:16, 1:1' },
      resolution: { type: 'string', description: 'e.g. 480p, 720p, 1080p' },
      extras: EXTRAS,
    },
    output: JOB_OUTPUT,
    timeoutMs: toolTimeoutMs(deps.settings, 1),
    execute(args, exec) {
      return submit(deps, exec, {
        kind: 'video',
        fields: {
          model: args.model.trim(),
          prompt: args.prompt,
          image_urls: args.image_urls,
          duration: args.duration,
          aspect_ratio: args.aspect_ratio,
          resolution: args.resolution,
        },
        extras: args.extras,
        mediaUrls: args.image_urls,
        violations: args.duration !== undefined && args.duration < 1 ? ['duration: must be at least 1'] : [],
      })
    },
  })
}

const JOB_ID = /^[A-Za-z0-9_.:-]{1,128}$/

function resultUrls(result: unknown): { url: string }[] {
  return asArray(result).flatMap((item) => {
    const url = asString(item) ?? asString(asRecord(item)?.url)
    return url ? [{ url }] : []
  })
}

export function checkJobTool({ client, settings }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_check_job',
    description: 'Read the state of a job started by apipod_generate_image or apipod_generate_video. Keep polling (every 5-10 s for video) until status is completed, failed or cancelled. A failed job is refunded automatically. Spends nothing.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'job_id an apipod_generate_* call returned' },
      kind: { type: 'string', required: true, enum: ['image', 'video'], description: 'kind the same call returned' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job_id: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['image', 'video'] },
          status: { type: 'string', required: true, description: 'pending, processing, completed, failed or cancelled' },
          progress: { type: 'number', description: '0-100' },
          results: {
            type: 'array',
            description: 'URLs of the generated media; present when completed',
            items: { type: 'object', additionalProperties: false, properties: { url: { type: 'string', required: true } } },
          },
          text: { type: 'string' },
          error_code: { type: 'string' },
          error_message: { type: 'string' },
          cost_usd: { type: 'number', description: 'Final charge; present when completed' },
          completed_at: { type: 'number', description: 'Unix seconds' },
        },
      },
      render: renderJson,
    },
    timeoutMs: toolTimeoutMs(settings, 1),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const jobId = args.job_id.trim()
      assertValid(JOB_ID.test(jobId) ? [] : ['job_id: not a valid job id'])
      const { data } = await client.request({
        method: 'GET',
        path: `/v1/${args.kind}s/status/${encodeURIComponent(jobId)}`,
        auth: true,
        signal: exec.signal,
        notFound: 'APIPOD_JOB_NOT_FOUND',
      })
      const job = asRecord(data)
      const status = asString(job?.status)
      if (!job || !status) throw new ApipodError('APIPod returned no job status.', 'APIPOD_BAD_RESPONSE')
      const results = resultUrls(job.result)
      return defined({
        job_id: jobId,
        kind: args.kind,
        status,
        progress: asNumber(job.progress),
        results: results.length > 0 ? results : undefined,
        text: asString(job.text),
        error_code: asString(job.error_code),
        // The image endpoint reports `error_message`, the video endpoint `error`.
        error_message: asString(job.error_message) ?? asString(job.error),
        cost_usd: asNumber(asRecord(job.usage)?.cost),
        completed_at: asNumber(job.completed_at),
      })
    },
  })
}
