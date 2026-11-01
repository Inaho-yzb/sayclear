import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

function run(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error(`布局验证失败：${code}`))))
  })
}
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/layout-desktop-'))
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: join(root, 'workspace'),
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_LAYOUT_ARTIFACTS: root,
}
console.log(`自动布局桌面验证工作区：${root}`)
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
      './tests/layout.e2e.mjs',
    ],
    { ...env, SAY_CLEAR_LAYOUT_PHASE: phase },
  )
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '截图注册案例原有行列保持',
        '全部可见节点不重叠',
        '删除节点避让与适应视图',
        '重复布局及撤销重做',
        '基线只读',
        '真实桌面重启恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`桌面布局验证完成：${root}`)
