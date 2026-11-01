import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { createServer } from 'node:net'

await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/iteration-management-'))
const data = join(root, 'workspace')
const workspace = JSON.parse(await readFile('tests/fixtures/workspace-v2.json', 'utf8'))
workspace.systems[0].contents.find((content) => content.id === 'leads').diagram = JSON.parse(
  await readFile('tests/fixtures/iteration-v2.json', 'utf8'),
)
const second = structuredClone(workspace.systems[0])
second.architecture = { ...second.architecture, id: 'second-app', name: '账户应用', boards: [] }
second.contents = [{ ...second.contents[0], id: 'second-app' }]
workspace.systems.push(second)
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
// Keep the daily app's single-instance socket, WebDriver and data directory separate.
const config = JSON.parse(await readFile('src-tauri/tauri.e2e.conf.json', 'utf8'))
config.identifier = `com.sayclear.${basename(root).toLowerCase()}`
const configPath = join(root, 'tauri.e2e.conf.json')
await writeFile(configPath, JSON.stringify(config))
const port = await new Promise((done, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => done(port))
  })
})
const env = {
  ...process.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_MANAGEMENT_ARTIFACTS: root,
  TAURI_WEBDRIVER_PORT: String(port),
}
const run = (args, extra = {}) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? done() : reject(new Error(`迭代管理验证失败：${code}`)),
    )
  })
console.log(`迭代管理验证工作区：${root}`)
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
for (const phase of ['edit', 'restore'])
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/iteration-management.e2e.mjs',
    ],
    { SAY_CLEAR_MANAGEMENT_PHASE: phase },
  )
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '跨画板汇总与搜索筛选',
        '创建与重复创建保护',
        '稳定 ID 改名',
        '变更查看与画板跳转',
        '完成与历史只读',
        '放弃与基线恢复',
        '画板状态隔离',
        '原生保存与跨进程恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`迭代管理验证通过：${root}`)
