import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { loadShared } from './load-shared.mjs'
const root = await mkdtemp(resolve('artifacts/composition-'))
const m = await loadShared(join(root, 'modules'))
const user = { ...m.createArchitecture('用户应用'), id: 'user-app' }
const account = { ...m.createArchitecture('账户应用'), id: 'account-app' }
let workspace = m.initializeBoards({
  schemaVersion: 2,
  activeNodeId: user.id,
  systems: [m.buildSystem(user), m.buildSystem(account)],
})
workspace = m.addBoard(workspace, user.id, '校验注册', 'atomic')
const first = workspace.activeNodeId
workspace = m.addBoard(workspace, user.id, '创建用户', 'atomic')
workspace = m.updateNodeContent(workspace, first, (p) => {
  const diagram = m.startIteration(p.diagram, '新增手机号校验')
  diagram.components[0].description = '校验手机号验证码'
  return { ...p, diagram }
})
workspace = m.updateNodeContent(workspace, account.id, (p) => {
  const diagram = m.startIteration(p.diagram, '开户能力说明')
  diagram.components[0].description = '幂等创建账户'
  return { ...p, diagram: m.publishIteration(diagram) }
})
workspace.activeNodeId = user.id
const data = join(root, 'workspace')
await mkdir(data)
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeNodeId: workspace.activeNodeId,
    systemIds: workspace.systems.map((s) => s.architecture.id),
  }),
)
for (const s of workspace.systems) {
  const dir = join(data, 'systems', s.architecture.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'architecture.json'), JSON.stringify(s.architecture))
  await writeFile(
    join(dir, 'content.json'),
    JSON.stringify({ schemaVersion: 1, contents: s.contents }),
  )
}
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_COMPOSITION_ARTIFACTS: root,
}
const run = (args, extra = {}) =>
  new Promise((done, reject) => {
    const p = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? done() : reject(new Error(`画板聚合验证失败：${code}`))))
  })
console.log(`画板聚合验证工作区：${root}`)
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
for (const phase of ['edit', 'restore'])
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/composition.e2e.mjs',
    ],
    { SAY_CLEAR_COMPOSITION_PHASE: phase },
  )
console.log(`画板聚合验证通过：${root}`)
