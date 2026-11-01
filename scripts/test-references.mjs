import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = await mkdtemp(resolve('artifacts/diagram-references-'))
const workspace = JSON.parse(await readFile('tests/fixtures/references-v2.json', 'utf8'))
const data = join(root, 'workspace')
await mkdir(data, { recursive: true })
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeNodeId: workspace.activeNodeId,
    systemIds: workspace.systems.map((s) => s.architecture.id),
    ...(workspace.componentCatalog ? { componentCatalog: workspace.componentCatalog } : {}),
  }),
)
for (const system of workspace.systems) {
  const dir = join(data, 'systems', system.architecture.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'architecture.json'), JSON.stringify(system.architecture))
  await writeFile(
    join(dir, 'content.json'),
    JSON.stringify({ schemaVersion: 1, contents: system.contents }),
  )
}
const env = {
  ...process.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_REFERENCE_ARTIFACTS: root,
}
const run = (args, extra = {}) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error(`引用验证失败：${code}`))))
  })
console.log(`引用验证工作区：${root}`)
await run([
  'scripts/native.mjs',
  'tauri',
  'build',
  '--debug',
  '--no-bundle',
  '--features',
  'e2e',
  '--config',
  'src-tauri/tauri.e2e.conf.json',
])
for (const phase of ['edit', 'restore'])
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/references.e2e.mjs',
    ],
    { SAY_CLEAR_REFERENCE_PHASE: phase },
  )
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '添加引用与版本选择',
        '公开事件端口',
        '来源跳转与返回',
        '来源改名与显式更新',
        '删除输出告警',
        '基线只读',
        '跨进程恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`验证完成：${root}`)
