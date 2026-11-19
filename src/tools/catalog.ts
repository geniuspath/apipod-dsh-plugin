import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ApipodError } from '../client/errors.ts'
import { asArray, asRecord, asString, asStrings, truncate } from '../client/read.ts'
import { defined, renderJson, toolTimeoutMs } from './shared.ts'
import type { ToolDeps } from './shared.ts'

type Category = 'image' | 'video' | 'speech'

/** Host-facing categories over APIPod's finer classifications; LLM and music models have none. */
const CATEGORY_CLASSIFICATIONS: ReadonlyArray<readonly [Category, readonly string[]]> = [
  ['image', ['text_to_image', 'image_to_image']],
  ['video', ['text_to_video', 'image_to_video', 'video_to_video']],
  ['speech', ['audio']],
]

function categoryOf(classifications: readonly string[]): Category | undefined {
  return CATEGORY_CLASSIFICATIONS.find(([, names]) => names.some((name) => classifications.includes(name)))?.[0]
}

const MAX_DESCRIPTION = 200

export function listModelsTool({ client, settings }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_list_models',
    description: 'List the image, video and speech generation models APIPod offers. Call this before generating to pick a model id; the catalog changes as providers ship new models.',
    parameters: {
      category: { type: 'string', enum: ['image', 'video', 'speech'], description: 'Only this category. Omit for all generation models.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          models: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: 'Pass to apipod_generate_* and apipod_get_model_params' },
                name: { type: 'string', required: true },
                category: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                lifecycle: { type: 'string', required: true },
                series: { type: 'string' },
                description: { type: 'string' },
                input_types: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    timeoutMs: toolTimeoutMs(settings, 1),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Public catalog: no API key is sent.
      const { data } = await client.request({ method: 'GET', path: '/public/models?lang=en', auth: false, signal: exec.signal })
      const models = asArray(data).flatMap((item) => {
        const model = asRecord(item)
        const id = asString(model?.model_id)
        const category = categoryOf(asStrings(model?.classifications))
        const lifecycle = asString(model?.lifecycle) ?? 'ga'
        if (!model || !id || !category || lifecycle === 'offline') return []
        if (args.category && args.category !== category) return []
        const description = asString(model.description)
        const inputTypes = asStrings(model.input_types)
        return [defined({
          id,
          name: asString(model.display_name) ?? id,
          category,
          provider: asString(asRecord(model.provider)?.name) ?? asString(model.provider_id) ?? '',
          lifecycle,
          series: asString(asRecord(model.series)?.name),
          description: description ? truncate(description, MAX_DESCRIPTION) : undefined,
          input_types: inputTypes.length > 0 ? inputTypes : undefined,
        })]
      })
      models.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))
      return { models }
    },
  })
}

export function getModelParamsTool({ client, settings }: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'apipod_get_model_params',
    description: 'Read one model\'s request schema: accepted fields, enums and defaults. Use it to fill `extras` for apipod_generate_* and `dimensions` for apipod_estimate_cost.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id from apipod_list_models' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string', required: true },
          input_schema: { type: 'json', description: 'JSON Schema of the model\'s request body' },
          note: { type: 'string' },
        },
      },
      render: renderJson,
    },
    timeoutMs: toolTimeoutMs(settings, 1),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const model = args.model.trim()
      const fallback = { model, note: 'No published schema for this model; use the apipod_generate_* top-level fields only.' }
      let data: unknown
      try {
        ({ data } = await client.request({
          method: 'GET',
          path: `/public/schemas/${encodeURIComponent(model)}`,
          auth: false,
          signal: exec.signal,
          notFound: 'APIPOD_MODEL_NOT_FOUND',
        }))
      } catch (error) {
        if (error instanceof ApipodError && error.code === 'APIPOD_MODEL_NOT_FOUND') return fallback
        throw error
      }
      const input = asRecord(asRecord(asRecord(data)?.components)?.schemas)?.Input
      return input === undefined || input === null ? fallback : { model, input_schema: input as JsonValue }
    },
  })
}
