/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.SAY_CLEAR_COMPOSITION_ARTIFACTS
async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
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
async function capture(name) {
  await browser.execute(async () => {
    await Promise.race([
      new Promise((r) => setTimeout(r, 500)),
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    ])
  })
  await browser.saveScreenshot(join(root, name))
}
const content = (w, id) => w.systems.flatMap((s) => s.contents).find((c) => c.id === id)
async function open(id) {
  await $(`[data-board-id="${id}"] .project-item`).click()
}
describe('画板逐层聚合与跨应用引用', () => {
  it('聚合、来源跳转、固定历史、变更汇总与重启恢复', async () => {
    const before = await snapshot()
    if (process.env.SAY_CLEAR_COMPOSITION_PHASE === 'restore') {
      assert.deepEqual(before, JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')))
      assert.match(await $('.sidebar').getText(), /下级 1 张图有变更/)
      await capture('composition-desktop.png')
      return
    }
    assert.match(await $('[data-board-id="user-app"]').getText(), /下级 1 张图有变更/)
    const original = structuredClone(before.systems[0].contents.slice(1))
    await $('button=聚合子图').click()
    await $('[aria-label="新画板名称"]').setValue('用户注册')
    await $('button=创建聚合图').click()
    let w = await snapshot()
    const group = w.activeNodeId
    assert.equal(content(w, group).diagram.components.filter((c) => c.reference).length, 2)
    assert.deepEqual(
      w.systems[0].contents.filter((c) => original.some((p) => p.id === c.id)),
      original,
    )
    await $('button=新建子图').click()
    await $('[aria-label="新画板名称"]').setValue('发送通知')
    await $('button=创建画板').click()
    await open(group)
    await $('button=聚合子图').click()
    await $('[aria-label="新画板名称"]').setValue('注册处理链')
    await $('button=创建聚合图').click()
    w = await snapshot()
    const deep = w.activeNodeId
    assert.equal(
      w.systems[0].architecture.boards.find((b) => b.id === original[0].id).parentId,
      deep,
    )
    assert.equal(w.systems[0].architecture.boards.find((b) => b.id === deep).parentId, group)
    await $('button=引用画板').click()
    await select('引用来源应用', 'account-app')
    assert.match(await $('[aria-label="引用来源画板"]').getText(), /账户应用/)
    await select('引用入口组件', 'board-entry')
    await $('button=添加引用').click()
    w = await snapshot()
    const ref = content(w, deep).diagram.components.find(
      (c) => c.reference?.boardId === 'account-app',
    )
    await $(`[data-component-id="${ref.id}"] .diagram-reference-link`).click()
    assert.match(await $('.breadcrumb').getText(), /账户应用/)
    await $('button=编辑组件').click()
    await $('[aria-label="组件名称"]').setValue('账户开户能力')
    await $('button=保存组件').click()
    await $('[aria-label="返回引用画板"]').click()
    assert.equal(
      await $(`[data-component-id="${ref.id}"]`).getAttribute('data-reference-status'),
      'changed',
    )
    await $(`[data-component-id="${ref.id}"]`).click()
    await $('button=更新引用').click()
    w = await snapshot()
    const history = content(w, 'account-app').diagram.history[0].id
    await select('引用来源版本', `history:${history}`)
    await browser.waitUntil(async () =>
      (await $('[aria-label="引用入口组件"]').getText()).includes('账户应用'),
    )
    await select('引用入口组件', 'board-entry')
    await $('dialog').$('button=更新引用').click()
    assert.equal(
      await $(`[data-component-id="${ref.id}"]`).getAttribute('data-reference-status'),
      'ok',
    )
    await $(`[data-component-id="${ref.id}"] .diagram-reference-link`).click()
    await $('[aria-label="组件 账户应用"]').waitForExist()
    assert.equal(await $('button=引用画板').isEnabled(), false)
    await $('[aria-label="返回引用画板"]').click()
    await $('[aria-label="取消选择"]').click()
    await $('button=自动布局').click()
    await $('[aria-label="适应画板"]').click()
    await capture('composition-desktop.png')
    await writeFile(join(root, 'snapshot.json'), JSON.stringify(await snapshot(), null, 2))
    assert.ok((await $$('.diagram-node').length) >= 4)
  })
})
