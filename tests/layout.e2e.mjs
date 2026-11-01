/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.SAY_CLEAR_LAYOUT_ARTIFACTS
const diagram = (workspace) =>
  workspace.systems.flatMap((s) => s.contents).find((c) => c.diagram)?.diagram
async function snapshot() {
  await $('.save-status.saved').waitForExist()
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
async function geometry() {
  return browser.execute(() =>
    [...document.querySelectorAll('.diagram-node')].map((el) => ({
      id: el.dataset.componentId,
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      width: parseFloat(el.style.width),
      height: parseFloat(el.style.height),
    })),
  )
}
function assertSeparated(nodes) {
  for (const [i, a] of nodes.entries())
    for (const b of nodes.slice(i + 1))
      assert.ok(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
        `${a.id} 与 ${b.id} 重叠`,
      )
}
async function capture(name) {
  await browser.saveScreenshot(join(root, name))
}

describe('桌面自动布局回归：手机号注册迭代', () => {
  it('保留原有二维布局，删除节点不重叠，撤销重做与重启一致', async () => {
    await $('.save-status.saved').waitForExist()
    if (process.env.SAY_CLEAR_LAYOUT_PHASE === 'restore') {
      assert.deepEqual(
        await snapshot(),
        JSON.parse(await readFile(join(root, 'workspace-snapshot.json'), 'utf8')),
      )
      assert.deepEqual(
        await geometry(),
        JSON.parse(await readFile(join(root, 'view-snapshot.json'), 'utf8')),
      )
      assertSeparated(await geometry())
      await capture('restored-desktop.png')
      return
    }
    await $('button*=体验「手机号注册」迭代示例').click()
    await browser.waitUntil(async () => (await $$('.diagram-node').length) === 11)
    const before = await snapshot(),
      beforeGeometry = await geometry()
    await $('[aria-label="适应画板"]').click()
    await capture('before-layout.png')
    await $('button=自动布局').click()
    assert.deepEqual(diagram(await snapshot()), diagram(before))
    assert.deepEqual(await geometry(), beforeGeometry)
    assertSeparated(await geometry())
    const cardHits = await browser.execute(() => {
      const nodes = [...document.querySelectorAll('.diagram-node')].map((el) => ({
        id: el.dataset.componentId,
        x: parseFloat(el.style.left),
        y: parseFloat(el.style.top),
        w: parseFloat(el.style.width),
        h: parseFloat(el.style.height),
      }))
      const hits = []
      for (const path of document.querySelectorAll('.diagram-edge-line')) {
        const length = path.getTotalLength()
        for (let i = 1; i < 100; i++) {
          const p = path.getPointAtLength((length * i) / 100)
          const hit = nodes.find(
            (n) => p.x > n.x + 1 && p.x < n.x + n.w - 1 && p.y > n.y + 1 && p.y < n.y + n.h - 1,
          )
          if (hit) {
            hits.push(hit.id)
            break
          }
        }
      }
      return hits
    })
    assert.deepEqual(cardHits, [])
    await capture('after-layout.png')
    await $('button=自动布局').click()
    // Two no-op clicks must not consume undo entries.
    await $('[aria-label="撤销画板操作"]').click()
    assert.equal((await geometry()).length, 0)
    await $('[aria-label="重做画板操作"]').click()
    assert.deepEqual(await geometry(), beforeGeometry)

    // Seed a collapsed diagram through the actual native store in this isolated
    // workspace, then exercise the desktop UI's layout and persistence paths.
    const collapsed = await snapshot()
    diagram(collapsed).components.forEach((c) => {
      c.position = { x: 80, y: 80 }
    })
    await browser.execute(
      (workspace) => window.__TAURI__.core.invoke('save_workspace', { workspace }),
      collapsed,
    )
    await $('[aria-label="重新读取本地数据"]').click()
    await $('button=重新读取并替换').click()
    await browser.waitUntil(
      async () => (await geometry()).filter((n) => n.x === 80 && n.y === 80).length === 10,
    )
    await $('button=自动布局').click()
    const arranged = await snapshot(),
      arrangedGeometry = await geometry()
    assertSeparated(arrangedGeometry)
    assert.equal(arrangedGeometry.length, 11)
    assert.equal(diagram(arranged).components.length, 10)
    assert.deepEqual(diagram(arranged).iteration.baseline, diagram(before).iteration.baseline)
    const clipped = await browser.execute(() => {
      const canvas = document.querySelector('[aria-label="系统图画板"]').getBoundingClientRect()
      return [...document.querySelectorAll('.diagram-node')]
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return (
            r.left < canvas.left ||
            r.top < canvas.top ||
            r.right > canvas.right ||
            r.bottom > canvas.bottom
          )
        })
        .map((el) => el.dataset.componentId)
    })
    assert.deepEqual(clipped, [])
    await capture('overlap-repaired.png')
    await $('button=自动布局').click()
    assert.deepEqual(await geometry(), arrangedGeometry)
    await $('[aria-label="撤销画板操作"]').click()
    assert.deepEqual(diagram(await snapshot()), diagram(collapsed))
    await $('[aria-label="重做画板操作"]').click()
    assert.deepEqual(await geometry(), arrangedGeometry)
    await $('button=现状').click()
    assert.equal(await $$('.diagram-node').length, 7)
    assert.equal(await $('button=自动布局').isEnabled(), false)
    await $('button=本次迭代').click()
    assert.deepEqual(await geometry(), arrangedGeometry)
    await writeFile(
      join(root, 'workspace-snapshot.json'),
      JSON.stringify(await snapshot(), null, 2),
    )
    await writeFile(join(root, 'view-snapshot.json'), JSON.stringify(await geometry(), null, 2))
  })
})
