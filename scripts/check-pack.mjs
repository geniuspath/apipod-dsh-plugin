// Fails when the published tarball would carry anything but built code, or when
// the package could run code at install time.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const problems = []

for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (pkg.scripts?.[hook]) problems.push(`package.json must not define a "${hook}" script`)
}
if (!pkg.dsh?.bundle?.patch) problems.push('package.json must declare dsh.bundle.patch')
if (!pkg.engines?.dsh) problems.push('package.json must declare engines.dsh')

const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))
const files = packed.files.map((file) => file.path)
const allowed = (path) => path.startsWith('lib/') || ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE'].includes(path)
for (const path of files.filter((path) => !allowed(path))) problems.push(`unexpected file in package: ${path}`)
for (const required of ['lib/index.js', 'lib/index.d.ts', 'cordis.patch.yml', 'LICENSE', 'README.md']) {
  if (!files.includes(required)) problems.push(`missing from package: ${required}`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`package ok: ${files.length} files, ${packed.unpackedSize} bytes unpacked`)
