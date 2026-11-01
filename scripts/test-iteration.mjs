import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
function run(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error(`验证失败：${code}`))))
  })
}
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/web-app-iteration-'))
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: join(root, 'workspace'),
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_ITERATION_ARTIFACTS: root,
}
console.log(`迭代验证与预览工作区：${root}`)
await run(
  [
    'scripts/native.mjs',
    'tauri',
    'build',
    '--debug',
    '--no-bundle',
    '--features',
    'e2e',
    '--config',
    isolated.configPath,
  ],
  env,
)
for (const phase of ['edit', 'restore'])
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/iteration.e2e.mjs',
    ],
    { ...env, SAY_CLEAR_ITERATION_PHASE: phase },
  )
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '12 种组件',
        '自动增删改对比',
        '现状只读保护',
        '更新现状与历史',
        '放弃与撤销',
        '跨进程恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`验证完成，截图和工作区保留在：${root}`)
