/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.SAY_CLEAR_COMBINED_ARTIFACTS
const dialog = '[aria-label="多图组合视图"]'
const sourceNode = (boardId, version) =>
  `${dialog} [data-combined-node-id^="${boardId}:${version}:"][data-source-component-id="board-entry"]`
async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
async function settle() {
  await browser.execute(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}
async function transform() {
  return $(`${dialog} .diagram-world`).getAttribute('style')
}

describe('多图组合全链路视图', () => {
  it('递归展开跨应用引用，保留精确版本，支持查看且不改写原图', async () => {
    const before = await snapshot()
    await $('[data-component-id="board-entry"]').click()
    await $('button=组合视图').click()
    await $(dialog).waitForDisplayed()
    await $(`${dialog} [data-combined-board-id="order-app"][data-version="history"]`).waitForExist()
    await browser.waitUntil(
      async () =>
        (await $(`${dialog} [aria-label="组合视图画板"]`).getAttribute('aria-busy')) === 'false',
    )
    await $(sourceNode('order-app', 'history')).waitForExist()
    for (const [boardId, version] of [
      ['entry-app', 'current'],
      ['order-app', 'current'],
      ['message-app', 'current'],
      ['account-app', 'iteration'],
    ]) {
      await $(
        `${dialog} [data-combined-board-id="${boardId}"][data-version="${version}"]`,
      ).waitForExist()
    }
    assert.equal(
      await $(
        `${dialog} [data-combined-board-id="account-app"][data-version="current"]`,
      ).isExisting(),
      false,
    )
    assert.match(await $(sourceNode('order-app', 'history')).getText(), /历史订单受理/)
    assert.match(await $(sourceNode('order-app', 'current')).getText(), /当前订单受理/)
    assert.match(await $(sourceNode('account-app', 'iteration')).getText(), /账户迭代能力/)
    const ids = await $$(`${dialog} [data-combined-node-id]`).map((element) =>
      element.getAttribute('data-combined-node-id'),
    )
    assert.equal(new Set(ids).size, ids.length)
    assert.ok((await $$(`${dialog} [data-source-component-id="board-entry"]`)).length >= 5)
    assert.ok((await $$(`${dialog} [data-edge-kind="reference"]`)).length >= 4)
    assert.ok((await $$(`${dialog} [data-edge-kind="connection"]`)).length >= 4)
    assert.equal(await $(dialog).$('button=上游').isEnabled(), false)

    await $('[aria-label="搜索组合视图"]').setValue('消息投递')
    const result = $(`${dialog} .combined-board-list button`)
    await result.waitForExist()
    await result.click()
    await settle()
    const focusedTransform = await transform()
    await settle()
    assert.equal(await transform(), focusedTransform, '选择搜索结果后应保留聚焦视图')
    const focused = await browser.execute(() => {
      const canvas = document.querySelector('[aria-label="组合视图画板"]').getBoundingClientRect()
      const node = document.querySelector('.combined-node.selected').getBoundingClientRect()
      return {
        x: node.x + node.width / 2,
        y: node.y + node.height / 2,
        left: canvas.left,
        top: canvas.top,
        right: canvas.right,
        bottom: canvas.bottom,
        width: node.width,
      }
    })
    assert.ok(focused.x > focused.left && focused.x < focused.right)
    assert.ok(focused.y > focused.top && focused.y < focused.bottom)
    assert.ok(focused.width > 180, '搜索应放大目标组件')
    await $('[aria-label="清除组合视图搜索"]').click()
    await $(dialog).$('button=上游').click()
    assert.equal(await $(dialog).$('button=上游').getAttribute('aria-pressed'), 'true')
    await $(dialog).$('button=下游').click()
    assert.equal(await $(dialog).$('button=下游').getAttribute('aria-pressed'), 'true')
    await $(dialog).$('button=全部链路').click()
    assert.equal(await $(dialog).$('button=全部链路').getAttribute('aria-pressed'), 'true')
    const zoomBefore = await transform()
    await $('[aria-label="放大组合视图"]').click()
    assert.notEqual(await transform(), zoomBefore)
    await $('[aria-label="缩小组合视图"]').click()
    await $('[aria-label="适应组合视图"]').click()
    await browser.saveScreenshot(join(root, 'combined-diagram-desktop.png'))
    await browser.keys('Escape')
    await $(dialog).waitForExist({ reverse: true })
    assert.match(await $('[data-component-id="board-entry"]').getAttribute('class'), /selected/)
    assert.deepEqual(await snapshot(), before, '组合视图操作不得改写工作区')

    await $('button=组合视图').click()
    await $(sourceNode('order-app', 'history')).waitForExist()
    await $(sourceNode('order-app', 'history')).click()
    await $('.combined-selection').$('button=打开原图').click()
    await $(dialog).waitForExist({ reverse: true })
    await $('[aria-label="组件 历史订单受理"]').waitForExist()
    assert.equal(await $('button=引用画板').isEnabled(), false)
    await $('[aria-label="返回引用画板"]').click()
    await $('[aria-label="组件 注册应用"]').waitForExist()
    assert.deepEqual(await snapshot(), before, '来源跳转与返回不得改变图内容或版本')
    await writeFile(
      join(root, 'test-result.json'),
      JSON.stringify(
        {
          passed: true,
          checks: [
            '跨应用递归展开',
            '同图多版本与历史懒加载',
            '组件 ID 隔离',
            '搜索聚焦',
            '上下游追踪',
            '缩放与 Esc',
            '精确来源跳转',
            '工作区保持不变',
          ],
        },
        null,
        2,
      ),
    )
  })
})
