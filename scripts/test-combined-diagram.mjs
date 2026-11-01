import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { loadShared } from './load-shared.mjs'

const root = await mkdtemp(resolve('artifacts/combined-diagram-'))
const m = await loadShared(join(root, 'modules'))
const applications = [
  ['entry-app', '注册应用'],
  ['order-app', '订单应用'],
  ['message-app', '消息应用'],
  ['account-app', '账户应用'],
]
let workspace = m.initializeBoards({
  schemaVersion: 2,
  activeNodeId: 'entry-app',
  systems: applications.map(([id, name]) => m.buildSystem({ ...m.createArchitecture(name), id })),
})
const update = (id, transform) => {
  workspace = m.updateNodeContent(workspace, id, (content) => ({
    ...content,
    diagram: transform(content.diagram),
  }))
}
const reference = (target, source, version = 'current', details = {}) =>
  m.createReference(m.referenceBoards(workspace), target, {
    boardId: source,
    componentId: 'board-entry',
    version,
    outputIds: [],
    ...details,
  })
const connect = (source, target) => ({
  ...m.newConnection(source, target),
  type: 'control',
  name: '继续处理',
  sourcePortId: null,
  targetPortId: null,
})
update('message-app', (diagram) => ({
  ...diagram,
  components: diagram.components.map((component) => ({ ...component, name: '消息投递' })),
}))
const message = reference('order-app', 'message-app')
message.position = { x: 400, y: 80 }
update('order-app', (diagram) => {
  const entry = { ...diagram.components[0], name: '历史订单受理' }
  const graph = {
    ...diagram,
    components: [entry, message],
    connections: [connect(entry, message)],
  }
  const draft = m.startIteration(graph, '订单能力升级')
  draft.components[0].name = '当前订单受理'
  return m.publishIteration(draft)
})
update('account-app', (diagram) => {
  const current = {
    ...diagram,
    components: diagram.components.map((component) => ({ ...component, name: '账户现状能力' })),
  }
  const draft = m.startIteration(current, '账户开户迭代')
  draft.components[0].name = '账户迭代能力'
  return draft
})
const order = m.referenceBoards(workspace).find((board) => board.id === 'order-app')
const account = m.referenceBoards(workspace).find((board) => board.id === 'account-app')
const refs = [
  reference('entry-app', 'order-app', 'history', { historyId: order.diagram.history[0].id }),
  reference('entry-app', 'order-app'),
  reference('entry-app', 'account-app', 'iteration', {
    iterationId: account.diagram.iteration.id,
  }),
].map((component, index) => ({
  ...component,
  id: `entry-reference-${index}`,
  position: { x: 400 + index * 360, y: 80 },
}))
update('entry-app', (diagram) => ({
  ...diagram,
  components: [...diagram.components, ...refs],
  connections: [
    connect(diagram.components[0], refs[0]),
    connect(refs[0], refs[1]),
    connect(refs[1], refs[2]),
  ],
}))
workspace = m.workspaceSchema.parse(workspace)
const data = join(root, 'workspace')
await mkdir(data)
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify({
    schemaVersion: 2,
    activeNodeId: workspace.activeNodeId,
    systemIds: applications.map(([id]) => id),
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
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  SAY_CLEAR_E2E_WEBVIEW_STORE_ID: JSON.stringify([...randomBytes(16)]),
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'legacy'),
  SAY_CLEAR_COMBINED_ARTIFACTS: root,
}
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`组合视图验证失败：${code}`)),
    )
  })
console.log(`组合视图验证目录：${root}`)
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
await run([
  'node_modules/@wdio/cli/bin/wdio.js',
  'run',
  'wdio.conf.mjs',
  '--spec',
  './tests/combined-diagram.e2e.mjs',
])
console.log(`组合视图跨应用、版本、追踪、只读和来源跳转验证通过：${root}`)
