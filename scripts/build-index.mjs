// Writes the dsh plugin index (format 1) for this package from what is actually
// published on npm. Only downloads registry metadata; installs and runs nothing.
//   node scripts/build-index.mjs [--out site/index.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const outFlag = process.argv.indexOf('--out')
const out = resolve(outFlag === -1 ? 'site/index.json' : process.argv[outFlag + 1])

const response = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2F')}`)
if (response.status === 404) {
  console.error(`${pkg.name} is not published on npm yet; an index needs at least one published version.`)
  process.exit(1)
}
if (!response.ok) {
  console.error(`npm registry returned ${response.status}`)
  process.exit(1)
}
const registry = await response.json()

const versions = Object.values(registry.versions ?? {})
  .filter((version) => !version.deprecated && version.dsh?.bundle)
  .map((version) => ({
    version: version.version,
    publishTimestamp: Math.floor(Date.parse(registry.time[version.version]) / 1000),
    source: { type: 'npm' },
    ...(version.engines?.dsh ? { engines: { dsh: version.engines.dsh } } : {}),
  }))
if (versions.length === 0) {
  console.error(`${pkg.name} has no installable published version.`)
  process.exit(1)
}

const index = {
  format: 1,
  title: { en: 'APIPod', zh: 'APIPod' },
  description: {
    en: 'Official APIPod plugins for DeepSeek Harness.',
    zh: 'APIPod 官方 DeepSeek Harness 插件。',
  },
  metadata: {
    categories: { media: { title: { en: 'Media generation', zh: '媒体生成' } } },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'APIPod', zh: 'APIPod' },
      description: {
        en: 'Generate images and videos with APIPod models. Spending calls ask first; the API key stays in the credential store.',
        zh: '使用 APIPod 的模型生成图片与视频。扣费调用先询问用户；API Key 只保存在凭据存储中。',
      },
      icon: 'icons/apipod.svg',
      author: 'APIPod',
      homepage: pkg.homepage,
      repository: { url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') },
      metadata: { category: 'media' },
      versions,
    },
  ],
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${out}: ${versions.length} version(s)`)
