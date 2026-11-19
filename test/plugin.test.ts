import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOOL_NAMES } from '../src/index.ts'
import { boot, exposed, fail, ok, TEST_KEY } from './harness.ts'
import type { Recorded } from './harness.ts'

const value = (result: { value?: unknown }) => result.value as Record<string, any>
const errorCode = (result: { error?: { info?: { code: string } } }) => result.error?.info?.code

test('registers exactly the seven tools and removes them on unload', async () => {
  const h = await boot()
  const names = () => h.ctx.tools.schemas().map((schema) => schema.name).sort()
  assert.deepEqual(names(), [...TOOL_NAMES].sort())
  await h.unload()
  assert.deepEqual(names(), [])
})

test('a bad baseUrl fails the plugin load', async () => {
  await assert.rejects(boot({ config: { baseUrl: 'http://api.apipod.ai' } }), /https/)
})

test('get_balance sends the key as a Bearer header and never returns it', async () => {
  const h = await boot({ respond: () => ok({ object: 'account_balance', balance_usd: 12.5, level: 'L1' }) })
  const result = await h.call('apipod_get_balance', {})
  assert.equal(result.isError, false)
  assert.deepEqual(value(result), { balance_usd: 12.5, level: 'L1', topup_url: 'https://www.apipod.ai/console/billing' })
  assert.equal(h.requests[0]!.url, 'https://api.apipod.ai/v1/account/balance')
  assert.equal(h.requests[0]!.headers.authorization, `Bearer ${TEST_KEY}`)
  assert.equal(h.approvals.length, 0)
  assert.ok(!exposed(result).includes(TEST_KEY))
})

test('list_models sends no credential, filters by category and hides offline and LLM models', async () => {
  const models = [
    { model_id: 'img-1', display_name: 'Image One', classifications: ['text_to_image'], lifecycle: 'ga', provider: { name: 'Acme' } },
    { model_id: 'vid-1', display_name: 'Video One', classifications: ['image_to_video'], lifecycle: 'beta', provider_id: 'acme' },
    { model_id: 'img-off', classifications: ['text_to_image'], lifecycle: 'offline' },
    { model_id: 'chat-1', classifications: ['llm'], lifecycle: 'ga' },
  ]
  const h = await boot({ key: undefined, respond: () => ok(models) })
  const all = await h.call('apipod_list_models', {})
  assert.deepEqual(value(all).models.map((m: any) => m.id), ['img-1', 'vid-1'])
  assert.equal(h.requests[0]!.headers.authorization, undefined)
  const images = await h.call('apipod_list_models', { category: 'image' })
  assert.deepEqual(value(images).models, [{ id: 'img-1', name: 'Image One', category: 'image', provider: 'Acme', lifecycle: 'ga' }])
})

test('a missing key fails with a stable code before any request is made', async () => {
  const h = await boot({ key: undefined })
  const result = await h.call('apipod_get_balance', {})
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), 'APIPOD_MISSING_CREDENTIAL')
  assert.equal(h.requests.length, 0)
})

test('a key that could smuggle a header is refused and not sent', async () => {
  const h = await boot({ key: 'sk-test-abcdefgh\r\nx-evil: 1' })
  const result = await h.call('apipod_get_balance', {})
  assert.equal(errorCode(result), 'APIPOD_INVALID_CREDENTIAL')
  assert.equal(h.requests.length, 0)
})

test('generate_image asks the user first; a rejection sends nothing', async () => {
  const h = await boot({ approval: 'rejected' })
  const result = await h.call('apipod_generate_image', { model: 'img-1', prompt: 'a cat' })
  assert.equal(result.isError, true)
  assert.deepEqual(h.approvals, ['apipod_generate_image'])
  assert.equal(h.requests.length, 0)
})

test('approved generate_image posts once, with an idempotency key, without model-chosen callback or user', async () => {
  const h = await boot({ respond: () => ok({ task_id: 'task_abc' }) })
  const result = await h.call('apipod_generate_image', {
    model: 'img-1', prompt: 'a cat', n: 2,
    extras: { quality: '2K', callback_url: 'https://attacker.example/hook', user: 'someone-else', model: 'other-model' },
  })
  assert.equal(result.isError, false)
  assert.deepEqual(value(result), { job_id: 'task_abc', kind: 'image', status: 'pending' })
  assert.equal(h.requests.length, 1)
  const request = h.requests[0]!
  assert.equal(request.url, 'https://api.apipod.ai/v1/images/generations')
  assert.deepEqual(request.body, { quality: '2K', model: 'img-1', prompt: 'a cat', n: 2 })
  assert.match(request.headers['idempotency-key']!, /^dsh-[0-9a-f]{64}$/)
})

test('the same call id and body reuse one idempotency key; a different call or body does not', async () => {
  const h = await boot({ respond: () => ok({ task_id: 't' }) })
  const args = { model: 'vid-1', prompt: 'waves', duration: 5 }
  await h.call('apipod_generate_video', args, { id: 'call_a' })
  await h.call('apipod_generate_video', args, { id: 'call_a' })
  await h.call('apipod_generate_video', args, { id: 'call_b' })
  await h.call('apipod_generate_video', { ...args, duration: 10 }, { id: 'call_a' })
  const keys = h.requests.map((request) => request.headers['idempotency-key'])
  assert.equal(keys[0], keys[1])
  assert.notEqual(keys[0], keys[2])
  assert.notEqual(keys[0], keys[3])
})

test('a 503 on submit is retried with the same idempotency key and reports the replay', async () => {
  const h = await boot({
    respond: (_request, index) => index === 0
      ? fail(503, 'unavailable')
      : ok({ task_id: 'task_v', status: 'pending' }, { 'x-request-cost': '$0.450000', 'x-idempotent-replay': 'true' }),
  })
  const result = await h.call('apipod_generate_video', { model: 'vid-1', prompt: 'waves' })
  assert.deepEqual(value(result), { job_id: 'task_v', kind: 'video', status: 'pending', estimated_usd: 0.45, replayed: true })
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[0]!.headers['idempotency-key'], h.requests[1]!.headers['idempotency-key'])
})

test('local paths and non-https reference media are refused before any request', async () => {
  const h = await boot()
  for (const url of ['/etc/passwd', 'file:///etc/passwd', 'http://example.com/a.png', 'data:text/html;base64,AAAA']) {
    const result = await h.call('apipod_generate_image', { model: 'img-1', prompt: 'x', image_urls: [url] })
    assert.equal(result.isError, true, url)
  }
  assert.equal(h.requests.length, 0)
})

test('too many extras keys are refused', async () => {
  const h = await boot({ config: { maxExtrasKeys: 2 } })
  const result = await h.call('apipod_generate_image', { model: 'img-1', prompt: 'x', extras: { a: 1, b: 2, c: 3 } })
  assert.equal(result.isError, true)
  assert.equal(h.requests.length, 0)
})

test('server errors map to stable codes and never echo the key', async () => {
  const cases: Array<[number, string | undefined, string]> = [
    [401, 'invalid_api_key', 'APIPOD_UNAUTHORIZED'],
    [402, 'insufficient_quota', 'APIPOD_INSUFFICIENT_QUOTA'],
    [404, 'model_not_available', 'APIPOD_MODEL_NOT_FOUND'],
    [409, 'idempotency_conflict', 'APIPOD_DUPLICATE_REQUEST'],
    [429, 'rate_limit_exceeded', 'APIPOD_RATE_LIMITED'],
    [400, undefined, 'APIPOD_INVALID_REQUEST'],
  ]
  for (const [status, machine, expected] of cases) {
    const h = await boot({ respond: () => fail(status, `bad request using ${TEST_KEY}`, machine) })
    const result = await h.call('apipod_generate_image', { model: 'img-1', prompt: 'x' })
    assert.equal(errorCode(result), expected, String(status))
    assert.ok(!exposed(result).includes(TEST_KEY), `key leaked for ${status}`)
    assert.equal(h.requests.length, 1, `no retry for ${status}`)
  }
})

test('check_job reads video and image shapes and encodes the id into the path', async () => {
  const video = await boot({
    respond: () => ok({ task_id: 'v1', status: 'failed', error: 'content policy' }),
  })
  const failed = await video.call('apipod_check_job', { job_id: 'v1', kind: 'video' })
  assert.deepEqual(value(failed), { job_id: 'v1', kind: 'video', status: 'failed', error_message: 'content policy' })
  assert.equal(video.requests[0]!.url, 'https://api.apipod.ai/v1/videos/status/v1')
  assert.equal(video.approvals.length, 0)

  const image = await boot({
    respond: () => ok({ task_id: 'i1', status: 'completed', result: ['https://cdn.example/a.png', { url: 'https://cdn.example/b.png', z_index: 1 }], usage: { cost: 0.04 }, completed_at: 1700000000 }),
  })
  const done = await image.call('apipod_check_job', { job_id: 'i1', kind: 'image' })
  assert.deepEqual(value(done), {
    job_id: 'i1', kind: 'image', status: 'completed',
    results: [{ url: 'https://cdn.example/a.png' }, { url: 'https://cdn.example/b.png' }],
    cost_usd: 0.04, completed_at: 1700000000,
  })

  const traversal = await boot()
  const bad = await traversal.call('apipod_check_job', { job_id: '../../account/balance', kind: 'image' })
  assert.equal(bad.isError, true)
  assert.equal(traversal.requests.length, 0)
})

test('estimate_cost quotes and compares against the balance without asking', async () => {
  const h = await boot({
    respond: (request: Recorded) => request.url.endsWith('/v1/pricing/estimate')
      ? ok({ price: 0.9, currency: 'USD', is_pre_deduct: true })
      : ok({ balance_usd: 0.5, level: 'L0' }),
  })
  const result = await h.call('apipod_estimate_cost', { model: 'vid-1', dimensions: { duration: 10, resolution: '1080p' }, has_video_input: true })
  assert.deepEqual(value(result), { model: 'vid-1', estimated_usd: 0.9, is_pre_deduct: true, balance_usd: 0.5, sufficient: false })
  assert.deepEqual(h.requests[0]!.body, { model_id: 'vid-1', dimensions: { duration: '10', resolution: '1080p' }, has_video_material: true })
  assert.equal(h.approvals.length, 0)
})

test('get_model_params returns the Input schema, or a note when none is published', async () => {
  const found = await boot({ key: undefined, respond: () => ok({ components: { schemas: { Input: { type: 'object', required: ['prompt'] } } } }) })
  assert.deepEqual(value(await found.call('apipod_get_model_params', { model: 'a/b' })), { model: 'a/b', input_schema: { type: 'object', required: ['prompt'] } })
  assert.equal(found.requests[0]!.url, 'https://api.apipod.ai/public/schemas/a%2Fb')

  const missing = await boot({ key: undefined, respond: () => fail(404, 'Schema not found') })
  const result = await missing.call('apipod_get_model_params', { model: 'nope' })
  assert.equal(result.isError, false)
  assert.match(value(result).note, /No published schema/)
})

test('approvalMode always gates read tools; never gates nothing', async () => {
  const always = await boot({ config: { approvalMode: 'always' }, respond: () => ok({ balance_usd: 1, level: 'L0' }) })
  await always.call('apipod_get_balance', {})
  assert.deepEqual(always.approvals, ['apipod_get_balance'])

  const never = await boot({ config: { approvalMode: 'never' }, respond: () => ok({ task_id: 't' }) })
  await never.call('apipod_generate_image', { model: 'img-1', prompt: 'x' })
  assert.deepEqual(never.approvals, [])
})

test('a cancelled call is recorded as aborted, not as an APIPod failure', async () => {
  const controller = new AbortController()
  const h = await boot({
    respond: () => new Promise<Response>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason))
      controller.abort()
    }),
  })
  const result = await h.call('apipod_get_balance', {}, { signal: controller.signal })
  assert.equal(result.isError, true)
  assert.equal(errorCode(result), 'ABORTED')
})
