/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { historicalSnapshot } from './helpers/storage-files.mjs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
const dir = process.env.SAY_CLEAR_ITERATION_ARTIFACTS
async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
function diagram(workspace) {
  return workspace.systems.flatMap((s) => s.contents).find((c) => c.diagram)?.diagram
}
async function capture(name) {
  await browser.execute(async () => {
    // Background WebViews may pause animation frames; never await an infinite spinner.
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 500)),
      (async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})),
        )
      })(),
    ])
  })
  await browser.saveScreenshot(join(dir, name))
}
async function select(label, value) {
  await browser.execute(
    (label, value) => {
      const el = document.querySelector(`[aria-label="${label}"]`)
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    },
    label,
    value,
  )
}
describe('Web 应用现状与迭代', () => {
  it('编辑对比、只读保护、历史与跨进程恢复', async () => {
    await $('.save-status.saved').waitForExist()
    if (process.env.SAY_CLEAR_ITERATION_PHASE === 'restore') {
      const expected = JSON.parse(await readFile(join(dir, 'workspace-snapshot.json'), 'utf8'))
      const loaded = await snapshot()
      assert.deepEqual(loaded, expected)
      assert.equal(diagram(loaded).history.length, 1)
      await $('button=现状').click()
      assert.equal(await $$('.diagram-node').length, 10)
      assert.equal(await $('button=添加组件').isEnabled(), false)
      await $('button=本次迭代').click()
      assert.equal(await $('button=添加组件').isEnabled(), true)
      await select('查看历史现状', diagram(loaded).history[0].id)
      await browser.waitUntil(async () => (await $$('.diagram-node').length) === 7)
      assert.equal(await $('button=添加组件').isEnabled(), false)
      await $('button=现状').click()
      await capture('restored-current.png')
      return
    }
    await $('button*=体验「手机号注册」迭代示例').click()
    assert.equal(await $$('.diagram-node').length, 11)
    assert.equal(await $$('.diagram-node[data-change="added"]').length, 4)
    assert.equal(await $$('.diagram-node[data-change="modified"]').length, 4)
    assert.equal(await $$('.diagram-node[data-change="removed"]').length, 1)
    const original = diagram(await snapshot())
    await $('[aria-label="适应画板"]').click()
    await capture('web-app-iteration.png')
    await $('button=现状').click()
    await browser.waitUntil(async () => (await $$('.diagram-node').length) === 7)
    assert.equal(await $('button=添加组件').isEnabled(), false)
    await $('[aria-label="组件 注册页面"]').doubleClick()
    assert.equal(await $('dialog').isExisting(), false)
    await $('[aria-label="系统图画板"]').click({ x: 10, y: 90 })
    await browser.keys(['Delete'])
    assert.deepEqual(diagram(await snapshot()).iteration.baseline, original.iteration.baseline)
    await capture('web-app-current.png')
    await $('button=本次迭代').click()
    await $('[aria-label="组件 注册页面"]').click()
    await $('button=编辑组件').click()
    await $('[aria-label="组件说明"]').waitForExist()
    await $('[aria-label="组件说明"]').setValue(
      '保留邮箱注册，新增手机号、验证码和发送验证码入口；验证码 5 分钟有效。',
    )
    await $('button=保存组件').click()
    const changed = diagram(await snapshot())
    assert.deepEqual(changed.iteration.baseline, original.iteration.baseline)
    assert.match(changed.components.find((c) => c.id === 'signup-page').description, /5 分钟/)
    await $('[aria-label="取消选择"]').click()
    await $('button*=变更清单').click()
    assert.match(await $('[aria-label="迭代变更清单"]').getText(), /9 个组件/)
    await $('.change-list-item summary').click()
    await capture('web-app-changes.png')
    await $('[aria-label="关闭变更清单"]').click()
    await $('[aria-label="组件 注册欢迎页"]').click()
    assert.equal(await $('[aria-label="删除组件"]').isEnabled(), false)
    await $('[aria-label="取消选择"]').click()
    // Publishing updates the local model and preserves a historical snapshot.
    await $('button=更新为现状').click()
    await $('button=确认更新现状').click()
    const published = diagram(await snapshot())
    assert.equal(published.iteration, undefined)
    assert.equal(published.history[0].snapshot, undefined)
    assert.deepEqual(
      await historicalSnapshot(browser, await snapshot(), published.history[0].id),
      original.iteration.baseline,
    )
    assert.equal(published.components.length, 10)
    const workspace = await snapshot()
    const system = workspace.systems.find((s) => s.contents.some((c) => c.diagram?.history.length))
    const board = system.contents.find((c) => c.diagram?.history.length)
    const historyPath = join(
      dir,
      'workspace',
      'systems',
      system.architecture.id,
      'boards',
      board.id,
      'versions',
      `${published.history[0].id}.json`,
    )
    await rename(historyPath, `${historyPath}.unavailable`)
    await select('查看历史现状', published.history[0].id)
    await $('.history-load-state[role="alert"]').waitForExist()
    assert.match(await $('.history-load-state').getText(), /缺少数据文件/)
    assert.equal(await $('button=JSON').isEnabled(), false)
    await capture('history-file-missing.png')
    await $('button=现状').click()
    assert.equal(await $$('.diagram-node').length, 10)
    await select('查看历史现状', published.history[0].id)
    await $('.history-load-state[role="alert"]').waitForExist()
    await rename(`${historyPath}.unavailable`, historyPath)
    await $('button=重试读取').click()
    await browser.waitUntil(async () => (await $$('.diagram-node').length) === 7)
    await capture('history-file-restored.png')
    assert.equal(await $('button=添加组件').isEnabled(), false)
    await $('button=现状').click()
    await $('button=创建迭代').click()
    await $('[aria-label="迭代名称"]').setValue('下一次迭代：完善登录流程')
    await $('button=开始迭代').click()
    assert.equal(await $('.iteration-count').getText(), '0')
    await $('button=添加组件').click()
    assert.equal(await $$('.diagram-library button').length, 12)
    await capture('web-app-components.png')
    await $('[aria-label="关闭组件菜单"]').click()
    await $('[aria-label="放弃本次迭代"]').click()
    await $('button=放弃并恢复现状').click()
    assert.equal(diagram(await snapshot()).iteration, undefined)
    await $('[aria-label="撤销画板操作"]').click()
    await $('button=本次迭代').click()
    assert.ok(diagram(await snapshot()).iteration)
    await writeFile(join(dir, 'workspace-snapshot.json'), JSON.stringify(await snapshot(), null, 2))
  })
})
