/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { diskBoard } from './helpers/storage-files.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const sample = JSON.parse(
  await readFile(new URL('./fixtures/product-design.json', import.meta.url), 'utf8'),
)
const artifactDir = process.env.SAY_CLEAR_PRODUCT_ARTIFACTS
const dataDir = process.env.SAY_CLEAR_DATA_DIR
const fieldTypes = { text: '文本', number: '数字', boolean: '是 / 否' }
async function choose(label, text) {
  // Embedded driver option.click() does not select in WebKit; run the native change path.
  await browser.execute(
    (label, text) => {
      const input = document.querySelector(`[aria-label="${label}"]`)
      input.value = [...input.options].find((o) => o.text === text).value
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    label,
    text,
  )
}
async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
async function importDiagram(graph) {
  await $('button=JSON').click()
  await $('[aria-label="系统图 JSON"]').setValue(JSON.stringify(graph))
  await $('button=校验并替换画板').click()
}

async function screenshot(filename) {
  // Wait for WebKit to paint the selected scene and finish panel transitions.
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
  await browser.saveScreenshot(join(artifactDir, filename))
}

// Run twice, in separate application processes, against a retained example workspace.
describe('产品设计场景组件集', () => {
  it('六种组件的元数据、约束与桌面保存恢复', async () => {
    await $('.save-status.saved').waitForExist()
    if (process.env.SAY_CLEAR_PRODUCT_PHASE === 'restore') {
      const expected = JSON.parse(
        await readFile(join(artifactDir, 'workspace-snapshot.json'), 'utf8'),
      )
      const restored = await snapshot()
      assert.deepEqual(restored, expected)
      assert.equal(await $$('.diagram-node').length, 6)
      assert.equal(await $$('.diagram-edge').length, 6)
      await $('[aria-label="组件 注册结果反馈"]').click()
      assert.match(await $('.diagram-metadata').getText(), /注册成功，欢迎使用/)
      assert.match(await $('.diagram-metadata').getText(), /展示秒数/)
      await screenshot('product-design-metadata.png')
      await $('[aria-label="取消选择"]').click()
      await $('[aria-label="适应画板"]').click()
      await screenshot('product-design-diagram.png')
      await $('button=设置').click()
      await $('.settings-menu').$('button=组件设置').click()
      await $('[aria-label="组件场景"]').$('button*=产品设计').click()
      assert.equal(await $$('.catalog-template').length, 6)
      await screenshot('product-design-components.png')
      await $('button=返回工作空间').click()
      return
    }

    await $('button=设置').click()
    await $('.settings-menu').$('button=组件设置').click()
    await $('button=新建场景').click()
    await $('[aria-label="场景名称"]').setValue(sample.name)
    await $('[aria-label="场景说明"]').setValue(sample.description)
    await $('button=保存场景').click()
    for (const template of sample.components) {
      await $('button=添加组件模板').click()
      await $('[aria-label="组件名称"]').setValue(template.name)
      await choose('模板基础类型', template.typeLabel)
      await $('[aria-label="组件说明"]').setValue(template.description)
      await $('[aria-label="输入 1 名称"]').setValue(template.input)
      await $('[aria-label="输出 1 名称"]').setValue(template.output)
      for (const [i, field] of template.fields.entries()) {
        await $('button=添加属性').click()
        await $(`[aria-label="属性 ${i + 1} 名称"]`).setValue(field.name)
        await choose(`属性 ${i + 1} 类型`, fieldTypes[field.type])
        if (field.required) await $(`[aria-label="属性 ${i + 1} 必填"]`).click()
        if (field.type === 'boolean')
          await choose(`属性 ${i + 1} 默认值`, field.defaultValue === 'true' ? '是' : '否')
        else if (field.defaultValue)
          await $(`[aria-label="属性 ${i + 1} 默认值"]`).setValue(field.defaultValue)
      }
      await $('button=保存组件模板').click()
      await $(`[aria-label="编辑组件模板 ${template.name}"]`).waitForExist()
    }
    await $('button=返回工作空间').click()
    await $('button=创建应用系统').click()
    await $('dialog .architecture-fields input').setValue(sample.exampleName)
    await $('dialog .architecture-fields textarea').setValue(
      '产品设计场景验收：从新用户访问注册页，到填写、校验、创建账号和展示结果。',
    )
    await $('dialog button[type="submit"]').click()
    // New application boards include a built-in public entry. Remove it before
    // choosing a custom scene whose component templates do not include that entry.
    await $('[data-component-id="board-entry"]').click()
    await $('[aria-label="删除组件"]').click()
    await choose('画板场景', sample.name)
    for (const template of sample.components) {
      await $('button=添加组件').click()
      assert.deepEqual(
        await $$('.diagram-library button').map(async (b) =>
          (await b.getAttribute('aria-label')).replace('添加组件 ', ''),
        ),
        sample.components.map((t) => t.name),
      )
      await $(`[aria-label="添加组件 ${template.name}"]`).click()
      await $('[aria-label="组件名称"]').setValue(template.example.name)
      await $('[aria-label="组件说明"]').setValue(template.example.description)
      for (const [i, field] of template.fields.entries()) {
        assert.equal(
          await $(`[aria-label="组件属性 ${field.name}"]`).getValue(),
          field.defaultValue,
        )
        if (template.name === '用户角色' && i === 0) {
          await $('button=保存组件').click()
          assert.equal(await $('dialog').isExisting(), true, '必填项缺失时必须停留在编辑器')
          assert.equal(
            await browser.execute(
              () =>
                document.querySelector('[aria-label="组件属性 用户目标"]').validity.valueMissing,
            ),
            true,
          )
        }
        if (field.type === 'boolean')
          await choose(
            `组件属性 ${field.name}`,
            template.example.values[i] === 'true' ? '是' : '否',
          )
        else await $(`[aria-label="组件属性 ${field.name}"]`).setValue(template.example.values[i])
      }
      await $('button=保存组件').click()
      await $(`[aria-label="组件 ${template.example.name}"]`).waitForExist()
    }
    const before = await snapshot()
    const system = before.systems.find((s) => s.architecture.name === sample.exampleName)
    const graph = system.contents[0].diagram
    graph.components.forEach((c) => {
      c.position = sample.components.find((t) => t.example.name === c.name).example.position
    })
    graph.connections = sample.connections.map((e, i) => {
      const source = graph.components.find((c) => c.name === e.source)
      const target = graph.components.find((c) => c.name === e.target)
      return {
        id: `product-design-edge-${i}`,
        name: e.name,
        type: e.type,
        description: '',
        sourceId: source.id,
        targetId: target.id,
        sourcePortId: e.type === 'data' ? source.outputs[0].id : null,
        targetPortId: e.type === 'data' ? target.inputs[0].id : null,
        protocol: '',
        condition: e.condition,
      }
    })
    await importDiagram(graph)
    await $('dialog').waitForExist({ reverse: true })
    assert.equal(await $$('.diagram-edge').length, 6)
    const catalog = before.componentCatalog
    const scene = catalog.scenarios.find((s) => s.name === sample.name)
    const invalids = []
    const foreign = structuredClone(graph)
    foreign.components[0].templateId = 'builtin-service'
    foreign.components[0].type = 'service'
    invalids.push([foreign, /规定的组件/])
    const wrongNumber = structuredClone(graph)
    const feedback = wrongNumber.components.find((c) => c.name === '注册结果反馈')
    const numberField = scene.components
      .find((t) => t.name === '结果反馈')
      .fields.find((f) => f.type === 'number')
    feedback.metadata[numberField.id] = '三秒'
    invalids.push([wrongNumber, /有效数字/])
    const wrongBoolean = structuredClone(graph)
    const role = wrongBoolean.components.find((c) => c.name === '新用户')
    const booleanField = scene.components
      .find((t) => t.name === '用户角色')
      .fields.find((f) => f.type === 'boolean')
    role.metadata[booleanField.id] = 'yes'
    invalids.push([wrongBoolean, /是或否/])
    const undeclared = structuredClone(graph)
    undeclared.components[0].metadata.unregistered = '未定义'
    invalids.push([undeclared, /未定义的属性/])
    for (const [invalid, message] of invalids) {
      await importDiagram(invalid)
      await $('dialog .form-error').waitForExist()
      assert.match(await $('dialog .form-error').getText(), message)
      await $('dialog [aria-label="关闭弹窗"]').click()
      assert.equal(await $$('.diagram-node').length, 6)
      assert.equal(await $$('.diagram-edge').length, 6)
    }
    await choose('画板场景', 'Web 应用')
    assert.equal(await $('[aria-label="画板场景"]').getValue(), scene.id)

    await $('button=设置').click()
    await $('.settings-menu').$('button=组件设置').click()
    await $('[aria-label="组件场景"]').$('button*=产品设计').click()
    await $('[aria-label="删除组件模板 页面"]').click()
    await $('button=确认删除').click()
    await $('dialog .form-error').waitForExist()
    assert.match(await $('dialog .form-error').getText(), /仍在使用/)
    await $('dialog').$('button=取消').click()
    await $('button=返回工作空间').click()
    const final = await snapshot()
    const finalGraph = final.systems.find((s) => s.architecture.id === system.architecture.id)
      .contents[0].diagram
    assert.deepEqual(finalGraph, graph, '拒绝非法修改后保留完整图和元数据')
    assert.deepEqual(
      (await diskBoard(dataDir, system.architecture.id, system.contents[0].id)).diagram,
      graph,
    )
    await writeFile(join(artifactDir, 'workspace-snapshot.json'), JSON.stringify(final, null, 2))
    await writeFile(
      join(artifactDir, 'product-design-catalog.json'),
      JSON.stringify(catalog, null, 2),
    )
    await writeFile(
      join(artifactDir, 'product-design-diagram.json'),
      JSON.stringify(graph, null, 2),
    )
    assert.equal(
      (await snapshot()).componentCatalog.scenarios.find((s) => s.name === sample.name).components
        .length,
      6,
    )
    console.log(`产品设计示例保存于 ${resolve(artifactDir)}`)
  })
})
