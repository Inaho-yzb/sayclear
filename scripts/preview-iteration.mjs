import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const application = resolve(
  `src-tauri/target/debug/say-clear${process.platform === 'win32' ? '.exe' : ''}`,
)
await access(application).catch(() => {
  throw new Error('请先运行 npm run test:iteration 构建桌面预览')
})
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/iteration-preview-'))
const sample = JSON.parse(await readFile('tests/fixtures/workspace-v2.json', 'utf8')).systems[0]
const diagram = JSON.parse(await readFile('tests/fixtures/iteration-v2.json', 'utf8'))
const now = new Date().toISOString()
const architecture = {
  ...sample.architecture,
  name: 'Web 应用 · 注册迭代',
  description: '现状支持邮箱注册；本次迭代增加手机号验证码注册，并调整注册成功后的引导。',
  boards: [],
  kind: 'application',
  createdAt: now,
  updatedAt: now,
}
const content = {
  ...sample.contents.find((c) => c.id === architecture.id),
  diagram,
  createdAt: now,
  updatedAt: now,
}
const directory = join(root, 'systems', architecture.id)
await mkdir(directory, { recursive: true })
await writeFile(
  join(root, 'workspace.json'),
  JSON.stringify(
    { schemaVersion: 2, systemIds: [architecture.id], activeNodeId: architecture.id },
    null,
    2,
  ),
)
await writeFile(join(directory, 'architecture.json'), JSON.stringify(architecture, null, 2))
await writeFile(
  join(directory, 'content.json'),
  JSON.stringify({ schemaVersion: 1, contents: [content] }, null, 2),
)
console.log(`示例工作区：${root}`)
const child = spawn(application, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SAY_CLEAR_DATA_DIR: root,
    SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  },
})
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 0
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
