import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// Rebuild an immutable workspace from an existing delivery package. The source
// folder is read only; all previews and compiled modules stay below artifacts/.
if (!process.argv[2])
  throw new Error('请传入已有导出包目录：node scripts/preview-export-changes.mjs <已有导出包目录>')
const source = resolve(process.argv[2])
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/export-review-'))
const modules = join(root, 'modules')
await mkdir(modules)
const sourceRoot = await realpath(source)
async function readSource(path) {
  const file = await realpath(resolve(sourceRoot, path))
  if (!file.startsWith(sourceRoot + sep)) throw new Error(`文件不在导出包内：${path}`)
  return JSON.parse(await readFile(file, 'utf8'))
}
for (const entry of await readdir('src/shared', { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
  let code = await readFile(join('src/shared', entry.name), 'utf8')
  for (const match of [...code.matchAll(/import (\w+) from ['"](.+\.json)['"]/g)]) {
    const data = await readFile(resolve('src/shared', match[2]), 'utf8')
    code = code.replace(match[0], `const ${match[1]} = ${data}`)
  }
  const compiled = ts
    .transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    })
    .outputText.replace(
      /from (['"])(\.\/[^'"]+)\1/g,
      (_, quote, module) => `from ${quote}${module}.mjs${quote}`,
    )
  await writeFile(join(modules, entry.name.replace(/\.ts$/, '.mjs')), compiled)
}
const model = await import(pathToFileURL(join(modules, 'model.mjs')).href)
const { createExportBundle } = await import(pathToFileURL(join(modules, 'export.mjs')).href)
const { exportZip } = await import(pathToFileURL(join(modules, 'export-zip.mjs')).href)
const manifest = await readSource('manifest.json')
if (manifest.format !== 'say-clear.export' || manifest.schemaVersion !== 1)
  throw new Error('不支持的导出包格式或版本')
const structure = await readSource('structure.json')
const catalog = await readSource('catalog.json')
const systems = []
for (const system of structure.systems) {
  const rootNode = system.nodes.find((node) => node.id === system.systemId)
  if (!rootNode) throw new Error(`导出结构缺少系统根节点 ${system.systemId}`)
  const architecture = {
    schemaVersion: 2,
    id: rootNode.id,
    name: rootNode.name,
    description: rootNode.description,
    kind: rootNode.type,
    createdAt: manifest.exportedAt,
    updatedAt: manifest.exportedAt,
    boards: system.nodes
      .filter((node) => node.id !== rootNode.id)
      .map((node) => ({
        id: node.id,
        name: node.name,
        description: node.description,
        kind: node.type,
        parentId: node.parentId,
      })),
  }
  systems.push(model.buildSystem(architecture))
}
for (const board of manifest.boards) {
  const content = systems.flatMap((system) => system.contents).find((item) => item.id === board.id)
  if (!content) throw new Error(`导出结构缺少画板 ${board.id}`)
  const graph = await readSource(board.graphPath)
  const history = []
  for (const version of board.history)
    history.push({
      id: version.id,
      name: version.name,
      publishedAt: version.publishedAt,
      ...(version.git ? { git: version.git } : {}),
      snapshot: await readSource(version.path),
    })
  const baseline = board.baselinePath ? await readSource(board.baselinePath) : null
  content.diagram = {
    ...graph,
    history,
    ...(board.iteration && baseline ? { iteration: { ...board.iteration, baseline } } : {}),
  }
}
const workspace = model.workspaceSchema.parse({
  schemaVersion: 2,
  activeNodeId:
    manifest.boards.find((board) => board.iteration)?.id ?? manifest.boards[0]?.id ?? null,
  componentCatalog: catalog,
  systems,
})
await writeFile(join(root, 'source-workspace.json'), JSON.stringify(workspace, null, 2))
const output = { source, root }
for (const mode of ['all', 'changes']) {
  const bundle = await createExportBundle(workspace, {
    scope: 'workspace',
    boardId: workspace.activeNodeId ?? '',
    mode,
    includeHistory: mode === 'all',
  })
  const folder = join(root, mode === 'all' ? 'full' : 'changes', bundle.name)
  for (const file of bundle.files) {
    const destination = join(folder, file.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.content)
  }
  const zip = join(root, `${mode === 'all' ? 'full' : 'changes'}-export.zip`)
  await writeFile(zip, exportZip(bundle))
  output[mode] = { folder, html: join(folder, 'diagram.html'), zip }
}
await writeFile(join(root, 'preview.json'), JSON.stringify(output, null, 2))
console.log(JSON.stringify(output, null, 2))
