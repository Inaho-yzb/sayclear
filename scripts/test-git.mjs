import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { isolatedDesktop } from './isolated-desktop.mjs'

const execute = promisify(execFile)
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/git-'))
const data = join(root, 'workspace')
const repository = join(root, '代码 仓库')
await mkdir(repository)
const git = async (...args) => (await execute('git', ['-C', repository, ...args])).stdout.trim()
await git('init', '--initial-branch=main')
const filename = '注册 流程.txt'
await writeFile(join(repository, filename), '初始代码\n')
await git('add', '--', filename)
const commit = (message) =>
  git(
    '-c',
    'user.name=Git E2E',
    '-c',
    'user.email=git-e2e@example.invalid',
    'commit',
    '-m',
    message,
  )
await commit('initial')
const baseCommit = await git('rev-parse', 'HEAD')
await git('branch', 'release/base')
await writeFile(join(repository, filename), '主分支后续代码\n')
await git('add', '--', filename)
await commit('main advances')
const headCommit = await git('rev-parse', 'HEAD')
await writeFile(join(repository, filename), '保留用户尚未提交的修改\n')
const dirtyContent = await readFile(join(repository, filename), 'utf8')
const dirtyStatus = await git('status', '--porcelain=v1')
await writeFile(
  join(root, 'repository-snapshot.json'),
  JSON.stringify(
    {
      path: await realpath(repository),
      filename,
      baseCommit,
      headCommit,
      dirtyContent,
      dirtyStatus,
    },
    null,
    2,
  ),
)

const workspace = JSON.parse(await readFile('tests/fixtures/workspace-v2.json', 'utf8'))
workspace.systems[0].contents[0].diagram = JSON.parse(
  await readFile('tests/fixtures/diagram-v2.json', 'utf8'),
)
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
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_PICK_GIT_DIRECTORY: repository,
  SAY_CLEAR_GIT_ARTIFACTS: root,
}
const run = (args, extra = {}) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`Git 桌面验证失败：${code}`)),
    )
  })
console.log(`Git 桌面验证工作区：${root}`)
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
    ['node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.mjs', '--spec', './tests/git.e2e.mjs'],
    { SAY_CLEAR_GIT_PHASE: phase },
  )
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '直接填写本地仓库路径与非法地址保护',
        '通过原生选择器关联仓库与基准分支',
        '填写仓库 URL 克隆、复用和关联后创建分支',
        '画板创建迭代同步创建指定基准的 Git 分支',
        '已有分支与非法分支保护',
        '完成迭代保留分支关联的历史索引',
        '迭代管理创建分支与放弃后保留分支',
        '当前分支、提交与未提交修改保持原样',
        '仓库、活动迭代与历史关联跨进程恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`Git 桌面验证通过：${root}`)
