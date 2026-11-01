import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { loadShared } from './load-shared.mjs'
import { createComplexDiagramSystems } from './complex-diagram-fixture.mjs'

const root = await mkdtemp(resolve('artifacts/combined-performance-'))
const modules = await loadShared(join(root, 'modules'))
const fixture = createComplexDiagramSystems(modules)
const workspace = modules.workspaceSchema.parse({
  schemaVersion: 2,
  activeNodeId: fixture.activeNodeId,
  systems: fixture.systems,
})
const data = join(root, 'workspace')
await mkdir(data)
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeNodeId: workspace.activeNodeId,
    systemIds: workspace.systems.map((system) => system.architecture.id),
  }),
)
for (const system of workspace.systems) {
  const directory = join(data, 'systems', system.architecture.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'architecture.json'), JSON.stringify(system.architecture))
  await writeFile(
    join(directory, 'content.json'),
    JSON.stringify({ schemaVersion: 1, contents: system.contents }),
  )
}
await writeFile(join(root, 'fixture-summary.json'), JSON.stringify(fixture.summary, null, 2))
const isolated = await isolatedDesktop(root)
const extension = process.platform === 'win32' ? '.exe' : ''
const application = join(root, `say-clear-performance${extension}`)
const env = {
  ...process.env,
  ...isolated.env,
  SAY_CLEAR_E2E_WEBVIEW_STORE_ID: JSON.stringify([...randomBytes(16)]),
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'legacy'),
  SAY_CLEAR_E2E_APPLICATION: application,
  SAY_CLEAR_PERFORMANCE_ARTIFACTS: root,
}
const run = (args) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`大图组合性能验证失败：${code}`)),
    )
  })
console.log(`大图组合性能验证目录：${root}`)
await run([
  'scripts/native.mjs',
  'tauri',
  'build',
  '--debug',
  '--no-bundle',
  '--features',
  'e2e',
  '--config',
  isolated.configPath,
])
// Keep this test independent of a concurrent development/native rebuild.
await copyFile(resolve(`src-tauri/target/debug/say-clear${extension}`), application)
await chmod(application, 0o755)
await run([
  'node_modules/@wdio/cli/bin/wdio.js',
  'run',
  'wdio.conf.mjs',
  '--spec',
  './tests/combined-performance.e2e.mjs',
])
console.log(`大图分级展示、视口裁剪、交互与只读验证通过：${root}`)
