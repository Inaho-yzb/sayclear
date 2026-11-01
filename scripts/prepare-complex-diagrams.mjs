import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createComplexDiagramSystems } from './complex-diagram-fixture.mjs'
import { loadShared } from './load-shared.mjs'

const suppliedTarget = process.argv[2]
if (!suppliedTarget)
  throw new Error('请传入桌面测试工作区目录；此脚本只生成和校验预备数据，不改写该目录')
const target = resolve(suppliedTarget)
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const json = (value) => JSON.stringify(value, null, 2)
const hash = (value) => createHash('sha256').update(value).digest('hex')

async function requireNoTransaction(directory) {
  if ((await readdir(directory)).some((name) => name.startsWith('.pending')))
    throw new Error('工作区正在保存或恢复事务，请等待桌面显示“已保存到本地”后重试')
}

async function graphList(directory, binary) {
  const response = await new Promise((done, reject) => {
    const child = spawn(binary, ['graph', 'list', '--workspace', directory, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`原生工作区校验失败：${stderr.trim() || code}`))
      try {
        const result = JSON.parse(stdout)
        if (!result.ok) throw new Error(`原生工作区校验失败：${json(result.error)}`)
        done(result)
      } catch (error) {
        reject(error)
      }
    })
  })
  return response.result.data
}

await requireNoTransaction(target)
const originalIndexText = await readFile(join(target, 'workspace.json'), 'utf8')
const originalIndex = JSON.parse(originalIndexText)
if (originalIndex.schemaVersion !== 3 || !Array.isArray(originalIndex.systemIds))
  throw new Error('请传入已经由桌面应用迁移到版本 3 的测试工作区')

// All existing node IDs matter, including content detached from the navigation tree.
const existingIds = new Set()
for (const id of originalIndex.systemIds) {
  const directory = join(target, 'systems', id)
  const [architecture, systemIndex] = await Promise.all([
    readJson(join(directory, 'architecture.json')),
    readJson(join(directory, 'index.json')),
  ])
  for (const nodeId of [
    id,
    ...architecture.boards.map((board) => board.id),
    ...systemIndex.boardIds,
  ])
    existingIds.add(nodeId)
}

const root = await mkdtemp(resolve('artifacts/complex-diagrams-'))
const modules = await loadShared(join(root, 'modules'))
const { systems, activeNodeId, summary } = createComplexDiagramSystems(modules)
const roots = systems.map((system) => system.architecture.id)
if (!roots.length || roots.some((id) => !id.startsWith('complex-')))
  throw new Error('复杂案例必须使用独立的 complex- 系统 ID')
const workspace = modules.workspaceSchema.parse({
  schemaVersion: 2,
  activeNodeId,
  systems,
  ...(originalIndex.componentCatalog ? { componentCatalog: originalIndex.componentCatalog } : {}),
})
for (const system of workspace.systems)
  for (const content of system.contents)
    if (existingIds.has(content.id))
      throw new Error(`案例 ID「${content.id}」已存在，请保留现有案例，避免重复导入`)

const generated = join(root, 'generated')
await mkdir(generated)
await writeFile(
  join(generated, 'workspace.json'),
  json({
    schemaVersion: 2,
    activeNodeId,
    systemIds: roots,
    ...(originalIndex.componentCatalog ? { componentCatalog: originalIndex.componentCatalog } : {}),
  }),
)
for (const system of workspace.systems) {
  const directory = join(generated, 'systems', system.architecture.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'architecture.json'), json(system.architecture))
  await writeFile(
    join(directory, 'content.json'),
    json({ schemaVersion: 1, contents: system.contents }),
  )
}

const extension = process.platform === 'win32' ? '.exe' : ''
let binary = resolve(`src-tauri/target/debug/sayclear${extension}`)
try {
  await access(binary)
} catch {
  binary = resolve(`src-tauri/target/release/sayclear${extension}`)
  await access(binary).catch(() => {
    throw new Error('请先构建 sayclear 命令行；此脚本通过原生存储迁移生成有效的拆分文件')
  })
}
const generatedGraphs = await graphList(generated, binary)
const generatedIndex = await readJson(join(generated, 'workspace.json'))
if (generatedIndex.schemaVersion !== 3) throw new Error('复杂案例未完成原生存储迁移')

// The endpoint contains a live app token: copying it would forward clone CLI
// requests into the running app. Copy only business files, never ownership files.
const validationWorkspace = join(root, 'validation-workspace')
await requireNoTransaction(target)
await cp(target, validationWorkspace, {
  recursive: true,
  filter: (path) => {
    const name = basename(path)
    return (
      !['.sayclear-cli.json', '.sayclear-workspace.lock'].includes(name) &&
      !name.startsWith('.pending')
    )
  },
})
await requireNoTransaction(target)
if ((await readFile(join(target, 'workspace.json'), 'utf8')) !== originalIndexText)
  throw new Error('准备期间工作区索引已变化，请等待保存完成后重新生成')
for (const id of roots)
  await cp(join(generated, 'systems', id), join(validationWorkspace, 'systems', id), {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
const mergedIndex = {
  ...originalIndex,
  systemIds: [...originalIndex.systemIds, ...roots],
  activeNodeId,
}
const temporaryIndex = join(validationWorkspace, 'workspace.next.json')
await writeFile(temporaryIndex, json(mergedIndex))
await rename(temporaryIndex, join(validationWorkspace, 'workspace.json'))
const combinedGraphs = await graphList(validationWorkspace, binary)

const manifest = {
  target,
  generated,
  validationWorkspace,
  roots,
  activeNodeId,
  summary,
  generatedBoardCount: generatedGraphs.length,
  combinedBoardCount: combinedGraphs.length,
  originalIndexSha256: hash(originalIndexText),
  originalIndex: JSON.parse(originalIndexText),
  preparedAt: new Date().toISOString(),
}
await writeFile(join(root, 'original-workspace-index.json'), originalIndexText)
await writeFile(join(root, 'manifest.json'), json(manifest))
console.log(`复杂案例已生成并通过原生校验：${root}`)
console.log(`新画板 ${generatedGraphs.length} 张；合并验证画板 ${combinedGraphs.length} 张`)
console.log(`清单：${join(root, 'manifest.json')}`)
console.log(json(summary))
