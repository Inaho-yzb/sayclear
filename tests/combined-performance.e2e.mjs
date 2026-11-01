/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.SAY_CLEAR_PERFORMANCE_ARTIFACTS
const dialog = '[aria-label="多图组合视图"]'
const canvas = `${dialog} [aria-label="组合视图画板"]`

async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
async function settle() {
  await browser.execute(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
}
async function renderCounts() {
  return browser.execute(() => {
    const dialog = document.querySelector('[aria-label="多图组合视图"]')
    const canvas = dialog.querySelector('[aria-label="组合视图画板"]')
    return {
      level: canvas.dataset.detailLevel,
      totalNodes: Number(canvas.dataset.totalNodes),
      renderedNodes: Number(canvas.dataset.renderedNodes),
      renderedEdges: Number(canvas.dataset.renderedEdges),
      nodeElements: dialog.querySelectorAll('.combined-node').length,
      frameElements: dialog.querySelectorAll('.combined-board-frame').length,
      domElements: dialog.querySelectorAll('*').length,
    }
  })
}
async function measurePanFrames() {
  return browser.execute(async () => {
    const canvas = document.querySelector('[aria-label="组合视图画板"]')
    const world = canvas.querySelector('.diagram-world')
    const before = world.style.transform
    const samples = []
    let previous = await new Promise(requestAnimationFrame)
    for (let index = 0; index < 40; index++) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: index % 2 ? -28 : 36,
          deltaY: index % 2 ? -12 : 16,
        }),
      )
      const now = await new Promise(requestAnimationFrame)
      samples.push(now - previous)
      previous = now
    }
    await new Promise(requestAnimationFrame)
    const sorted = [...samples].sort((a, b) => a - b)
    return {
      sampleCount: samples.length,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maximumMs: sorted.at(-1),
      framesOver50Ms: samples.filter((value) => value > 50).length,
      transformChanged: world.style.transform !== before,
    }
  })
}
async function dragOverviewFrame() {
  const start = await browser.execute(() => {
    const canvas = document.querySelector('[aria-label="组合视图画板"]')
    const bounds = canvas.getBoundingClientRect()
    const frame = [...canvas.querySelectorAll('.combined-board-frame')].find((element) => {
      const rect = element.getBoundingClientRect()
      return (
        rect.width > 20 &&
        rect.height > 20 &&
        rect.left >= bounds.left + 10 &&
        rect.right <= bounds.right - 100 &&
        rect.top >= bounds.top + 10 &&
        rect.bottom <= bounds.bottom - 70
      )
    })
    if (!frame) throw new Error('总览中没有可拖动的画板背景')
    const rect = frame.getBoundingClientRect()
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height * 0.75),
      transform: canvas.querySelector('.diagram-world').style.transform,
    }
  })
  await browser.performActions([
    {
      type: 'pointer',
      id: 'combined-pan-pointer',
      parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', origin: 'viewport', duration: 0, x: start.x, y: start.y },
        { type: 'pointerDown', button: 0 },
        {
          type: 'pointerMove',
          origin: 'viewport',
          duration: 140,
          x: start.x + 70,
          y: start.y + 40,
        },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ])
  await settle()
  const result = await browser.execute(() => {
    const canvas = document.querySelector('[aria-label="组合视图画板"]')
    return {
      level: canvas.dataset.detailLevel,
      transform: canvas.querySelector('.diagram-world').style.transform,
    }
  })
  assert.equal(result.level, 'overview', '在总览画板背景拖动应平移，不能误触放大画板')
  assert.notEqual(result.transform, start.transform)
  assert.equal(
    result.transform.match(/scale\(([^)]+)\)/)?.[1],
    start.transform.match(/scale\(([^)]+)\)/)?.[1],
    '拖动画板背景必须保留缩放比例',
  )
}
async function keyboardFocusAfterCulling() {
  await browser.execute(() => {
    const node = document.querySelector('.combined-node.selected')
    if (!node) throw new Error('没有已选组件用于测试键盘焦点')
    node.focus({ preventScroll: true })
    const canvas = document.querySelector('[aria-label="组合视图画板"]')
    const bounds = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: 200,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      }),
    )
  })
  await browser.waitUntil(async () => (await renderCounts()).level === 'overview')
  assert.equal(
    await browser.execute(
      () => document.activeElement === document.querySelector('[aria-label="组合视图画板"]'),
    ),
    true,
    '缩小使聚焦组件卸载时，应把键盘焦点留在画布',
  )
  const previous = await $(`${dialog} .diagram-world`).getAttribute('style')
  await browser.keys('f')
  await browser.waitUntil(
    async () => (await $(`${dialog} .diagram-world`).getAttribute('style')) !== previous,
  )
  const fitted = await $(`${dialog} .diagram-world`).getAttribute('style')
  await browser.keys('+')
  await browser.waitUntil(
    async () => (await $(`${dialog} .diagram-world`).getAttribute('style')) !== fitted,
  )
}
async function accessibleOverviewFrame() {
  await browser.execute(() => {
    const frame = document.querySelector('.combined-board-frame[role="button"]')
    if (!frame) throw new Error('总览中没有可通过辅助功能操作的画板')
    frame.focus({ preventScroll: true })
    // Screen readers activate a button with a detail=0 click rather than pointer events.
    frame.click()
  })
  await browser.waitUntil(async () => (await renderCounts()).level !== 'overview')
  await browser.execute(() =>
    document.querySelector('[aria-label="组合视图画板"]').focus({ preventScroll: true }),
  )
  await browser.keys('f')
  await browser.waitUntil(async () => (await renderCounts()).level === 'overview')
}

describe('复杂组合视图的渲染规模与交互', () => {
  it('缩小总览不挂载全部组件，定位后只挂载视口内容，交互不改变原图', async () => {
    const before = await snapshot()
    await $('button=组合视图').click()
    await $(dialog).waitForDisplayed()
    const expand = $(dialog).$('button=继续展开关联画板')
    if (await expand.isExisting()) await expand.click()
    await browser.waitUntil(async () => (await $(canvas).getAttribute('aria-busy')) === 'false')
    await settle()
    const overview = await renderCounts()
    assert.equal(overview.level, 'overview')
    assert.ok(overview.totalNodes > 300, '使用真实复杂案例而不是小图验证')
    assert.ok(overview.renderedNodes < 100, '全图总览应避免挂载全部组件卡片')
    assert.equal(overview.nodeElements, overview.renderedNodes)
    assert.equal(await $(dialog).$('button=上游').isEnabled(), false)
    await browser.saveScreenshot(join(root, 'combined-performance-overview.png'))
    await dragOverviewFrame()
    const overviewFrames = await measurePanFrames()
    assert.equal(overviewFrames.transformChanged, true)
    await accessibleOverviewFrame()

    await $('[aria-label="搜索组合视图"]').setValue('电商履约')
    await browser.waitUntil(async () => {
      const text = await $(`${dialog} .combined-directory h3`).getText()
      return Number(text.match(/\d+/)?.[0]) > 100
    })
    assert.ok(
      (await $$(`${dialog} .combined-board-list > button`).length) <= 100,
      '宽泛搜索不能一次挂载几百个结果按钮',
    )
    await $(dialog).$('button=显示更多搜索结果').waitForExist()
    await $('[aria-label="搜索组合视图"]').setValue('冻结本次活动购买资格')
    await browser.waitUntil(
      async () => (await $$(`${dialog} .combined-board-list button`).length) === 1,
    )
    const results = await $$(`${dialog} .combined-board-list button`)
    assert.equal(results.length, 1, '全局搜索仍能找到当前视口外的深层组件')
    await results[0].click()
    await settle()
    await browser.waitUntil(async () => (await renderCounts()).level === 'full')
    const focused = await renderCounts()
    assert.ok(focused.nodeElements > 0)
    assert.ok(focused.nodeElements < 100, '放大定位后也只挂载附近组件')
    assert.ok(focused.nodeElements < focused.totalNodes / 2)
    assert.ok(focused.frameElements < overview.frameElements, '视口外画板应退出 DOM')
    assert.match(await $('.combined-selection').getText(), /冻结本次活动购买资格/)
    const visibleSelection = await browser.execute(() => {
      const canvas = document.querySelector('[aria-label="组合视图画板"]').getBoundingClientRect()
      const node = document.querySelector('.combined-node.selected').getBoundingClientRect()
      return {
        centerX: node.left + node.width / 2,
        centerY: node.top + node.height / 2,
        left: canvas.left,
        right: canvas.right,
        top: canvas.top,
        bottom: canvas.bottom,
        width: node.width,
      }
    })
    assert.ok(visibleSelection.centerX > visibleSelection.left)
    assert.ok(visibleSelection.centerX < visibleSelection.right)
    assert.ok(visibleSelection.centerY > visibleSelection.top)
    assert.ok(visibleSelection.centerY < visibleSelection.bottom)
    assert.ok(visibleSelection.width > 180)
    await $('[aria-label="清除组合视图搜索"]').click()
    await $(dialog).$('button=上游').click()
    assert.equal(await $(dialog).$('button=上游').getAttribute('aria-pressed'), 'true')
    await $(dialog).$('button=下游').click()
    assert.equal(await $(dialog).$('button=下游').getAttribute('aria-pressed'), 'true')
    await $(dialog).$('button=全部链路').click()
    const panFrames = await measurePanFrames()
    assert.equal(panFrames.sampleCount, 40)
    assert.equal(panFrames.transformChanged, true, '分帧合并不能丢掉滚动平移')
    const afterPan = await renderCounts()
    assert.ok(afterPan.nodeElements < 100, '连续平移保持有限挂载规模')
    await browser.saveScreenshot(join(root, 'combined-performance-focused.png'))
    await keyboardFocusAfterCulling()

    await $('.combined-selection').$('button=打开原图').click()
    await $(dialog).waitForExist({ reverse: true })
    assert.match(await $('.breadcrumb').getText(), /身份与限购资格/)
    await $('[data-component-id="execute"]').waitForExist()
    await $('[aria-label="返回引用画板"]').click()
    await $('[aria-label="电商履约 · 复杂全链路 系统图"]').waitForExist()
    assert.deepEqual(await snapshot(), before, '大图的查看、追踪、定位与跳转不得改写图内容')

    await writeFile(
      join(root, 'performance-result.json'),
      JSON.stringify(
        {
          passed: true,
          overview,
          focused,
          afterPan,
          overviewFrames,
          panFrames,
          checks: [
            '复杂案例全图分级展示',
            '总览画板背景拖动保留缩放',
            '辅助功能激活总览画板可打开组件层级',
            '宽泛搜索有限结果挂载',
            '视口外深层组件搜索定位',
            '放大后有限组件及画板挂载',
            '跨图追踪与连续平移',
            '组件卸载后键盘焦点与快捷键保持可用',
            '精确来源跳转及返回',
            '原图内容保持不变',
          ],
        },
        null,
        2,
      ),
    )
  })
})
