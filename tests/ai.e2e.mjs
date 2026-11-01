/* global browser, $, describe, it */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.env.SAY_CLEAR_AI_ARTIFACTS
const childBoardId = process.env.SAY_CLEAR_AI_CHILD_BOARD_ID
const expectedPath = join(root, 'expected-sessions.json')
const openChat = async () => {
  if (await $('.ai-dialog').isDisplayed()) return
  await $('[aria-label="打开 AI 对话"]').click()
  await $('.ai-dialog').waitForDisplayed()
}
const closeChat = async () => {
  await $('[aria-label="收起 AI 对话"]').click()
}
const inspectorTitle = async () =>
  (await $('.diagram-inspector[aria-label="系统图属性"]').isExisting())
    ? $('.diagram-inspector[aria-label="系统图属性"] h2').getText()
    : null
async function rightClick(selector) {
  const point = await browser.execute((targetSelector) => {
    const bounds = document.querySelector(targetSelector).getBoundingClientRect()
    return {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + bounds.height / 2),
    }
  }, selector)
  // Element-origin actions scroll the transformed canvas; viewport actions match a real click.
  await browser.performActions([
    {
      type: 'pointer',
      id: 'context-menu-pointer',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', origin: 'viewport', duration: 0, ...point },
        { type: 'pointerDown', button: 2 },
        { type: 'pointerUp', button: 2 },
      ],
    },
  ])
  // The embedded driver emits right-button pointer events but omits contextmenu.
  await browser.execute((targetSelector) => {
    const element = document.querySelector(targetSelector)
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      }),
    )
  }, selector)
}
async function addContext(kind, id) {
  if (await $('.ai-dialog').isDisplayed()) await closeChat()
  const previousInspector = await inspectorTitle()
  const selector =
    kind === 'component'
      ? `.diagram-node[data-component-id="${id}"] header`
      : `.diagram-edge[data-connection-id="${id}"] text`
  await rightClick(selector)
  await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
  assert.equal(await inspectorTitle(), previousInspector, '右键菜单不能打开或切换对象详情')
  await $('[role="menuitem"]').click()
  await $('.ai-dialog').waitForDisplayed()
  await $(
    `.ai-context-list [data-context-kind="${kind}"][data-context-id="${id}"]`,
  ).waitForDisplayed()
}
const contextCount = () =>
  browser.execute(() => document.querySelectorAll('.ai-context-list .ai-context-chip').length)
const graph = async () => {
  await $('.save-status.saved').waitForExist()
  return browser.execute(async () => {
    const workspace = await window.__TAURI__.core.invoke('load_workspace')
    return workspace.systems[0].contents[0].diagram
  })
}
const activeBoard = async () => {
  await $('.save-status.saved').waitForExist()
  return browser.execute(async () => {
    const workspace = await window.__TAURI__.core.invoke('load_workspace')
    return workspace.systems
      .flatMap((system) => system.contents)
      .find((content) => content.id === workspace.activeNodeId)
  })
}
const selectBoard = async (id) => {
  await $(`[data-board-id="${id}"] .project-item`).click()
  await browser.waitUntil(async () => (await activeBoard()).id === id)
}
async function send(message) {
  await $('[aria-label="AI 对话输入"]').setValue(message)
  await $('[aria-label="发送 AI 消息"]').click()
  await browser.waitUntil(async () => !(await $('[aria-label="停止 AI 请求"]').isExisting()))
}
const calls = async () =>
  (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
async function assertResume(session, provider, contextName) {
  const latest = (await calls()).at(-1)
  assert.equal(latest.session, session)
  assert.ok(latest.args.includes(provider === 'codex' ? 'resume' : '--resume'))
  if (contextName) assert.equal(latest.contextName, contextName)
}
async function configure(provider) {
  await $('button=设置').click()
  await $('button=AI 设置').click()
  await $(`.ai-tool-option:nth-child(${provider === 'codex' ? 1 : 2})`).click()
  await $('[aria-label="AI 工具命令路径"]').setValue(process.env.SAY_CLEAR_AI_EXECUTABLE)
  await $('button=检测工具').click()
  await browser.waitUntil(async () =>
    (await $('.ai-settings-status').getText()).includes('工具可用'),
  )
  await $('button=保存设置').click()
  await browser.waitUntil(async () => (await $('.ai-settings-status').getText()).includes('已保存'))
  await browser.saveScreenshot(join(root, `ai-settings-${provider}.png`))
  await $('button=返回工作空间').click()
}

describe('AI 浮球与命令行工具', () => {
  it('真实 WebView 调用本地子进程，修改、撤销、续聊、停止和重启恢复', async () => {
    await $('.save-status.saved').waitForExist()
    if (process.env.SAY_CLEAR_AI_PHASE !== 'edit') {
      const expected = JSON.parse(await readFile(expectedPath, 'utf8'))
      assert.equal((await graph()).components[0].name, 'Qoder 已修改')
      await openChat()
      if (process.env.SAY_CLEAR_AI_PHASE === 'reset-restore') {
        // Reset must persist before the first message of the replacement session.
        assert.match(await $('.ai-dialog-header').getText(), /Qoder CLI/)
        assert.doesNotMatch(await $('.ai-dialog-header').getText(), /会话已连接/)
        assert.equal(await $('.ai-message.user').isExisting(), false)
        assert.equal(await $('.ai-message.assistant').isExisting(), false)
        assert.equal(await contextCount(), 1)
        assert.equal(await $('[aria-label="AI 对话输入"]').getValue(), '重启后保留的引用讨论')
        await send('重启后新会话讨论')
        const latest = (await calls()).at(-1)
        assert.equal(latest.args.includes('--resume'), false)
        assert.notEqual(latest.session, expected.qoderSession)
        assert.equal(latest.focusedItems[0].component.id, expected.contextComponentId)
        assert.equal(await contextCount(), 0)
        await writeFile(
          expectedPath,
          JSON.stringify({ ...expected, replacementSession: latest.session }),
        )
        await browser.saveScreenshot(join(root, 'ai-reset-restored.png'))
        return
      }
      assert.match(await $('.ai-dialog-header').getText(), /Qoder CLI.*会话已连接/s)
      assert.match(await $('.ai-messages').getText(), /已完成：重启后新会话讨论/)
      assert.doesNotMatch(await $('.ai-messages').getText(), /通过 Qoder 修改画板/)
      await send('再次重启继续讨论')
      await assertResume(expected.replacementSession, 'qodercli', 'AI 测试应用')
      await closeChat()
      await configure('codex')
      await openChat()
      assert.match(await $('.ai-messages').getText(), /新会话讨论/)
      await send('重启后切回 Codex 讨论')
      await assertResume(expected.codexSession, 'codex', 'AI 测试应用')
      await browser.saveScreenshot(join(root, 'ai-restored.png'))
      return
    }
    const before = await graph()
    await configure('codex')
    await openChat()
    // IME confirmation must not submit a message.
    await $('[aria-label="AI 对话输入"]').setValue('中文输入')
    await browser.execute(() => {
      const input = document.querySelector('[aria-label="AI 对话输入"]')
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
      )
    })
    assert.equal(await $('.ai-message.user').isExisting(), false)
    await $('[aria-label="AI 对话输入"]').setValue('进度验证：请修改画板')
    await $('[aria-label="发送 AI 消息"]').click()
    await browser.waitUntil(async () =>
      (await $('.ai-dialog-header').getText()).includes('会话已连接'),
    )
    assert.equal(await $('[aria-label="停止 AI 请求"]').isExisting(), true)
    await $('.ai-thinking[data-stage="retrying"]').waitForExist()
    assert.equal(await $('.ai-message.assistant').isExisting(), false)
    assert.match(await $('.ai-thinking').getText(), /\d+\s*秒/)
    await browser.saveScreenshot(join(root, 'ai-reconnecting.png'))
    await browser.waitUntil(async () => !(await $('[aria-label="停止 AI 请求"]').isExisting()), {
      timeout: 10000,
      timeoutMsg: 'CLI 已发出 turn.completed，界面不应继续等待进程退出',
    })
    await assert.rejects(readFile(join(root, 'natural-exits.jsonl')), { code: 'ENOENT' })
    assert.equal((await graph()).components[0].name, 'Codex 已修改')
    assert.match(await $('.ai-messages').getText(), /已应用到画板/)
    await browser.saveScreenshot(join(root, 'ai-chat-codex.png'))
    await closeChat()
    await $('[aria-label="撤销画板操作"]').click()
    assert.deepEqual(await graph(), before)
    await $('[aria-label="重做画板操作"]').click()
    assert.equal((await graph()).components[0].name, 'Codex 已修改')
    await openChat()
    await send('讨论当前流程')
    let logs = await calls()
    assert.ok(logs[1].args.includes('resume'))
    assert.equal(logs[1].session, logs[0].session)
    // Canvas references remain reviewable until the user sends the next message.
    const referencedGraph = await graph()
    const component = referencedGraph.components[0]
    const connection = referencedGraph.connections[0]
    await closeChat()
    if (await $('.diagram-inspector[aria-label="系统图属性"]').isExisting())
      await $('[aria-label="取消选择"]').click()
    assert.equal(await inspectorTitle(), null)
    const openKeyboardMenu = (kind = 'component', id = component.id) =>
      browser.execute(
        ({ targetKind, targetId }) => {
          const selector =
            targetKind === 'component'
              ? `.diagram-node[data-component-id="${targetId}"]`
              : `.diagram-edge[data-connection-id="${targetId}"]`
          const node = document.querySelector(selector)
          node.focus()
          const event = new KeyboardEvent('keydown', {
            key: 'F10',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          })
          node.dispatchEvent(event)
          return event.defaultPrevented
        },
        { targetKind: kind, targetId: id },
      )
    const dismissMenu = async () => {
      await browser.execute(() => {
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      await $('[role="menu"][aria-label="画板对象菜单"]').waitForExist({ reverse: true })
    }
    assert.equal(await openKeyboardMenu(), true)
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
    assert.equal(await inspectorTitle(), null, '组件键盘菜单不能打开详情')
    assert.equal(
      await browser.execute(() => document.activeElement.getAttribute('role')),
      'menuitem',
    )
    await dismissMenu()
    assert.equal(
      await browser.execute(() => document.activeElement.getAttribute('data-component-id')),
      component.id,
    )
    assert.equal(await inspectorTitle(), null)
    assert.deepEqual(await graph(), referencedGraph)
    assert.equal(await openKeyboardMenu('connection', connection.id), true)
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
    assert.equal(await inspectorTitle(), null, '连接键盘菜单不能打开详情')
    await dismissMenu()
    await openKeyboardMenu()
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
    await $('[aria-label="搜索画板组件"]').click()
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForExist({ reverse: true })
    // Right-clicking a different object keeps the current inspector unchanged.
    await $(`.diagram-node[data-component-id="${component.id}"] header`).click()
    await $('.diagram-inspector[aria-label="系统图属性"]').waitForDisplayed()
    assert.equal(await inspectorTitle(), component.name)
    const otherComponent = referencedGraph.components.find((item) => item.id !== component.id)
    await rightClick(`.diagram-node[data-component-id="${otherComponent.id}"] header`)
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
    assert.equal(await inspectorTitle(), component.name)
    await dismissMenu()
    await rightClick(`.diagram-edge[data-connection-id="${connection.id}"] text`)
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
    assert.equal(await inspectorTitle(), component.name)
    await dismissMenu()
    await $('[aria-label="取消选择"]').click()
    assert.equal(await inspectorTitle(), null)
    assert.deepEqual(await graph(), referencedGraph)
    // Opening an input port's context menu must not finish a pending connection.
    const portSource = referencedGraph.components.find((item) => item.outputs.length)
    const portTarget = referencedGraph.components.find(
      (item) =>
        item.id !== portSource.id &&
        item.inputs.length &&
        !referencedGraph.connections.some(
          (edge) => edge.sourceId === portSource.id && edge.targetId === item.id,
        ),
    )
    assert.ok(portTarget, '测试图应提供尚未连接的输入端口')
    await $(`.diagram-node[data-component-id="${portSource.id}"] .diagram-port.output`).click()
    await $('.diagram-port.output.pending').waitForExist()
    await rightClick(`.diagram-node[data-component-id="${portTarget.id}"] .diagram-port.input`)
    await $('[role="menu"][aria-label="画板对象菜单"]').waitForDisplayed()
    assert.equal(await inspectorTitle(), null, '输入端口右键菜单不能打开详情')
    await dismissMenu()
    assert.equal(await $('.diagram-port.output.pending').isExisting(), false)
    assert.deepEqual(await graph(), referencedGraph)
    await openChat()
    await $('[aria-label="AI 对话输入"]').setValue('保留这段输入并讨论所选对象')
    await addContext('component', component.id)
    assert.equal(await contextCount(), 1)
    assert.equal(await $('[aria-label="AI 对话输入"]').getValue(), '保留这段输入并讨论所选对象')
    await addContext('component', component.id)
    assert.equal(await contextCount(), 1)
    await addContext('connection', connection.id)
    assert.equal(await contextCount(), 2)
    await $(
      `.ai-context-list [data-context-kind="component"][data-context-id="${component.id}"] button`,
    ).click()
    assert.equal(await contextCount(), 1)
    await addContext('component', component.id)
    await closeChat()
    await $('button=设置').click()
    await $('button=返回工作空间').click()
    await openChat()
    assert.equal(await contextCount(), 2)
    assert.equal(await $('[aria-label="AI 对话输入"]').getValue(), '保留这段输入并讨论所选对象')
    await browser.saveScreenshot(join(root, 'ai-canvas-context.png'))
    await send('针对引用的组件和线条讨论')
    const contextCall = (await calls()).at(-1)
    assert.equal(contextCall.focusedItems.length, 2)
    assert.deepEqual(
      contextCall.focusedItems.find((item) => item.kind === 'component').component,
      component,
    )
    const connectionContext = contextCall.focusedItems.find((item) => item.kind === 'connection')
    assert.deepEqual(connectionContext.connection, connection)
    assert.deepEqual(
      connectionContext.source,
      referencedGraph.components.find((item) => item.id === connection.sourceId),
    )
    assert.deepEqual(
      connectionContext.target,
      referencedGraph.components.find((item) => item.id === connection.targetId),
    )
    assert.equal(await contextCount(), 0)
    assert.equal(await $('.ai-message.user .ai-message-contexts').isExisting(), true)
    assert.deepEqual(await graph(), referencedGraph)
    const valid = await graph()
    await send('生成无效模板')
    assert.match(await $('.ai-error').getText(), /规定的组件/)
    assert.deepEqual(await graph(), valid)
    await addContext('component', component.id)
    await send('模拟失败')
    assert.match(await $('.ai-error').getText(), /未登录/)
    assert.deepEqual(await graph(), valid)
    assert.equal(await contextCount(), 1)
    assert.equal(await $('[aria-label="AI 对话输入"]').getValue(), '模拟失败')
    await $('.ai-context-list .ai-context-chip button').click()
    await $('[aria-label="AI 对话输入"]').setValue('取消验证：等待后修改')
    await $('[aria-label="发送 AI 消息"]').click()
    await $('.ai-thinking[data-stage="thinking"]').waitForExist()
    await $('[aria-label="停止 AI 请求"]').waitForExist()
    await $('[aria-label="停止 AI 请求"]').click()
    assert.deepEqual(await graph(), valid)
    await $('[aria-label="新建 AI 会话"]').click()
    await send('新会话讨论')
    logs = await calls()
    assert.notEqual(logs.at(-1).session, logs[0].session)
    // Closing the panel allows manual edits; a late result must not overwrite them.
    await $('[aria-label="AI 对话输入"]').setValue('等待后修改')
    await $('[aria-label="发送 AI 消息"]').click()
    await closeChat()
    await $('[aria-label="撤销画板操作"]').click()
    await openChat()
    await browser.waitUntil(
      async () =>
        (await $('.ai-error').isExisting()) &&
        (await $('.ai-error').getText()).includes('画板已变化'),
    )
    assert.deepEqual(await graph(), before)
    const codexSession = (await calls()).at(-1).session
    // Board navigation clears canvas undo history, so check isolation after the undo test.
    await addContext('component', component.id)
    await closeChat()
    await selectBoard(childBoardId)
    await openChat()
    assert.equal(await contextCount(), 0)
    await send('子图上下文隔离讨论')
    assert.deepEqual((await calls()).at(-1).focusedItems, [])
    await closeChat()
    await selectBoard('ai-app')
    await openChat()
    while (await $('.ai-context-list .ai-context-chip button').isExisting())
      await $('.ai-context-list .ai-context-chip button').click()
    // Completed messages and the CLI session survive ordinary page navigation.
    await closeChat()
    await $('button=设置').click()
    await $('button=返回工作空间').waitForDisplayed()
    await $('button=返回工作空间').click()
    await openChat()
    assert.match(await $('.ai-dialog-header').getText(), /Codex.*会话已连接/s)
    assert.match(await $('.ai-messages').getText(), /新会话讨论/)
    await send('设置返回后继续讨论')
    await assertResume(codexSession, 'codex', 'AI 测试应用')
    await closeChat()
    await $('.iteration-nav').click()
    await $('.iteration-management').waitForDisplayed()
    await $('button=返回画板').click()
    await openChat()
    assert.match(await $('.ai-messages').getText(), /设置返回后继续讨论/)
    await send('迭代页返回后讨论')
    await assertResume(codexSession, 'codex', 'AI 测试应用')
    // The same pending turn keeps running while the settings page is visible.
    await $('[aria-label="AI 对话输入"]').setValue('等待讨论：设置页往返')
    await $('[aria-label="发送 AI 消息"]').click()
    await $('.ai-thinking[data-stage="thinking"]').waitForExist()
    await closeChat()
    await $('button=设置').click()
    await $('button=返回工作空间').waitForDisplayed()
    await $('button=返回工作空间').click()
    await openChat()
    assert.match(await $('.ai-messages').getText(), /等待讨论：设置页往返/)
    await browser.waitUntil(async () =>
      (await $('.ai-messages').getText()).includes('已完成：等待讨论：设置页往返'),
    )
    assert.equal(await $('[aria-label="停止 AI 请求"]').isExisting(), false)
    await assertResume(codexSession, 'codex', 'AI 测试应用')
    await browser.saveScreenshot(join(root, 'ai-navigation-completed.png'))
    // Switching boards stops the old turn, keeps its conversation, and scopes the next prompt.
    await $('[aria-label="AI 对话输入"]').setValue('取消验证：切换画板等待后修改')
    await $('[aria-label="发送 AI 消息"]').click()
    await $('.ai-thinking[data-stage="thinking"]').waitForExist()
    await closeChat()
    await selectBoard(childBoardId)
    const childBefore = (await activeBoard()).diagram
    await openChat()
    assert.match(await $('.ai-messages').getText(), /已完成：等待讨论：设置页往返/)
    assert.equal(await $('[aria-label="停止 AI 请求"]').isExisting(), false)
    await send('修改当前子图')
    await assertResume(codexSession, 'codex', 'AI 导航子图')
    const childAfter = (await activeBoard()).diagram
    assert.equal(childAfter.components[0].name, 'Codex 已修改')
    assert.notDeepEqual(childAfter, childBefore)
    assert.deepEqual(await graph(), before)
    await closeChat()
    await selectBoard('ai-app')
    await openChat()
    assert.match(await $('.ai-messages').getText(), /已完成：修改当前子图/)
    await send('返回主图讨论')
    await assertResume(codexSession, 'codex', 'AI 测试应用')
    assert.deepEqual((await activeBoard()).diagram, before)
    assert.doesNotMatch(await $('.ai-messages').getText(), /已完成：取消验证：切换画板等待后修改/)
    await closeChat()
    await configure('qodercli')
    await openChat()
    await send('通过 Qoder 修改画板')
    assert.equal((await graph()).components[0].name, 'Qoder 已修改')
    await send('继续讨论')
    logs = await calls()
    assert.ok(logs.at(-1).args.includes('--resume'))
    assert.equal(logs.at(-1).session, logs.at(-2).session)
    assert.ok(logs.at(-1).args.includes('--tools'))
    const qoderSession = logs.at(-1).session
    await browser.saveScreenshot(join(root, 'ai-chat-qoder.png'))
    // Each provider keeps its own transcript and resume identifier.
    await closeChat()
    await configure('codex')
    await openChat()
    assert.match(await $('.ai-messages').getText(), /返回主图讨论/)
    assert.doesNotMatch(await $('.ai-messages').getText(), /通过 Qoder 修改画板/)
    await send('工具切回 Codex 讨论')
    await assertResume(codexSession, 'codex', 'AI 测试应用')
    await closeChat()
    await configure('qodercli')
    await openChat()
    assert.match(await $('.ai-messages').getText(), /通过 Qoder 修改画板/)
    assert.doesNotMatch(await $('.ai-messages').getText(), /工具切回 Codex 讨论/)
    await send('工具切回 Qoder 讨论')
    await assertResume(qoderSession, 'qodercli', 'AI 测试应用')
    await $('[aria-label="新建 AI 会话"]').click()
    assert.equal(await $('.ai-message.user').isExisting(), false)
    assert.equal(await $('.ai-message.assistant').isExisting(), false)
    assert.doesNotMatch(await $('.ai-dialog-header').getText(), /会话已连接/)
    assert.equal(await contextCount(), 0)
    await addContext('component', before.components[0].id)
    await $('[aria-label="AI 对话输入"]').setValue('重启后保留的引用讨论')
    await writeFile(
      expectedPath,
      JSON.stringify({ codexSession, qoderSession, contextComponentId: before.components[0].id }),
    )
    const settings = JSON.parse(
      await readFile(join(process.env.SAY_CLEAR_DATA_DIR, 'ai-settings.json'), 'utf8'),
    )
    assert.equal(settings.provider, 'qodercli')
    assert.equal(settings.codex.executable, process.env.SAY_CLEAR_AI_EXECUTABLE)
  })
})
