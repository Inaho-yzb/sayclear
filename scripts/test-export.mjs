import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isolatedDesktop } from './isolated-desktop.mjs'
import { loadShared } from './load-shared.mjs'

await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/export-'))
const m = await loadShared(join(root, 'modules'))
const workspace = JSON.parse(await readFile('tests/fixtures/workspace-v2.json', 'utf8'))
const iteration = m.iterationExample()
workspace.activeNodeId = 'leads'
workspace.systems[0].contents.find((content) => content.id === 'leads').diagram = iteration
workspace.systems[0].contents.find((content) => content.id === 'sales').diagram =
  m.publishIteration(structuredClone(iteration))
const other = m.buildSystem({ ...m.createArchitecture('外部账户应用'), id: 'second-app' })
workspace.systems.push(other)
m.parseWorkspace(workspace)
await writeFile(join(root, 'source-workspace.json'), JSON.stringify(workspace, null, 2))
const data = join(root, 'workspace')
const output = join(root, 'exports')
await mkdir(data)
await mkdir(output)
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
const isolated = await isolatedDesktop(root)
const configPath = process.env.SAY_CLEAR_EXPORT_REUSE_CONFIG
  ? resolve(process.env.SAY_CLEAR_EXPORT_REUSE_CONFIG)
  : isolated.configPath
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_EXPORT_ARTIFACTS: root,
  SAY_CLEAR_E2E_WEBVIEW_STORE_ID: JSON.stringify([...randomBytes(16)]),
}
const run = (args, extra = {}) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`图交付包验证失败：${code}`)),
    )
  })
console.log(`图交付包验证工作区：${root}`)
await run([
  'scripts/native.mjs',
  'tauri',
  'build',
  '--debug',
  '--no-bundle',
  '--features',
  'e2e',
  '--config',
  configPath,
])
for (const phase of ['folder', 'zip']) {
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/export.e2e.mjs',
    ],
    {
      SAY_CLEAR_EXPORT_PHASE: phase,
      SAY_CLEAR_EXPORT_BUNDLE_PATH: phase === 'folder' ? output : join(root, 'delivery.zip'),
    },
  )
}
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '真实桌面三种导出范围与取消',
        'UTF-8 Markdown 完整前后值及结构化变更',
        '当前现状和迭代版本隔离',
        '懒加载历史快照及历史排除',
        '文件清单、字节数、离线 HTML 与交接模板',
        '原生目录和 ZIP 输出',
        '完整导出与变更导出模式、无变更空状态',
        '变更组合、删除项、祖先归属及完整原子图',
        '导出前后工作区模型和磁盘正文保持一致',
      ],
    },
    null,
    2,
  ),
)
console.log(`图交付包验证通过：${root}`)
