import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { loadShared } from './load-shared.mjs'
const source = process.argv[2]
if (!source) throw new Error('请传入现有示例工作区路径；此脚本生成独立预览，不改写来源')
const root = await mkdtemp(resolve('artifacts/composition-preview-'))
const m = await loadShared(join(root, 'modules'))
const index = JSON.parse(await readFile(join(source, 'workspace.json'), 'utf8'))
const original = {
  ...index,
  systems: await Promise.all(
    index.systemIds.map(async (id) => ({
      architecture: JSON.parse(
        await readFile(join(source, 'systems', id, 'architecture.json'), 'utf8'),
      ),
      contents: JSON.parse(await readFile(join(source, 'systems', id, 'content.json'), 'utf8'))
        .contents,
    })),
  ),
}
await writeFile(join(root, 'source-workspace.json'), JSON.stringify(original, null, 2))
const old = original.systems.find((s) => s.architecture.id === 'fixture-project')
if (!old?.contents.some((c) => c.id === 'account-config-branches'))
  throw new Error('需要带注册与配置分支案例的工作区')
const architecture = {
  ...m.createArchitecture('注册与账户 · 业务系统'),
  id: 'business-system',
  kind: 'system',
  description: '通过应用公开契约连接注册与异步开户；逐层进入具体流程和配置分支。',
  boards: [
    {
      id: 'user-application',
      name: '用户应用',
      description: '负责用户注册，对外发布注册成功事件。',
      kind: 'application',
      parentId: 'business-system',
    },
    {
      id: 'fixture-project',
      name: '用户注册',
      description: old.architecture.description,
      kind: 'atomic',
      parentId: 'user-application',
    },
    {
      id: 'account-application',
      name: '账户应用',
      description: '订阅注册成功事件，按照配置决定是否初始化账户。',
      kind: 'application',
      parentId: 'business-system',
    },
    {
      id: 'registration-messaging',
      name: '账户初始化',
      description: '消费注册消息，判断配置，再初始化或跳过。',
      kind: 'aggregate',
      parentId: 'account-application',
    },
    {
      id: 'account-config-branches',
      name: '配置驱动的开户分支',
      description: '开关开启、关闭和配置异常的三条分支。',
      kind: 'atomic',
      parentId: 'registration-messaging',
    },
  ],
}
let workspace = m.initializeBoards(
  m.workspaceSchema.parse({
    schemaVersion: 2,
    activeNodeId: architecture.id,
    componentCatalog: original.componentCatalog,
    systems: [m.buildSystem(architecture, { architecture, contents: old.contents })],
  }),
)
const update = (id, fn) => {
  workspace = m.updateNodeContent(workspace, id, (p) => ({ ...p, diagram: fn(p.diagram) }))
}
const port = (id, name) => ({
  id,
  name,
  dataType: 'event',
  description: '载荷：userId；跨应用通过消息队列交付。',
})
update('user-application', (d) => ({
  ...d,
  components: d.components.map((c) => ({ ...c, outputs: [port('registered-event', '注册成功')] })),
}))
update('account-application', (d) => ({
  ...d,
  components: d.components.map((c) => ({
    ...c,
    inputs: [port('registration-message', '注册成功')],
    outputs: [port('account-created', '账户已初始化')],
  })),
}))
for (const [target, sourceId, entry, outputs] of [
  ['user-application', 'fixture-project', 'signup', ['registered']],
  ['account-application', 'registration-messaging', 'consume-registration', ['account-data']],
]) {
  const source = m.referenceBoards(workspace).find((b) => b.id === sourceId)
  const reference = m.createReference(
    m.referenceBoards(workspace),
    target,
    {
      boardId: sourceId,
      componentId: entry,
      version: 'iteration',
      iterationId: source.diagram.iteration.id,
      outputIds: outputs,
    },
    { x: 480, y: 100 },
  )
  update(target, (d) => ({
    ...d,
    components: [{ ...d.components[0], position: { x: 80, y: 100 } }, reference],
    connections: [
      {
        ...m.newConnection(d.components[0], reference),
        name: '由下级流程实现',
        type: 'contains',
        sourcePortId: null,
        targetPortId: null,
      },
    ],
  }))
}
workspace = m.includeBoards(workspace, architecture.id, ['user-application', 'account-application'])
update(architecture.id, (d) => {
  const user = d.components.find((c) => c.reference?.boardId === 'user-application')
  const account = d.components.find((c) => c.reference?.boardId === 'account-application')
  d.components[0].position = { x: 80, y: 60 }
  user.position = { x: 80, y: 330 }
  account.position = { x: 580, y: 330 }
  return {
    ...d,
    connections: [
      {
        ...m.newConnection(user, account),
        type: 'event',
        name: '注册成功 → 异步开户',
        protocol: '消息队列',
        description: '用户应用发布 UserRegistered，账户应用订阅并按配置处理。',
        sourcePortId: user.outputs[0].id,
        targetPortId: account.inputs[0].id,
      },
    ],
  }
})
workspace = m.workspaceSchema.parse(workspace)
const issues = m
  .referenceBoards(workspace)
  .flatMap((b) =>
    b.diagram.components
      .filter((c) => c.reference)
      .map((c) => m.resolveReference(m.referenceBoards(workspace), c)),
  )
  .filter((r) => r.status !== 'ok')
if (issues.length) throw new Error(issues.map((r) => r.message).join('; '))
await writeFile(join(root, 'workspace-snapshot.json'), JSON.stringify(workspace, null, 2))
const data = join(root, 'workspace')
await mkdir(data)
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify(
    {
      schemaVersion: 2,
      activeNodeId: workspace.activeNodeId,
      systemIds: workspace.systems.map((s) => s.architecture.id),
      componentCatalog: workspace.componentCatalog,
    },
    null,
    2,
  ),
)
for (const s of workspace.systems) {
  const dir = join(data, 'systems', s.architecture.id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'architecture.json'), JSON.stringify(s.architecture, null, 2))
  await writeFile(
    join(dir, 'content.json'),
    JSON.stringify({ schemaVersion: 1, contents: s.contents }, null, 2),
  )
}
console.log(`预览工作区：${data}`)
if (process.env.SAY_CLEAR_PREPARE_ONLY !== '1') {
  const child = spawn(resolve('src-tauri/target/debug/say-clear'), [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      SAY_CLEAR_DATA_DIR: data,
      SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
    },
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 0
  })
  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
}
