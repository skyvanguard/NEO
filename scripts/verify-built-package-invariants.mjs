/** Verify every compiled companion through its staged package self-reference under plain Node. */

import {
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const repositoryRoot = resolve(import.meta.dirname, '..')
const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: { 'packages-root': { type: 'string' }, 'loader-url': { type: 'string' } },
})
const packagesRoot = resolve(options['packages-root'] ?? repositoryRoot)
const loaderUrl = options['loader-url']
  ?? pathToFileURL(resolve(repositoryRoot, 'vendor/loader/lib/index.js')).href
const failures = []
const manifests = globSync('packages/*/*/package.json', { cwd: packagesRoot }).sort()
const { default: Loader } = await import(loaderUrl)
const loader = Object.create(Loader.prototype)

for (const manifestPath of manifests) {
  const packageDir = dirname(resolve(packagesRoot, manifestPath))
  const manifest = JSON.parse(readFileSync(resolve(packagesRoot, manifestPath), 'utf8'))
  const packageName = manifest.name
  if (typeof packageName !== 'string' || packageName.length === 0) {
    failures.push(`${manifestPath}: missing package name`)
    continue
  }
  const invariantExport = manifest.exports?.['./invariant']
  // Not every package ships an invariant companion (leaf packages with no event
  // sequence or mutable relation legitimately have none); skip those. Only a
  // present-but-malformed ./invariant export is a failure.
  if (invariantExport === undefined) continue
  if (typeof invariantExport !== 'object'
    || invariantExport.default !== './lib/invariant.js'
    || !manifest.files?.includes('lib/invariant.js')) {
    failures.push(`${packageName}: exports ./invariant but does not publish ./lib/invariant.js`)
    continue
  }

  // Keep the staged view below its owning package so Node reaches the real
  // pnpm dependency links. Junctioning node_modules elsewhere breaks pnpm's
  // relative workspace links on Windows. Copy the manifest-declared lib view
  // so a companion that imports an undeclared runtime chunk fails here.
  const stagedPackageDir = mkdtempSync(resolve(packageDir, '.dsh-built-invariant-'))
  try {
    copyFileSync(resolve(packageDir, 'package.json'), resolve(stagedPackageDir, 'package.json'))
    copyDeclaredLibFiles(packageDir, stagedPackageDir, manifest.files)
    const probePath = resolve(stagedPackageDir, 'probe.mjs')
    writeFileSync(
      probePath,
      `import * as companion from ${JSON.stringify(`${packageName}/invariant`)}\nexport default companion\n`,
    )
    const { default: companion } = await import(pathToFileURL(probePath).href)
    if ('default' in companion) throw new Error('companion has a default export')
    const unwrapped = loader.unwrapExports(companion)
    if (unwrapped !== companion) throw new Error('Loader collapsed the companion namespace')
    if (typeof unwrapped.name !== 'string') throw new Error('companion name is missing')
    if (!Array.isArray(unwrapped.inject) || !unwrapped.inject.includes('invariants')) {
      throw new Error('companion does not inject invariants')
    }
    if (typeof unwrapped.apply !== 'function') throw new Error('companion apply is missing')
  } catch (error) {
    failures.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    rmSync(stagedPackageDir, { recursive: true, force: true })
  }
}


// Built typert/remote artifacts are emitted by codegen and import bare npm deps
// (e.g. `zod`) that the package's src never imports. Importing them under plain
// Node with only the manifest-declared files surfaces an undeclared runtime
// dependency HERE (CI) instead of at plugin load on the server — the exact class
// of failure that broke a deploy.
for (const manifestPath of manifests) {
  const packageDir = dirname(resolve(packagesRoot, manifestPath))
  const manifest = JSON.parse(readFileSync(resolve(packagesRoot, manifestPath), 'utf8'))
  const packageName = manifest.name
  if (typeof packageName !== 'string' || packageName.length === 0) continue
  const artifactSubpaths = ['./typert', './remote'].filter((subpath) => {
    const entry = manifest.exports?.[subpath]
    return typeof entry === 'object' && typeof entry.default === 'string'
  })
  if (artifactSubpaths.length === 0) continue
  const stagedPackageDir = mkdtempSync(resolve(packageDir, '.dsh-built-artifact-'))
  try {
    copyFileSync(resolve(packageDir, 'package.json'), resolve(stagedPackageDir, 'package.json'))
    copyDeclaredLibFiles(packageDir, stagedPackageDir, manifest.files)
    for (const subpath of artifactSubpaths) {
      const libFile = manifest.exports[subpath].default.replace(/^\.\//, '')
      if (!manifest.files?.includes(libFile)) {
        failures.push(`${packageName}: exports ${subpath} but does not publish ${libFile}`)
        continue
      }
      const importSpecifier = `${packageName}${subpath.slice(1)}`
      try {
        const artifactProbe = resolve(stagedPackageDir, `probe${subpath.slice(1).replace(/[^a-z]/gi, '-')}.mjs`)
        writeFileSync(artifactProbe, `import ${JSON.stringify(importSpecifier)}\n`)
        await import(pathToFileURL(artifactProbe).href)
      } catch (error) {
        failures.push(`${packageName}: importing built artifact ${importSpecifier} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    rmSync(stagedPackageDir, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  console.error('verify-built-package-invariants: compiled companion failures:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-built-package-invariants: ${manifests.length} compiled companion(s) passed plain-Node Loader checks.`)

function copyDeclaredLibFiles(packageDir, stagedPackageDir, files) {
  for (const pattern of files) {
    if (!pattern.startsWith('lib/')) continue
    for (const relativePath of globSync(pattern, { cwd: packageDir })) {
      const source = resolve(packageDir, relativePath)
      if (!existsSync(source)) continue
      const target = resolve(stagedPackageDir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    }
  }
}
