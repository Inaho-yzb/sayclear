/* global browser, $, describe, it */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = process.env.SAY_CLEAR_CLI_ARTIFACTS
const directory = process.env.SAY_CLEAR_CLI_WORKSPACE
const binary =
  process.env.SAY_CLEAR_CLI_BINARY ??
  resolve(`src-tauri/target/debug/sayclear${process.platform === 'win32' ? '.exe' : ''}`)

function command(args, input, expectedCode = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args, '--workspace', directory], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      try {
        assert.equal(code, expectedCode, stderr || stdout)
        const response = JSON.parse(code === 0 ? stdout : stderr)
        resolve(code === 0 ? response.result : response.error)
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
}
const graph = () => command(['graph', 'get', 'cli-app'])

describe('业务 CLI 与桌面工作区', () => {
  it('通过真实 CLI 同步当前画板并支持撤销、版本冲突、批量原子性和重启', async () => {
    await $('.save-status.saved').waitForExist()
    if (process.env.SAY_CLEAR_CLI_PHASE === 'restore') {
      assert.equal((await graph()).data.diagram.components[0].name, 'CLI 已修改')
      assert.match(await $('[data-component-id="board-entry"]').getText(), /CLI 已修改/)
      await browser.saveScreenshot(join(root, 'cli-restored.png'))
      return
    }
    const initial = await graph()
    const originalName = initial.data.diagram.components[0].name
    const update = [
      'component',
      'update',
      'board-entry',
      '--graph',
      'cli-app',
      '--if-match',
      initial.revision,
      '--input',
      '-',
    ]
    const preview = await command([...update, '--dry-run'], { name: '不应保存的预览' })
    assert.equal(preview.wouldChange, true)
    assert.equal((await graph()).data.diagram.components[0].name, originalName)
    await command(update, { name: 'CLI 已修改' })
    await browser.waitUntil(async () =>
      (await $('[data-component-id="board-entry"]').getText()).includes('CLI 已修改'),
    )
    const stale = await command(update, { name: '旧结果不得覆盖' }, 4)
    assert.equal(stale.code, 'REVISION_CONFLICT')
    await $('[aria-label="撤销画板操作"]').click()
    await browser.waitUntil(
      async () => (await graph()).data.diagram.components[0].name === originalName,
    )
    await $('[aria-label="重做画板操作"]').click()
    await browser.waitUntil(
      async () => (await graph()).data.diagram.components[0].name === 'CLI 已修改',
    )
    const beforeBatch = await graph()
    await command(
      ['graph', 'update', 'cli-app', '--if-match', beforeBatch.revision, '--input', '-'],
      {
        operations: [
          { op: 'component.create', value: { id: 'must-not-exist', templateId: 'builtin-action' } },
          { op: 'connection.create', value: { sourceId: 'missing', targetId: 'board-entry' } },
        ],
      },
      2,
    )
    assert.deepEqual((await graph()).data.diagram, beforeBatch.data.diagram)
    await command([
      'graph',
      'create',
      '--parent',
      'cli-app',
      '--id',
      'cli-child',
      '--name',
      'CLI 新建子图',
      '--if-match',
      beforeBatch.revision,
    ])
    const child = await command(['graph', 'get', 'cli-child'])
    assert.equal(child.data.parentId, 'cli-app')
    assert.equal(child.data.diagram.components[0].exposed, true)
    const deleted = await command(['graph', 'delete', 'cli-child', '--if-match', child.revision])
    assert.equal(deleted.data.contentRetained, true)
    assert.equal((await command(['graph', 'get', 'cli-child'], undefined, 3)).code, 'NOT_FOUND')
    assert.equal((await graph()).data.diagram.components[0].name, 'CLI 已修改')
    await browser.saveScreenshot(join(root, 'cli-edited.png'))
  })
})
