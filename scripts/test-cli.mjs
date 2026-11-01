import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadShared } from './load-shared.mjs'

const root = await mkdtemp(resolve('artifacts/cli-'))
const data = join(root, 'workspace')
const extension = process.platform === 'win32' ? '.exe' : ''
const desktopBinary = join(root, `say-clear-test${extension}`)
const cliBinary = join(root, `sayclear-test${extension}`)
const modules = await loadShared(join(root, 'modules'))
const architecture = { ...modules.createArchitecture('CLI 测试应用'), id: 'cli-app' }
const workspace = modules.initializeBoards({
  schemaVersion: 2,
  activeNodeId: 'cli-app',
  systems: [modules.buildSystem(architecture)],
})
await mkdir(join(data, 'systems/cli-app'), { recursive: true })
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeNodeId: 'cli-app',
    systemIds: ['cli-app'],
  }),
)
await writeFile(join(data, 'systems/cli-app/architecture.json'), JSON.stringify(architecture))
await writeFile(
  join(data, 'systems/cli-app/content.json'),
  JSON.stringify({
    schemaVersion: 1,
    contents: workspace.systems[0].contents,
  }),
)
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'legacy'),
  SAY_CLEAR_CLI_ARTIFACTS: root,
  SAY_CLEAR_CLI_WORKSPACE: data,
  SAY_CLEAR_E2E_APPLICATION: desktopBinary,
  SAY_CLEAR_CLI_BINARY: cliBinary,
}
const run = (args, extra = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`CLI 验证失败：${code}`)),
    )
  })
console.log(`CLI 验证目录：${root}`)
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
// A running `tauri dev` may rebuild target/debug between restart phases.
await copyFile(resolve(`src-tauri/target/debug/say-clear${extension}`), desktopBinary)
await chmod(desktopBinary, 0o755)
await run([
  'scripts/native.mjs',
  'cargo',
  'build',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--bin',
  'sayclear',
  '--locked',
])
await copyFile(resolve(`src-tauri/target/debug/sayclear${extension}`), cliBinary)
await chmod(cliBinary, 0o755)
for (const phase of ['edit', 'restore']) {
  await run(
    ['node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.mjs', '--spec', './tests/cli.e2e.mjs'],
    { SAY_CLEAR_CLI_PHASE: phase },
  )
}
// The same binary must also work after the desktop process exits and releases ownership.
await new Promise((resolve, reject) => {
  const child = spawn(cliBinary, ['graph', 'get', 'cli-app', '--workspace', data], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.once('error', reject)
  child.once('exit', (code) => {
    if (code !== 0) return reject(new Error(`离线读取失败：${code}`))
    try {
      const result = JSON.parse(stdout)
      if (result.result.data.diagram.components[0].name !== 'CLI 已修改')
        throw new Error('重启后的画板内容不一致')
      resolve()
    } catch (error) {
      reject(error)
    }
  })
})
console.log(`CLI 查询、增量修改、冲突保护、撤销、创建删除及重启验证通过：${root}`)
