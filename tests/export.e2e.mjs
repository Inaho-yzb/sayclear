/* global browser, $, describe, it */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.SAY_CLEAR_EXPORT_ARTIFACTS
const data = join(root, 'workspace')
const output = join(root, 'exports')
const phase = process.env.SAY_CLEAR_EXPORT_PHASE

async function saved() {
  await browser.waitUntil(() =>
    browser.execute(() => document.querySelector('.save-status.saved') !== null),
  )
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}

async function diskSnapshot(directory) {
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(files, await diskSnapshot(path))
    else
      files[path] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
  }
  return files
}

async function openExport(scope, includeHistory = true, format = 'folder', mode = 'all') {
  await $('[aria-label="导出交付包"]').click()
  await $('.export-form').waitForDisplayed()
  if (mode !== 'all') await $(`input[name="export-mode"][value="${mode}"]`).click()
  await $(`input[name="export-scope"][value="${scope}"]`).click()
  if (!includeHistory && mode === 'all') await $('.export-history-option input').click()
  await $(`input[name="export-format"][value="${format}"]`).click()
}

async function submit() {
  await $('.export-form button[type="submit"]').click()
  try {
    await $('.export-form').waitForExist({ reverse: true })
  } catch (error) {
    const detail = await browser.execute(
      () => document.querySelector('.export-form .form-error')?.textContent ?? '',
    )
    await browser.saveScreenshot(join(root, `export-${phase}-failure.png`))
    throw new Error(`导出未完成：${detail || error.message}`, { cause: error })
  }
}

async function readDirectory(directory, prefix = '') {
  const files = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name
    if (entry.isDirectory()) {
      for (const file of await readDirectory(join(directory, entry.name), path + '/')) {
        files.set(...file)
      }
    } else files.set(path, await readFile(join(directory, entry.name)))
  }
  return files
}

function readStoredZip(buffer) {
  const files = new Map()
  const end = buffer.length - 22
  assert.equal(buffer.readUInt32LE(end), 0x06054b50)
  assert.equal(buffer.readUInt16LE(end + 4), 0)
  const count = buffer.readUInt16LE(end + 10)
  let cursor = buffer.readUInt32LE(end + 16)
  assert.equal(cursor + buffer.readUInt32LE(end + 12), end)
  let bundleName
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50)
    assert.equal(buffer.readUInt16LE(cursor + 8), 0x0800)
    assert.equal(buffer.readUInt16LE(cursor + 10), 0)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const fullPath = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    bundleName ??= fullPath.split('/')[0]
    assert.ok(fullPath.startsWith(bundleName + '/'))
    const path = fullPath.slice(bundleName.length + 1)
    assert.ok(path && !path.split('/').includes('..'))
    const offset = buffer.readUInt32LE(cursor + 42)
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50)
    const size = buffer.readUInt32LE(cursor + 24)
    assert.equal(buffer.readUInt32LE(offset + 22), size)
    const start = offset + 30 + buffer.readUInt16LE(offset + 26)
    const content = buffer.subarray(start, start + size)
    assert.equal(content.length, size)
    const actualCrc =
      content.reduce((state, byte) => {
        let crc = state ^ byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
        return crc >>> 0
      }, 0xffffffff) ^ 0xffffffff
    assert.equal(actualCrc >>> 0, buffer.readUInt32LE(cursor + 16))
    assert.equal(files.has(path), false)
    files.set(path, content)
    cursor += 46 + nameLength
  }
  assert.equal(cursor, end)
  return files
}

async function folderExport(scope, includeHistory = true, mode = 'all') {
  const before = new Set(await readdir(output))
  await openExport(scope, includeHistory, 'folder', mode)
  await submit()
  const created = (await readdir(output)).filter((name) => !before.has(name))
  assert.equal(created.length, 1)
  return {
    directory: join(output, created[0]),
    files: await readDirectory(join(output, created[0])),
  }
}

function verify(files, { scope, count, history, mode = 'all' }) {
  const text = (path) => {
    assert.ok(files.has(path), `missing ${path}`)
    return files.get(path).toString('utf8')
  }
  const json = (path) => JSON.parse(text(path))
  const manifest = json('manifest.json')
  assert.equal(manifest.format, 'say-clear.export')
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.mode, mode)
  assert.equal(manifest.scope.type, scope)
  assert.equal(manifest.counts.boardCount, count)
  assert.equal(manifest.boards.length, count)
  assert.equal(manifest.includesHistory, history)
  assert.match(text('README.md'), /图与变更交付包/)
  assert.match(text('README.md'), /UTF-8/)
  assert.match(text('templates/ai-handoff.md'), /AI/)
  assert.ok(text('templates/change-request.md').length > 100)
  assert.match(text('diagram.html'), /<!doctype html>/i)
  assert.ok(!/<script[^>]*\bsrc=/i.test(text('diagram.html')))
  assert.ok(!/<link[^>]*\bhref=["']https?:/i.test(text('diagram.html')))
  assert.ok(json('catalog.json').scenarios.length)
  assert.ok(json('structure.json').systems.length)
  assert.equal(manifest.files.length, files.size)
  for (const file of manifest.files) {
    assert.ok(files.has(file.path), file.path)
    if (file.bytes !== null) assert.equal(files.get(file.path).length, file.bytes, file.path)
  }
  const leads = manifest.boards.find((board) => board.id === 'leads')
  assert.ok(leads)
  const report = json(leads.changesPath)
  assert.equal(report.comparison.kind, 'active-iteration')
  assert.equal(report.counts.total, 14)
  assert.equal(report.changes.length, 14)
  assert.deepEqual(
    new Set(report.changes.map((entry) => entry.status)),
    new Set(['added', 'modified', 'removed']),
  )
  const changed = report.changes.find((entry) => entry.id === 'signup-page')
  assert.equal(changed.status, 'modified')
  assert.ok(changed.fields.some((field) => field.path === '/description'))
  assert.match(changed.before.description, /邮箱和密码/)
  assert.match(changed.after.description, /验证码/)
  assert.equal(report.changes.find((entry) => entry.id === 'sms').before, null)
  assert.equal(report.changes.find((entry) => entry.id === 'welcome').after, null)
  assert.doesNotMatch(text('changes.md'), /完整对象|```json/)
  assert.match(text('changes.md'), /\*\*变更前\*\*/)
  assert.match(text('changes.md'), /\*\*变更后\*\*/)
  assert.match(text('changes.md'), /注册页面/)
  const current = json(leads.baselinePath)
  const draft = json(leads.graphPath)
  assert.ok(current.components.some((entry) => entry.id === 'welcome'))
  assert.ok(!current.components.some((entry) => entry.id === 'sms'))
  assert.ok(draft.components.some((entry) => entry.id === 'sms'))
  assert.ok(!draft.components.some((entry) => entry.id === 'welcome'))
  assert.match(text('diagram.html'), /变更前/)
  assert.match(text('diagram.html'), /变更后/)
  if (mode === 'changes') {
    assert.deepEqual(manifest.changeSelection.changedBoardIds, ['leads'])
    assert.deepEqual(json('change-context.json').changedBoardIds, ['leads'])
    assert.equal(
      manifest.boards.some((board) => board.id === 'second-app'),
      false,
    )
    assert.equal(leads.exportRole, 'changed')
    assert.equal(leads.kind, 'atomic')
    assert.equal(manifest.entrypoints.combined, 'combined.json')
    const combined = json('combined.json')
    assert.equal(combined.format, 'say-clear.combined-export')
    assert.equal(combined.truncated, false)
    assert.ok(
      combined.nodes.some(
        (node) => node.component.id === 'welcome' && node.location.version === 'iteration',
      ),
    )
    assert.ok(/变更(?:内容)?组合/.test(text('diagram.html')), '缺少变更组合视图标题')
    assert.match(text('diagram.html'), /注册欢迎页/)
    assert.deepEqual(
      new Set(manifest.boards.map((board) => board.id)),
      new Set(['leads', 'sales', 'fixture-project']),
    )
  } else {
    assert.equal(files.has('combined.json'), false)
    assert.equal(files.has('change-context.json'), false)
  }
  if (count > 1) {
    const unchanged = manifest.boards.find((board) => board.id === 'fixture-project')
    assert.equal(json(unchanged.changesPath).counts.total, 0)
    assert.equal(
      json(unchanged.changesPath).comparison.kind,
      mode === 'changes' ? 'context' : 'none',
    )
    const sales = manifest.boards.find((board) => board.id === 'sales')
    assert.equal(sales.history.length, history ? 1 : 0)
    assert.equal(sales.omittedHistoryCount, history ? 0 : 1)
    if (history) {
      assert.ok(
        json(sales.history[0].path).components.some((component) => component.id === 'welcome'),
      )
      assert.equal(json(sales.history[0].changesPath).comparison.kind, 'history-interval')
      assert.equal(json(sales.history[0].changesPath).counts.total, 14)
    } else
      assert.equal(
        [...files.keys()].some((path) => path.includes('/history/')),
        false,
      )
  }
  return manifest
}

describe('图与变更交付包桌面导出', () => {
  it('通过真实 UI 导出独立目录和 ZIP，保持源工作区完整', async () => {
    const before = await saved()
    const snapshot = await diskSnapshot(data)
    const historical = before.systems[0].contents.find((content) => content.id === 'sales').diagram
      .history
    assert.equal(historical.length, 1)
    assert.equal(historical[0].snapshot, undefined)
    if (phase === 'folder') {
      await openExport('board')
      await browser.execute(() => {
        document.querySelector('dialog.modal').scrollTop = 0
      })
      await browser.saveScreenshot(join(root, 'export-dialog.png'))
      await browser.setWindowSize(1060, 720)
      await browser.execute(() => {
        document.querySelector('dialog.modal').scrollTop = 0
      })
      assert.equal(
        await browser.execute(() => {
          const modal = document.querySelector('dialog.modal')
          return modal.scrollWidth <= modal.clientWidth + 1
        }),
        true,
      )
      await browser.saveScreenshot(join(root, 'export-dialog-compact.png'))
      await $('.export-form button[type="button"]').scrollIntoView()
      await browser.saveScreenshot(join(root, 'export-dialog-compact-actions.png'))
      await $('.export-form button[type="button"]').click()
      await browser.setWindowSize(1440, 1000)
      assert.equal((await readdir(output)).length, 0)
      const board = await folderExport('board')
      verify(board.files, { scope: 'board', count: 1, history: true })
      const system = await folderExport('system')
      verify(system.files, { scope: 'system', count: 3, history: true })
      const workspace = await folderExport('workspace', false)
      verify(workspace.files, { scope: 'workspace', count: 4, history: false })
      const changeBoard = await folderExport('board', false, 'changes')
      verify(changeBoard.files, { scope: 'board', count: 3, history: false, mode: 'changes' })
      const changeWorkspace = await folderExport('workspace', false, 'changes')
      verify(changeWorkspace.files, {
        scope: 'workspace',
        count: 3,
        history: false,
        mode: 'changes',
      })
      await $('.tree-row[data-board-id="fixture-project"] .project-item').click()
      await saved()
      await openExport('board', false, 'folder', 'changes')
      assert.equal(await $('.export-form button[type="submit"]').isEnabled(), false)
      assert.equal(await $('.export-history-option input').isEnabled(), false)
      assert.match(await $('.export-empty-state').getText(), /没有进行中的业务变更/)
      await browser.saveScreenshot(join(root, 'export-changes-empty.png'))
      await $('.export-form button[type="button"]').click()
      await $('.tree-row[data-board-id="leads"] .project-item').click()
      await saved()
      await writeFile(
        join(root, 'folder-exports.json'),
        JSON.stringify(
          {
            board: board.directory,
            system: system.directory,
            workspace: workspace.directory,
            changeBoard: changeBoard.directory,
            changeWorkspace: changeWorkspace.directory,
          },
          null,
          2,
        ),
      )
    } else {
      await openExport('system', true, 'zip')
      await submit()
      const zip = await readFile(join(root, 'delivery.zip'))
      const files = readStoredZip(zip)
      verify(files, { scope: 'system', count: 3, history: true })
      await writeFile(join(root, 'full-delivery.zip'), zip)
      await writeFile(
        join(root, 'zip-entries-full.json'),
        JSON.stringify([...files.keys()], null, 2),
      )
      await openExport('system', false, 'zip', 'changes')
      await browser.saveScreenshot(join(root, 'export-changes-dialog.png'))
      await submit()
      const changesZip = await readFile(join(root, 'delivery.zip'))
      const changesFiles = readStoredZip(changesZip)
      verify(changesFiles, { scope: 'system', count: 3, history: false, mode: 'changes' })
      await writeFile(
        join(root, 'zip-entries.json'),
        JSON.stringify([...changesFiles.keys()], null, 2),
      )
    }
    assert.deepEqual(await saved(), before)
    assert.deepEqual(await diskSnapshot(data), snapshot)
    await browser.saveScreenshot(join(root, `export-${phase}-complete.png`))
  })
})
