import { spawn } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'

const [statePath] = process.argv.slice(2)
if (statePath === undefined) throw new Error('usage: managed-tree.ts <state-path>')

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

// Publish atomically: the host reads tree.json once as soon as it exists, so a
// half-written file would crash it before it signals readiness.
const pendingStatePath = `${statePath}.pending-${process.pid}`
await writeFile(pendingStatePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
await rename(pendingStatePath, statePath)
setInterval(() => {}, 60_000)
