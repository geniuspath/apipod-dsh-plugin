import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, resolveSettings } from '../src/config.ts'

const settings = (overrides: Record<string, unknown> = {}) => resolveSettings(Config(overrides as never))

test('defaults are https, approve spending, and name a credential reference', () => {
  const s = settings()
  assert.equal(s.baseUrl, 'https://api.apipod.ai')
  assert.equal(s.approvalMode, 'generation')
  assert.equal(s.apiKeyRef, 'APIPOD_API_KEY')
})

test('a pasted API key is refused as apiKeyRef', () => {
  assert.throws(() => settings({ apiKeyRef: 'sk-live-abc123' }), /credential reference name/)
})

test('http baseUrl is refused, even with allowInsecureBaseUrl, unless the host is loopback', () => {
  assert.throws(() => settings({ baseUrl: 'http://api.apipod.ai' }), /https/)
  assert.throws(() => settings({ baseUrl: 'http://evil.example', allowInsecureBaseUrl: true }), /https/)
  assert.throws(() => settings({ baseUrl: 'http://localhost:8080' }), /https/)
  assert.equal(settings({ baseUrl: 'http://localhost:8080/', allowInsecureBaseUrl: true }).baseUrl, 'http://localhost:8080')
})

test('baseUrl with embedded credentials, query or fragment is refused', () => {
  assert.throws(() => settings({ baseUrl: 'https://user:pw@api.apipod.ai' }), /credentials/)
  assert.throws(() => settings({ baseUrl: 'https://api.apipod.ai/?x=1' }), /query/)
  assert.throws(() => settings({ baseUrl: 'not a url' }), /valid URL/)
})

test('an unknown approvalMode fails schema validation', () => {
  assert.throws(() => settings({ approvalMode: 'sometimes' }))
})

test('topupUrl may be disabled but not downgraded to http', () => {
  assert.equal(settings({ topupUrl: '' }).topupUrl, undefined)
  assert.throws(() => settings({ topupUrl: 'http://www.apipod.ai/console/billing' }), /https/)
})
