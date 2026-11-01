/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { historicalSnapshot } from './helpers/storage-files.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dir = process.env.SAY_CLEAR_VALIDATION_ARTIFACTS
async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
function diagram(workspace) {
  return workspace.systems.flatMap((s) => s.contents).find((c) => c.diagram)?.diagram
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await browser.saveScreenshot(join(dir, name))
      return
    } catch (error) {
      if (attempt === 2) throw error
      await browser.pause(500)
    }
  }
}

describe('校验节点完整流程', () => {
  it('多规则、策略、导入保护、历史与跨进程恢复', async () => {
    await $('.save-status.saved').waitForExist()
    assert.equal(
      await browser.execute(() => window.__TAURI__.core.invoke('get_data_directory')),
      join(dir, 'workspace'),
    )
    if (process.env.SAY_CLEAR_VALIDATION_PHASE === 'restore') {
      const expected = JSON.parse(await readFile(join(dir, 'workspace-snapshot.json'), 'utf8'))
      assert.deepEqual(await snapshot(), expected)
      await $('[aria-label="适应画板"]').click()
      await $('[aria-label="组件 注册信息校验"]').click()
      assert.match(await $('[aria-label="校验规则详情"]').getText(), /任一满足/)
      assert.match(await $('[aria-label="校验规则详情"]').getText(), /首条通过即停止/)
      await select('查看历史现状', diagram(expected).history[0].id)
      await $('[aria-label="组件 注册信息校验"]').click()
      assert.match(await $('[aria-label="校验规则详情"]').getText(), /全部满足/)
      assert.equal(await $('button=编辑组件').isEnabled(), false)
      await capture('validation-history.png')
      return
    }
    await $('button=添加组件').click()
    await $('[aria-label="添加组件 校验"]').click()
    await $('[aria-label="组件名称"]').setValue('注册信息校验')
    const names = ['邮箱格式正确', '密码不少于 8 位', '已同意用户协议']
    const conditions = ['邮箱符合有效邮箱格式', '密码长度至少为 8 个字符', '用户已勾选用户协议']
    for (let i = 0; i < names.length; i++) {
      await $('button=添加规则').click()
      await $(`[aria-label="规则 ${i + 1} 名称"]`).setValue(names[i])
      await $(`[aria-label="规则 ${i + 1} 判断条件"]`).setValue(conditions[i])
      await $(`[aria-label="规则 ${i + 1} 失败提示"]`).setValue(`请检查：${names[i]}`)
    }
    await $('[aria-label="规则 1 适用条件"]').setValue('注册方式为邮箱')
    await $('[aria-label="下移规则 1"]').click()
    assert.equal(await $('[aria-label="规则 1 名称"]').getValue(), names[1])
    await $('[aria-label="上移规则 2"]').click()
    assert.equal(await $('[aria-label="规则 1 名称"]').getValue(), names[0])
    await $('button=添加规则').click()
    await $('[aria-label="删除规则 4"]').click()
    await select('校验检查方式', 'stopWhenDecided')
    await browser.execute(() => {
      document.querySelector('dialog').scrollTop = 0
    })
    await capture('validation-editor.png')
    await $('button=保存组件').click()
    await $('dialog').waitForExist({ reverse: true })
    let g = diagram(await snapshot())
    const original = structuredClone(g)
    assert.deepEqual(
      g.components[0].validation.rules.map((r) => r.name),
      names,
    )
    assert.equal(g.components[0].validation.strategy, 'stopWhenDecided')
    assert.deepEqual(
      g.components[0].outputs.map((p) => p.name),
      ['通过', '不通过'],
    )
    await $('[aria-label="适应画板"]').click()
    await $('[aria-label="组件 注册信息校验"]').click()
    assert.match(await $('.validation-node-summary').getText(), /3 条规则/)
    assert.match(await $('[aria-label="校验规则详情"]').getText(), /首条失败即停止/)
    await capture('validation-node.png')
    // Verify the two exits can be wired separately to the same result component.
    await $('button=添加组件').click()
    await $('[aria-label="添加组件 行为"]').click()
    await $('[aria-label="组件名称"]').setValue('处理校验结果')
    await $('button=保存组件').click()
    g = diagram(await snapshot())
    const result = g.components.find((c) => c.type === 'action')
    for (let i = 0; i < 2; i++) {
      await $('button=添加连接').click()
      await $('[aria-label="连接名称"]').setValue(i ? '不通过分支' : '通过分支')
      await select('连接类型', 'control')
      await select('起点组件', original.components[0].id)
      await select('终点组件', result.id)
      await select('输出端口', original.components[0].outputs[i].id)
      await $('button=保存连接').click()
      await $('dialog').waitForExist({ reverse: true })
    }
    assert.equal(diagram(await snapshot()).connections.length, 2)
    // Invalid imported rules must leave the existing graph intact.
    const beforeImport = diagram(await snapshot())
    await $('button=JSON').click()
    const invalid = structuredClone(beforeImport)
    invalid.components[0].validation.rules[1].id = invalid.components[0].validation.rules[0].id
    await $('[aria-label="系统图 JSON"]').setValue(JSON.stringify(invalid))
    await $('button=校验并替换画板').click()
    assert.match(await $('.form-error').getText(), /规则 ID 不能重复/)
    await $('[aria-label="关闭弹窗"]').click()
    assert.deepEqual(diagram(await snapshot()), beforeImport)
    await $('button=创建迭代').click()
    await $('[aria-label="迭代名称"]').setValue('调整整体校验条件')
    await $('button=开始迭代').click()
    await $('[aria-label="适应画板"]').click()
    await $('[aria-label="组件 注册信息校验"]').click()
    await $('button=编辑组件').click()
    await select('整体通过条件', 'any')
    await $('[aria-label="下移规则 1"]').click()
    await $('button=保存组件').click()
    const modified = diagram(await snapshot())
    assert.equal(modified.components[0].validation.passCondition, 'any')
    assert.deepEqual(modified.iteration.baseline, {
      schemaVersion: 2,
      scenarioId: beforeImport.scenarioId,
      components: beforeImport.components,
      connections: beforeImport.connections,
    })
    await $('[aria-label="撤销画板操作"]').click()
    assert.equal(diagram(await snapshot()).components[0].validation.passCondition, 'all')
    await $('[aria-label="重做画板操作"]').click()
    assert.equal(diagram(await snapshot()).components[0].validation.passCondition, 'any')
    await $('button*=变更清单').click()
    await $('.change-list-item summary').click()
    assert.match(await $('[aria-label="迭代变更清单"]').getText(), /校验配置/)
    await capture('validation-changes.png')
    await $('[aria-label="关闭变更清单"]').click()
    await $('button=现状').click()
    await $('[aria-label="组件 注册信息校验"]').click()
    assert.equal(await $('button=编辑组件').isEnabled(), false)
    await $('button=本次迭代').click()
    await $('button=更新为现状').click()
    await $('button=确认更新现状').click()
    const saved = await snapshot()
    assert.equal(diagram(saved).history.length, 1)
    assert.equal(
      (await historicalSnapshot(browser, saved, diagram(saved).history[0].id)).components[0]
        .validation.passCondition,
      'all',
    )
    await writeFile(join(dir, 'workspace-snapshot.json'), JSON.stringify(saved, null, 2))
    assert.equal(await $$('.diagram-node').length, 2)
  })
})
