/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.SAY_CLEAR_MANAGEMENT_ARTIFACTS
const dataDir = join(root, 'workspace')
async function filesIn(directory) {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) Object.assign(result, await filesIn(path))
    else result[path] = (await stat(path)).mtimeMs
  }
  return result
}
const graph = (data, id) =>
  data.systems.flatMap((system) => system.contents).find((content) => content.id === id)?.diagram
async function saved() {
  await browser.waitUntil(() =>
    browser.execute(() => {
      const status = [...document.querySelectorAll('.save-status')].find(
        (el) => el.getClientRects().length,
      )
      return status?.classList.contains('saved')
    }),
  )
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
async function select(label, value) {
  await browser.execute(
    (label, value) => {
      const select = document.querySelector(`[aria-label="${label}"]`)
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    },
    label,
    value,
  )
}
async function manage() {
  await $('.iteration-nav').click()
  await $('#iteration-management-title').waitForDisplayed()
  assert.equal(await $('.iteration-nav').getAttribute('aria-current'), 'page')
  assert.equal(await $$('.project-item[aria-current="page"]').length, 0)
}
async function capture(name) {
  await browser.execute(async () => {
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 500)),
      (async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => {})),
        )
      })(),
    ])
  })
  await browser.saveScreenshot(join(root, name))
}
const card = (id) => $(`[data-iteration-board="${id}"]`)

describe('统一迭代管理桌面流程', () => {
  it('汇总、编辑生命周期、历史快照和重新启动', async () => {
    await saved()
    if (process.env.SAY_CLEAR_MANAGEMENT_PHASE === 'restore') {
      const expected = JSON.parse(await readFile(join(root, 'workspace-snapshot.json'), 'utf8'))
      assert.deepEqual(await saved(), expected)
      await manage()
      assert.match(await card('leads').getText(), /下一次注册迭代/)
      await $('.management-tabs').$('button*=历史现状').click()
      assert.match(await $('.management-list').getText(), /手机号注册与验证码体验/)
      await $('button=查看历史画板').click()
      assert.equal(await $('button=添加组件').isEnabled(), false)
      return
    }
    await manage()
    assert.equal(await $$('[data-iteration-board]').length, 1)
    assert.equal(
      JSON.parse(await readFile(join(dataDir, 'workspace.json'), 'utf8')).schemaVersion,
      3,
    )
    assert.equal(
      JSON.parse(await readFile(join(dataDir, 'migration-v2-backup/workspace.json'), 'utf8'))
        .schemaVersion,
      2,
    )
    const initial = await saved()
    const original = graph(initial, 'leads')
    const base = join(dataDir, 'systems/fixture-project/boards/leads')
    assert.deepEqual(
      JSON.parse(await readFile(join(base, 'current.json'), 'utf8')),
      original.iteration.baseline,
    )
    const untouchedCurrent = (await stat(join(base, 'current.json'))).mtimeMs
    const untouchedBaseline = (await stat(join(base, 'versions', `${original.iteration.id}.json`)))
      .mtimeMs
    const beforeRename = await filesIn(dataDir)
    await $('[aria-label="搜索迭代或画板"]').setValue('没有这条迭代')
    assert.equal(await $('.management-empty h2').getText(), '没有匹配的记录')
    await $('button=清除筛选').click()
    await select('筛选应用系统', 'second-app')
    assert.equal(await $$('[data-iteration-board]').length, 0)
    await $('button=清除筛选').click()
    await card('leads').$('button=改名').click()
    await $('[aria-label="迭代名称"]').setValue('   ')
    assert.equal(await $('button=保存名称').isEnabled(), false)
    await $('[aria-label="迭代名称"]').setValue('手机号注册与验证码体验')
    await $('button=保存名称').click()
    assert.deepEqual(graph(await saved(), 'leads').iteration, {
      ...original.iteration,
      name: '手机号注册与验证码体验',
    })
    const afterRename = await filesIn(dataDir)
    assert.deepEqual(
      Object.keys(afterRename)
        .filter((path) => afterRename[path] !== beforeRename[path])
        .sort(),
      [join(base, 'index.json'), join(base, 'iterations', `${original.iteration.id}.json`)].sort(),
    )
    assert.equal((await stat(join(base, 'current.json'))).mtimeMs, untouchedCurrent)
    assert.equal(
      (await stat(join(base, 'versions', `${original.iteration.id}.json`))).mtimeMs,
      untouchedBaseline,
    )
    await card('leads').$('button*=查看变更').click()
    assert.equal(await $$('.management-changes details').length, 14)
    await $('.management-changes details').click()
    await capture('changes.png')
    await $('button=打开迭代画板').click()
    assert.match(await $('.iteration-context').getText(), /手机号注册与验证码体验/)
    assert.equal(await $('button=添加组件').isEnabled(), true)
    // Establish an undo entry, then ensure a lifecycle change in management clears it.
    await $('[aria-label="组件 注册页面"]').click()
    await $('button=编辑组件').click()
    await $('[aria-label="组件说明"]').setValue('手机号验证码 5 分钟有效')
    await $('button=保存组件').click()
    await manage()
    await capture('iteration-management.png')
    await card('leads').$('button=完成迭代').click()
    await $('button=取消').click()
    assert.ok(graph(await saved(), 'leads').iteration)
    await card('leads').$('button=完成迭代').click()
    await $('button=确认完成并更新现状').click()
    const published = graph(await saved(), 'leads')
    assert.equal(published.iteration, undefined)
    assert.equal(published.history[0].snapshot, undefined)
    assert.deepEqual(
      await browser.execute(
        (id) => window.__TAURI__.core.invoke('load_history', { boardId: 'leads', versionId: id }),
        published.history[0].id,
      ),
      original.iteration.baseline,
    )
    await $('button=返回画板').click()
    assert.equal(await $('[aria-label="撤销画板操作"]').isEnabled(), false)
    await manage()
    await $('.management-tabs').$('button*=历史现状').click()
    await capture('history.png')
    await $('button=查看历史画板').click()
    assert.equal(await $('button=添加组件').isEnabled(), false)
    await browser.waitUntil(
      async () =>
        (await $$('.diagram-node').length) === original.iteration.baseline.components.length,
    )
    await manage()
    await $('.management-intro').$('button=创建迭代').click()
    await select('迭代所属画板', 'sales')
    await $('[aria-label="迭代名称"]').setValue('销售管理优化')
    await $('button=开始迭代').click()
    assert.equal(await card('sales').$('button=完成迭代').isEnabled(), false)
    await $('.management-intro').$('button=创建迭代').click()
    assert.equal(await $('option[value="sales"]').isEnabled(), false)
    await select('迭代所属画板', 'leads')
    await $('[aria-label="迭代名称"]').setValue('下一次注册迭代')
    await $('button=开始迭代').click()
    assert.equal(await $$('[data-iteration-board]').length, 2)
    await card('sales').$('button=打开画板').click()
    await $('button=添加组件').click()
    await $('.diagram-library button').click()
    await $('button=保存组件').click()
    const beforeDiscard = graph(await saved(), 'sales')
    assert.ok(beforeDiscard.components.length)
    await manage()
    await $('[aria-label="放弃迭代 销售管理优化"]').click()
    await $('button=取消').click()
    assert.ok(graph(await saved(), 'sales').iteration)
    await $('[aria-label="放弃迭代 销售管理优化"]').click()
    await $('button=放弃并恢复现状').click()
    const result = await saved()
    assert.equal(graph(result, 'sales').iteration, undefined)
    assert.deepEqual(graph(result, 'sales').components, beforeDiscard.iteration.baseline.components)
    assert.ok(graph(result, 'leads').iteration)
    await writeFile(join(root, 'workspace-snapshot.json'), JSON.stringify(result, null, 2))
    await browser.setWindowSize(1060, 720)
    await capture('iteration-management-compact.png')
  })
})
