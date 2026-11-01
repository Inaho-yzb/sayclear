import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const suppliedManifest = process.argv[2]
if (!suppliedManifest) throw new Error('请传入 prepare-complex-diagrams.mjs 生成的 manifest.json')
const manifestPath = resolve(suppliedManifest)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const target = resolve(manifest.target)
const generated = resolve(manifest.generated)
const stage = dirname(manifestPath)
const backup = join(stage, 'before-import')
const roots = manifest.roots
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

if (
  !Array.isArray(roots) ||
  !roots.length ||
  roots.some((id) => typeof id !== 'string' || !/^complex-[A-Za-z0-9_-]{1,72}$/.test(id)) ||
  new Set(roots).size !== roots.length
)
  throw new Error('清单中必须是互不重复的 complex- 案例系统 ID')
if (typeof manifest.originalIndexSha256 !== 'string') throw new Error('清单缺少原索引校验值')

async function requireAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`目标已存在，未覆盖：${path}`)
}

async function requireUnchangedIndex() {
  const names = await readdir(target)
  if (names.some((name) => name.startsWith('.pending')))
    throw new Error('工作区有进行中的保存或恢复事务，请等待保存完成后重新准备案例')
  const text = await readFile(join(target, 'workspace.json'), 'utf8')
  if (sha256(text) !== manifest.originalIndexSha256)
    throw new Error('工作区索引在准备后发生变化，未发布新索引；请重新准备或核对当前工作区')
  return { text, index: JSON.parse(text) }
}

async function fileHashes(directory, prefix = '') {
  const hashes = Object.create(null)
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name)
    const relative = prefix ? `${prefix}/${name}` : name
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`数据目录包含符号链接，未继续导入：${path}`)
    if (stat.isDirectory()) Object.assign(hashes, await fileHashes(path, relative))
    else if (stat.isFile()) hashes[relative] = sha256(await readFile(path))
    else throw new Error(`数据目录包含特殊文件，未继续导入：${path}`)
  }
  return hashes
}

async function existingSystemHashes(ids) {
  const hashes = Object.create(null)
  for (const id of ids)
    for (const [path, digest] of Object.entries(await fileHashes(join(target, 'systems', id))))
      hashes[`${id}/${path}`] = digest
  return hashes
}

const { index } = await requireUnchangedIndex()
if (index.schemaVersion !== 3 || !Array.isArray(index.systemIds))
  throw new Error('目标不是受支持的版本 3 工作区')
if (index.systemIds.length + roots.length > 100) throw new Error('合并后超过 100 个系统上限')
if (roots.some((id) => index.systemIds.includes(id)))
  throw new Error('案例系统已在工作区中，未重复导入')
const generatedIndex = JSON.parse(await readFile(join(generated, 'workspace.json'), 'utf8'))
if (
  generatedIndex.schemaVersion !== 3 ||
  JSON.stringify(generatedIndex.systemIds) !== JSON.stringify(roots)
)
  throw new Error('生成数据与清单不一致，未导入')
if (generatedIndex.activeNodeId !== manifest.activeNodeId)
  throw new Error('生成数据的当前画板与清单不一致，未导入')
for (const id of roots) {
  await requireAbsent(join(target, 'systems', id))
  const source = join(generated, 'systems', id)
  if (!(await lstat(source)).isDirectory()) throw new Error(`生成系统目录无效：${source}`)
  await fileHashes(source)
}
await requireAbsent(backup)

const originalHashes = await existingSystemHashes(index.systemIds)
await cp(target, backup, {
  recursive: true,
  filter: (path) => {
    const name = basename(path)
    return (
      !['.sayclear-cli.json', '.sayclear-workspace.lock'].includes(name) &&
      !name.startsWith('.pending')
    )
  },
})
await requireUnchangedIndex()
if (JSON.stringify(await existingSystemHashes(index.systemIds)) !== JSON.stringify(originalHashes))
  throw new Error('备份期间原系统文件发生变化，未发布；请等待保存完成后重新准备案例')
await writeFile(join(stage, 'before-import-hashes.json'), JSON.stringify(originalHashes, null, 2))

const copied = []
let published = false
try {
  for (const id of roots) {
    const temporary = join(target, 'systems', `.${id}-import-${randomUUID()}`)
    await cp(join(generated, 'systems', id), temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    await requireAbsent(join(target, 'systems', id))
    await rename(temporary, join(target, 'systems', id))
    copied.push(id)
  }
  await requireUnchangedIndex()
  if (
    JSON.stringify(await existingSystemHashes(index.systemIds)) !== JSON.stringify(originalHashes)
  )
    throw new Error('导入期间原系统文件发生变化，未发布新索引')
  const nextIndex = {
    ...index,
    systemIds: [...index.systemIds, ...roots],
    activeNodeId: manifest.activeNodeId,
  }
  const temporaryIndex = join(target, `.complex-workspace-${randomUUID()}.json`)
  await writeFile(temporaryIndex, JSON.stringify(nextIndex, null, 2), { flag: 'wx' })
  await requireUnchangedIndex()
  await rename(temporaryIndex, join(target, 'workspace.json'))
  published = true
  const afterHashes = await existingSystemHashes(index.systemIds)
  if (JSON.stringify(afterHashes) !== JSON.stringify(originalHashes))
    throw new Error('索引已发布，但原系统文件同时发生变化，请核对并使用备份检查；未回写旧文件')
  await writeFile(
    join(stage, 'import-result.json'),
    JSON.stringify(
      {
        imported: true,
        target,
        backup,
        roots,
        activeNodeId: manifest.activeNodeId,
        summary: manifest.summary,
        existingFilesUnchanged: true,
        importedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
} catch (error) {
  await writeFile(
    join(stage, 'import-failure.json'),
    JSON.stringify(
      {
        imported: published,
        copiedRoots: copied,
        target,
        backup,
        error: error.message,
        note: '保留已复制的新系统目录与备份，未删除或回写任何旧系统文件。',
      },
      null,
      2,
    ),
  )
  throw error
}
console.log(`复杂案例已导入：${target}`)
console.log(`新增 ${roots.length} 个系统；原有系统文件校验一致`)
console.log(`备份：${backup}`)
console.log('请在桌面应用中完成“重新读取本地数据”，再继续编辑。')
