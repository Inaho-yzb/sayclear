import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

function run(args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`验证命令退出：${code}`)),
    )
  })
}

const root = await mkdtemp(join(tmpdir(), 'say-clear-tauri-'))
const legacy = join(root, 'legacy')
await mkdir(legacy)
const selectedDirectory = join(root, '自定义数据目录')
await mkdir(selectedDirectory)
await mkdir(resolve('artifacts'), { recursive: true })
await cp('tests/fixtures/workspace-v1.json', join(legacy, 'workspace.json'))
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: join(root, 'current'),
  SAY_CLEAR_LEGACY_DIR: legacy,
  SAY_CLEAR_EXPORT_PATH: join(root, 'export.md'),
  SAY_CLEAR_PICK_DIRECTORY: selectedDirectory,
}
try {
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
  for (const phase of ['edit', 'restore', 'empty']) {
    await run(['node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.mjs'], {
      ...env,
      SAY_CLEAR_E2E_PHASE: phase,
    })
  }
  console.log(
    'Tauri 桌面验证通过：系统图默认工作区、旧数据迁移及历史内容保留、权限限制、系统架构创建与编辑、系统图组件与归属编辑、拖拽与端口连线、缩放与追踪、删除撤销、JSON 校验、节点隔离、自定义数据目录迁移及画板重启恢复、系统删除、空工作区重启与重新创建。',
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
