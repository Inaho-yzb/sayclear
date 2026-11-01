/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { diskBoard } from './helpers/storage-files.mjs'
import { readFile, writeFile, access, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The embedded WebView driver clicks <option> without selecting it. Dispatch a
// native change after selecting its value, keeping React validation and saving in the path.
async function selectOption(label, text) {
  await browser.execute(
    (label, text) => {
      const select = document.querySelector(`[aria-label="${label}"]`)
      select.value = [...select.options].find((option) => option.text === text).value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    },
    label,
    text,
  )
}

describe('Tauri 桌面工作区', () => {
  it('以系统图为主工作区，保留迁移数据并验证重启恢复', async () => {
    const saved = $('.save-status.saved')
    await saved.waitForExist()
    assert.equal(await $('.chat-panel').isExisting(), false)
    assert.equal(await $('.document-panel').isExisting(), false)
    assert.equal(await $('.workspace-view-tabs').isExisting(), false)
    assert.equal(await $('[aria-label="描述你的需求"]').isExisting(), false)
    const dataDirectory =
      process.env.SAY_CLEAR_E2E_PHASE === 'edit'
        ? process.env.SAY_CLEAR_DATA_DIR
        : process.env.SAY_CLEAR_PICK_DIRECTORY
    if (process.env.SAY_CLEAR_E2E_PHASE !== 'edit') {
      await $('button=设置').click()
      await $('[aria-label="当前数据目录"]').waitForExist()
      await browser.waitUntil(
        async () =>
          (await $('[aria-label="当前数据目录"]').getValue()) === (await realpath(dataDirectory)),
      )
      await $('button=返回工作空间').click()
    }
    if (process.env.SAY_CLEAR_E2E_PHASE === 'empty') {
      await $('h1=还没有应用系统').waitForExist()
      const index = JSON.parse(await readFile(join(dataDirectory, 'workspace.json'), 'utf8'))
      assert.deepEqual(index.systemIds, [])
      assert.equal(index.activeNodeId, null)
      assert.equal(await $('nav').$$('.project-item').length, 0)
      await $('.new-project').click()
      await $('dialog .architecture-fields input').setValue('空工作区重新创建')
      await $('dialog button[type="submit"]').click()
      await $('[aria-label="空工作区重新创建 系统图"]').waitForExist()
      await saved.waitForExist()
      return
    }
    if (process.env.SAY_CLEAR_E2E_PHASE === 'restore') {
      await $('[aria-label="线索录入 系统图"]').waitForExist()
      await $('[aria-label="组件 注册申请表单"]').waitForExist()
      assert.equal(await $$('.diagram-node').length, 4)
      assert.equal(await $$('.diagram-edge').length, 4)
      assert.match(await $('.breadcrumb').getText(), /外部更新的系统/)
      await $('nav').$('button*=兼容性验证').click()
      await $('[aria-label="兼容性验证 🚀 系统图"]').waitForExist()
      const legacyProject = JSON.parse(
        await readFile(join(process.env.SAY_CLEAR_LEGACY_DIR, 'workspace.json'), 'utf8'),
      ).projects[0]
      const retained = await diskBoard(dataDirectory, 'fixture-project', 'fixture-project')
      assert.deepEqual(retained.sections, legacyProject.sections)
      assert.deepEqual(retained.messages, legacyProject.messages)
      assert.equal(retained.revision, legacyProject.revision)
      assert.equal(retained.diagram.components[0].name, '财务审批')
      assert.ok(Object.values(retained.diagram.components[0].metadata).includes('财务部'))
      const restoredCatalog = JSON.parse(
        await readFile(join(dataDirectory, 'workspace.json'), 'utf8'),
      ).componentCatalog
      assert.ok(restoredCatalog.scenarios.some((s) => s.name === '审批流程'))
      assert.match(await $('[aria-label="画板场景"]').getText(), /审批流程/)
      await $('[aria-label="组件 财务审批"]').click()
      assert.match(await $('.diagram-metadata').getText(), /财务部/)

      await $('nav').$('button*=线索录入').click()
      await saved.waitForExist()
      const indexPath = join(dataDirectory, 'workspace.json')
      const index = JSON.parse(await readFile(indexPath, 'utf8'))
      const systemId = index.systemIds.find((id) => id !== 'fixture-project')
      const deleteCurrent = $('[aria-label="删除应用系统 外部更新的系统"]')
      await deleteCurrent.click()
      assert.match(await $('.delete-scope').getText(), /2 张下级画板、3 张系统图/)
      await $('dialog').$('button=取消').click()
      assert.equal(await deleteCurrent.isExisting(), true)

      // A conflicting external edit must leave the system visible and display the failure.
      const fixturePath = join(dataDirectory, 'systems/fixture-project/architecture.json')
      const external = JSON.parse(await readFile(fixturePath, 'utf8'))
      external.description += ' 外部编辑'
      await writeFile(fixturePath, JSON.stringify(external, null, 2))
      await $('[aria-label="删除应用系统 兼容性验证 🚀"]').click()
      await $('button=确认删除').click()
      await $('dialog .form-error').waitForExist()
      assert.match(await $('dialog .form-error').getText(), /外部修改/)
      await access(fixturePath)
      await $('dialog').$('button=取消').click()
      await $('[aria-label="重新读取本地数据"]').click()
      await $('button=重新读取并替换').click()
      await saved.waitForExist()

      // Delete the unselected system while preserving the current module.
      await $('[aria-label="删除应用系统 兼容性验证 🚀"]').click()
      await $('button=确认删除').click()
      await $('[aria-label="删除应用系统 兼容性验证 🚀"]').waitForExist({ reverse: true })
      await $('[aria-label="线索录入 系统图"]').waitForExist()
      await saved.waitForExist()
      await assert.rejects(access(join(dataDirectory, 'systems/fixture-project')))
      const remaining = JSON.parse(await readFile(indexPath, 'utf8'))
      assert.deepEqual(remaining.systemIds, [systemId])
      assert.equal(remaining.activeNodeId, index.activeNodeId)

      // Delete the last system from one of its modules.
      await deleteCurrent.click()
      await browser.saveScreenshot(resolve('artifacts/delete-system-dialog.png'))
      await $('button=确认删除').click()
      await $('h1=还没有应用系统').waitForExist()
      await saved.waitForExist()
      await assert.rejects(access(join(dataDirectory, 'systems', systemId)))
      const empty = JSON.parse(await readFile(indexPath, 'utf8'))
      assert.deepEqual(empty.systemIds, [])
      assert.equal(empty.activeNodeId, null)
      await browser.saveScreenshot(resolve('artifacts/empty-workspace.png'))
      return
    }

    await $('[aria-label="兼容性验证 🚀 系统图"]').waitForExist()
    await browser.saveScreenshot(resolve('artifacts/tauri-desktop.png'))
    assert.equal(await browser.execute(() => typeof window.require), 'undefined')
    assert.equal(
      await browser.execute(() => document.documentElement.dataset.platform),
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    )

    const denied = await browser.execute(async () => {
      try {
        await window.__TAURI__.core.invoke('plugin:window|set_title', {
          label: 'main',
          title: '不允许修改',
        })
        return false
      } catch {
        return true
      }
    })
    assert.equal(denied, true, '未授权窗口命令必须被拒绝')

    // Configure a scenario and its component metadata through Settings.
    await $('button=设置').click()
    await $('.settings-menu').$('button=组件设置').click()
    await $('button=新建场景').click()
    await $('[aria-label="场景名称"]').setValue('审批流程')
    await $('[aria-label="场景说明"]').setValue('只允许使用规定的审批任务组件。')
    await $('button=保存场景').click()
    await $('button=添加组件模板').click()
    await $('[aria-label="组件名称"]').setValue('审批任务')
    await selectOption('模板基础类型', '行为')
    await $('[aria-label="组件说明"]').setValue('按责任人处理审批申请。')
    await $('button=添加属性').click()
    await $('[aria-label="属性 1 名称"]').setValue('负责人')
    await $('[aria-label="属性 1 必填"]').click()
    await $('button=添加属性').click()
    await $('[aria-label="属性 2 名称"]').setValue('超时分钟')
    await selectOption('属性 2 类型', '数字')
    await $('[aria-label="属性 2 默认值"]').setValue('30')
    await $('button=保存组件模板').click()
    await $('[aria-label="编辑组件模板 审批任务"]').waitForExist()
    await browser.saveScreenshot(resolve('artifacts/component-settings.png'))
    await $('button=返回工作空间').click()
    await selectOption('画板场景', '审批流程')
    await $('button=添加组件').click()
    assert.equal(await $$('.diagram-library button').length, 1)
    await $('[aria-label="添加组件 审批任务"]').click()
    assert.equal(
      await browser.execute(() => document.querySelector('[aria-label="组件类型"]').readOnly),
      true,
    )
    assert.equal(await $('[aria-label="组件属性 超时分钟"]').getValue(), '30')
    await $('[aria-label="组件名称"]').setValue('财务审批')
    await $('[aria-label="组件属性 负责人"]').setValue('财务部')
    await $('button=保存组件').click()
    await $('[aria-label="组件 财务审批"]').waitForExist()
    assert.match(await $('.diagram-metadata').getText(), /财务部/)
    await saved.waitForExist()
    const configuredContent = await diskBoard(dataDirectory, 'fixture-project', 'fixture-project')
    const configuredDiagram = configuredContent.diagram
    const configuredIndex = JSON.parse(
      await readFile(join(dataDirectory, 'workspace.json'), 'utf8'),
    )
    assert.equal(configuredIndex.componentCatalog.scenarios.length, 2)
    const approvalScene = configuredIndex.componentCatalog.scenarios.find(
      (s) => s.name === '审批流程',
    )
    assert.equal(configuredDiagram.scenarioId, approvalScene.id)
    assert.equal(configuredDiagram.components[0].templateId, approvalScene.components[0].id)

    // JSON and scene selection cannot bypass the allowlist.
    await $('button=JSON').click()
    const invalidComponent = structuredClone(configuredDiagram)
    invalidComponent.components[0].templateId = 'builtin-store'
    invalidComponent.components[0].type = 'store'
    await $('[aria-label="系统图 JSON"]').setValue(JSON.stringify(invalidComponent))
    await $('button=校验并替换画板').click()
    await $('dialog .form-error').waitForExist()
    assert.match(await $('dialog .form-error').getText(), /规定的组件/)
    await $('dialog [aria-label="关闭弹窗"]').click()
    await selectOption('画板场景', 'Web 应用')
    assert.equal(await $('[aria-label="画板场景"]').getValue(), approvalScene.id)
    await browser.saveScreenshot(resolve('artifacts/scenario-diagram.png'))

    // Used definitions cannot be deleted, and returning preserves the board.
    await $('button=设置').click()
    await $('.settings-menu').$('button=组件设置').click()
    await $('[aria-label="组件场景"]').$('button*=审批流程').click()
    await $('[aria-label="删除组件模板 审批任务"]').click()
    await $('button=确认删除').click()
    await $('dialog .form-error').waitForExist()
    assert.match(await $('dialog .form-error').getText(), /仍在使用/)
    await $('dialog').$('button=取消').click()
    await $('button=返回工作空间').click()
    await $('[aria-label="组件 财务审批"]').waitForExist()

    await $('button=创建应用系统').click()
    await $('dialog .architecture-fields input').setValue('桌面验收系统')
    await $('dialog .architecture-fields textarea').setValue('用系统图梳理客户管理的数据与逻辑。')
    await $('button=添加画板').click()
    await $('[aria-label="画板 1 名称"]').setValue('销售管理')
    await browser.execute(() => {
      const e = document.querySelector('[aria-label="画板 1 类型"]')
      e.value = 'aggregate'
      e.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await $('button=添加子图').click()
    await $('[aria-label="画板 2 名称"]').setValue('销售线索')
    await $('button=查看架构 JSON').click()
    assert.match(await $('[aria-label="架构 JSON"]').getText(), /销售线索/)
    await browser.execute(() => {
      document.querySelector('dialog').scrollTop = 0
    })
    await browser.saveScreenshot(resolve('artifacts/system-architecture-editor.png'))
    await $('dialog button[type="submit"]').click()
    await $('[aria-label="桌面验收系统 系统图"]').waitForExist()
    await saved.waitForExist()
    const indexPath = join(dataDirectory, 'workspace.json')
    const current = JSON.parse(await readFile(indexPath, 'utf8'))
    assert.equal(current.schemaVersion, 3)
    assert.equal(current.systemIds.length, 2)
    assert.equal(current.projects, undefined)
    const systemId = current.systemIds.find((id) => id !== 'fixture-project')
    const architecturePath = join(dataDirectory, 'systems', systemId, 'architecture.json')
    const contentPath = join(dataDirectory, 'systems', systemId, 'index.json')
    const architecture = JSON.parse(await readFile(architecturePath, 'utf8'))
    assert.equal(architecture.name, '桌面验收系统')
    assert.equal(architecture.boards[1].name, '销售线索')
    assert.equal(JSON.parse(await readFile(contentPath, 'utf8')).boardIds.length, 3)

    await $('nav').$('button*=销售线索').click()
    await $('[aria-label="销售线索 系统图"]').waitForExist()
    await $('button=画板结构').click()
    await $('[aria-label="画板 2 名称"]').setValue('线索录入')
    await $('button=保存画板结构').click()
    await $('[aria-label="线索录入 系统图"]').waitForExist()
    await saved.waitForExist()
    const renamed = JSON.parse(await readFile(architecturePath, 'utf8'))
    assert.equal(renamed.boards[1].name, '线索录入')
    assert.equal(renamed.boards[1].id, architecture.boards[1].id)

    renamed.name = '外部更新的系统'
    await writeFile(architecturePath, JSON.stringify(renamed, null, 2))
    await $('[aria-label="重新读取本地数据"]').click()
    await $('button=重新读取并替换').click()
    await browser.waitUntil(async () =>
      (await $('.breadcrumb').getText()).includes('外部更新的系统'),
    )
    await saved.waitForExist()
    await browser.saveScreenshot(resolve('artifacts/system-workspace.png'))
    // The diagram is stored with this module, survives architecture edits and directory moves.
    await $('[aria-label="组件 销售线索"]').click()
    await $('[aria-label="删除组件"]').click()
    await $('button*=从注册流程示例开始').click()
    await $('[aria-label="组件 用户信息表单"]').waitForExist()
    assert.equal(await $$('.diagram-node').length, 4)
    await $('[aria-label="组件 用户信息表单"]').click()
    await $('button=编辑组件').click()
    await $('[aria-label="组件名称"]').setValue('注册申请表单')
    await $('button=保存组件').click()
    await $('[aria-label="组件 注册申请表单"]').waitForExist()
    const nodeBeforeDrag = await $('[aria-label="组件 注册申请表单"]').getAttribute('style')
    await $('[aria-label="组件 注册申请表单"] header').dragAndDrop(
      { x: 20, y: 30 },
      { duration: 200 },
    )
    assert.notEqual(
      await $('[aria-label="组件 注册申请表单"]').getAttribute('style'),
      nodeBeforeDrag,
    )
    const zoomBefore = await $('.diagram-view-controls output').getText()
    await $('[aria-label="放大画板"]').click()
    assert.notEqual(await $('.diagram-view-controls output').getText(), zoomBefore)
    await $('[aria-label="适应画板"]').click()
    await $('[aria-label="注册申请表单 输出 注册信息"]').dragAndDrop(
      await $('[aria-label="注册结果页 输入 注册结果"]'),
      { duration: 200 },
    )
    await browser.waitUntil(async () => (await $$('.diagram-edge').length) === 4)
    await $('[aria-label="组件 注册申请表单"]').click()
    await $('button=下游影响').click()
    assert.equal(await $$('.diagram-node.dimmed').length, 0)
    await $('button=上游来源').click()
    assert.equal(await $$('.diagram-node.dimmed').length, 3)
    await $('button=上游来源').click()
    await $('[aria-label="删除组件"]').click()
    assert.equal(await $$('.diagram-node').length, 3)
    await $('[aria-label="撤销画板操作"]').click()
    assert.equal(await $$('.diagram-node').length, 4)
    await $('button=添加组件').click()
    await $('.diagram-library').$('button*=服务').click()
    await $('[aria-label="组件名称"]').setValue('通知服务')
    // The embedded driver's option click only calls el.click(), which does not select an option.
    // Dispatch the native select change so React and all validation/save behavior still run.
    await browser.execute(() => {
      const select = document.querySelector('[aria-label="组件归属"]')
      select.value = [...select.options].find((option) => option.text === '校验与注册').value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await $('button=保存组件').click()
    await $('[aria-label="组件 通知服务"]').waitForExist()
    assert.equal(await $$('.diagram-node').length, 5)
    assert.match(await $('[aria-label="组件 通知服务"] footer').getText(), /校验与注册/)
    await $('[aria-label="删除组件"]').click()
    await $('button=设置').click()
    await $('button=返回工作空间').click()
    assert.equal(await $('[aria-label="撤销画板操作"]').isEnabled(), true)
    await $('button=自动布局').click()
    await $('[aria-label="适应画板"]').click()
    await saved.waitForExist()
    const diagramContent = await diskBoard(dataDirectory, systemId, current.activeNodeId)
    // current.activeNodeId was captured before selecting the module; inspect by module ID instead.
    const moduleGraph = (await diskBoard(dataDirectory, systemId, architecture.boards[1].id))
      .diagram
    assert.equal(moduleGraph.components[0].name, '注册申请表单')
    assert.equal(moduleGraph.connections.length, 4)
    assert.equal(diagramContent.diagram.components[0].id, 'board-entry')
    if (await $('[aria-label="取消选择"]').isExisting()) await $('[aria-label="取消选择"]').click()
    await browser.saveScreenshot(resolve('artifacts/system-diagram.png'))
    await $('button=JSON').click()
    const validJson = await $('[aria-label="系统图 JSON"]').getValue()
    await $('button=复制 JSON').click()
    await browser.waitUntil(async () => (await $('.toast').getText()).includes('已复制'))
    await $('[aria-label="系统图 JSON"]').setValue('{"schemaVersion":99}')
    await $('button=校验并替换画板').click()
    await $('dialog .form-error').waitForExist()
    await $('[aria-label="系统图 JSON"]').setValue(validJson)
    await $('button=校验并替换画板').click()
    await $('nav').$('button*=销售管理').click()
    await $('[aria-label="组件 销售管理"]').waitForExist()
    await $('nav').$('button*=线索录入').click()
    await $('[aria-label="组件 注册申请表单"]').waitForExist()
    assert.equal(
      JSON.parse(await readFile(join(process.env.SAY_CLEAR_LEGACY_DIR, 'workspace.json'), 'utf8'))
        .projects.length,
      1,
    )

    // Use the real migration command; only the native folder picker is substituted in e2e builds.
    await $('[aria-label="组件 注册申请表单"]').click()
    await $('button=设置').click()
    await browser.waitUntil(async () => await $('button=选择文件夹').isEnabled())
    assert.equal(await $('[aria-label="当前数据目录"]').getValue(), dataDirectory)
    await $('button=选择文件夹').click()
    const selected = await realpath(process.env.SAY_CLEAR_PICK_DIRECTORY)
    await browser.waitUntil(
      async () => (await $('[aria-label="当前数据目录"]').getValue()) === selected,
    )
    assert.deepEqual(
      JSON.parse(await readFile(join(selected, 'workspace.json'), 'utf8')),
      JSON.parse(await readFile(indexPath, 'utf8')),
    )
    assert.equal(
      JSON.parse(await readFile(join(dataDirectory, 'data-directory.json'), 'utf8')).dataDirectory,
      selected,
    )
    await access(architecturePath)
    await browser.saveScreenshot(resolve('artifacts/workspace-data-directory.png'))
    await $('button=返回工作空间').click()
    await $('button=编辑组件').click()
    await $('[aria-label="组件说明"]').setValue('自定义数据目录中保存的组件说明。')
    await $('button=保存组件').click()
    await saved.waitForExist()
    const boardPath = join('systems', systemId, 'boards', architecture.boards[1].id, 'current.json')
    const migratedContent = join(selected, boardPath)
    assert.match(await readFile(migratedContent, 'utf8'), /自定义数据目录中保存的组件说明/)
    assert.doesNotMatch(
      await readFile(join(dataDirectory, boardPath), 'utf8'),
      /自定义数据目录中保存的组件说明/,
    )
  })
})
