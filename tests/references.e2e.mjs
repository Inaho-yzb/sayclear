/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const dir = process.env.SAY_CLEAR_REFERENCE_ARTIFACTS
const node = '[data-component-id="registration-reference"]'
const board = (w) =>
  w.systems.flatMap((s) => s.contents).find((c) => c.id === 'registration-messaging').diagram
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
  await browser.saveScreenshot(join(dir, name))
}
describe('跨画板引用', () => {
  it('创建、跳转、更新、来源失效与恢复', async () => {
    await $('.save-status.saved').waitForExist()
    if (process.env.SAY_CLEAR_REFERENCE_PHASE === 'restore') {
      assert.deepEqual(
        await snapshot(),
        JSON.parse(await readFile(join(dir, 'workspace-snapshot.json'), 'utf8')),
      )
      assert.equal(await $(node).getAttribute('data-reference-status'), 'missing')
      assert.equal(await $$('[data-reference-warning="true"]').length, 1)
      await $('button=现状').click()
      assert.equal(await $$('.diagram-node').length, 2)
      assert.equal(await $('button=引用画板').isEnabled(), false)
      await $(node).click()
      assert.equal(await $('button=更新引用').isEnabled(), false)
      return
    }
    assert.equal(await $$('.diagram-node').length, 7)
    const original = board(await snapshot())
    await $('button=引用画板').click()
    assert.equal(await $('[aria-label="引用来源版本"]').getValue(), 'current')
    assert.match(await $('dialog').getText(), /尚无对外开放/)
    await select('引用来源版本', 'iteration')
    await select('引用入口组件', 'signup')
    await $('[aria-label="引用输出 注册成功"]').click()
    await $('button=添加引用').click()
    assert.equal(await $$('.diagram-node').length, 8)
    const added = board(await snapshot()).components.find(
      (c) => !original.components.some((n) => n.id === c.id),
    )
    assert.equal(added.type, 'capability')
    assert.equal(added.outputs[0].name, '注册成功')
    await $('[aria-label="删除组件"]').click()
    assert.equal(await $$('.diagram-node').length, 7)
    await $(`${node} .diagram-reference-link`).click()
    assert.equal(await $$('.diagram-node').length, 11)
    await $('button=编辑组件').click()
    await $('[aria-label="组件名称"]').setValue('用户注册（已更新）')
    await $('button=保存组件').click()
    await $('[aria-label="返回引用画板"]').click()
    assert.equal(await $(node).getAttribute('data-reference-status'), 'changed')
    await $(node).click()
    assert.match(await $('[aria-label="系统图属性"]').getText(), /来源定义已变化/)
    await $('button=更新引用').click()
    assert.match(await $('dialog').getText(), /用户注册 → 用户注册（已更新）/)
    await $('dialog').$('button=更新引用').click()
    assert.equal(await $(node).getAttribute('data-reference-status'), 'ok')
    const updated = board(await snapshot())
    assert.deepEqual(updated.iteration.baseline, original.iteration.baseline)
    assert.deepEqual(updated.connections, original.connections)
    await $('[aria-label="取消选择"]').click()
    await $('[aria-label="适应画板"]').click()
    await capture('reference-flow.png')
    await $(`${node} .diagram-reference-link`).click()
    await $('button=画板概览').click()
    await $('button*=被引用').click()
    assert.match(await $('dialog').getText(), /注册消息与账户初始化/)
    await $('[aria-label="关闭弹窗"]').click()
    await $('[aria-label="组件 注册成功"]').click()
    await $('button=编辑组件').click()
    await $('[aria-label="允许其他画板引用"]').click()
    await $('button=保存组件').click()
    await $('[aria-label="返回引用画板"]').click()
    assert.equal(await $(node).getAttribute('data-reference-status'), 'missing')
    assert.equal(await $$('[data-reference-warning="true"]').length, 1)
    assert.equal(board(await snapshot()).connections.length, 5)
    await $(node).click()
    assert.match(await $('[aria-label="系统图属性"]').getText(), /对外输出已删除或不再开放/)
    await capture('reference-warning.png')
    await writeFile(join(dir, 'workspace-snapshot.json'), JSON.stringify(await snapshot(), null, 2))
  })
})
