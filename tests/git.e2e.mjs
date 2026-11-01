/* global browser, $, $$, describe, it */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.SAY_CLEAR_GIT_ARTIFACTS
const repository = JSON.parse(await readFile(join(root, 'repository-snapshot.json'), 'utf8'))
const git = (...args) =>
  execFileSync('git', ['-C', repository.path, ...args], { encoding: 'utf8' }).trim()
const graph = (workspace, id) =>
  workspace.systems.flatMap((system) => system.contents).find((content) => content.id === id)
    ?.diagram
const card = (id) => $(`[data-iteration-board="${id}"]`)
async function saved() {
  await browser.waitUntil(() =>
    browser.execute(() =>
      [...document.querySelectorAll('.save-status')].some(
        (element) => element.getClientRects().length && element.classList.contains('saved'),
      ),
    ),
  )
  return browser.execute(() => window.__TAURI__.core.invoke('load_workspace'))
}
async function select(label, value) {
  await $(`[aria-label="${label}"] option[value="${value}"]`).waitForExist()
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
async function closeSubmittedDialog() {
  await $('dialog.modal[open]').waitForExist({ reverse: true })
  return saved()
}
async function manage() {
  await $('.iteration-nav').click()
  await $('#iteration-management-title').waitForDisplayed()
}
async function capture(filename) {
  await browser.execute(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  await browser.saveScreenshot(join(root, filename))
}
async function unchangedRepository() {
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(git('rev-parse', 'HEAD'), repository.headCommit)
  assert.equal(git('status', '--porcelain=v1'), repository.dirtyStatus)
  assert.equal(
    await readFile(join(repository.path, repository.filename), 'utf8'),
    repository.dirtyContent,
  )
}
function assertBinding(binding, branch, baseBranch, baseCommit, repositoryPath = repository.path) {
  assert.deepEqual(binding, {
    repositoryPath,
    branch,
    baseBranch,
    baseCommit,
  })
  assert.equal(
    execFileSync('git', ['-C', repositoryPath, 'show-ref', '--hash', `refs/heads/${branch}`], {
      encoding: 'utf8',
    }).trim(),
    baseCommit,
  )
}
async function startManaged(boardId, name, branch) {
  await $('.management-intro').$('button=创建迭代').click()
  await select('迭代所属画板', boardId)
  await $('[aria-label="迭代名称"]').setValue(name)
  await $('[aria-label="Git 分支名称"]').setValue(branch)
  await $('button=创建分支并开始迭代').waitForEnabled()
  await $('button=创建分支并开始迭代').click()
  return closeSubmittedDialog()
}

describe('Git 仓库与迭代分支桌面流程', () => {
  it('关联仓库、两个创建入口、分支保护、历史及重启恢复', async () => {
    await saved()
    if (process.env.SAY_CLEAR_GIT_PHASE === 'restore') {
      const expected = JSON.parse(await readFile(join(root, 'workspace-snapshot.json'), 'utf8'))
      assert.deepEqual(await saved(), expected)
      await manage()
      assert.match(await card('leads').getText(), /iteration\/管理保留/)
      await $('.management-tabs').$('button*=历史现状').click()
      assert.match(await $('.management-list').getText(), /iteration\/画板注册/)
      await unchangedRepository()
      await capture('git-restored.png')
      await $('.settings-button:not(.iteration-nav)').click()
      await $('#settings-title').waitForDisplayed()
      assert.equal(
        await $('[aria-label="Git 仓库地址"]').getValue(),
        pathToFileURL(repository.path).href,
      )
      await $('[aria-label="Git 仓库路径"]').waitForDisplayed()
      assert.equal(await $('[aria-label="Git 仓库路径"]').getValue(), expected.gitRepository.path)
      await $('button=克隆并读取分支').waitForEnabled()
      await $('button=克隆并读取分支').click()
      await $('button=保存关联').waitForEnabled()
      assert.equal(await $('[aria-label="Git 仓库路径"]').getValue(), expected.gitRepository.path)
      await capture('git-address-restored.png')
      return
    }

    await $('.settings-button:not(.iteration-nav)').click()
    await $('#settings-title').waitForDisplayed()
    await $('[aria-label="Git 仓库地址"]').waitForEnabled()
    await $('[aria-label="Git 仓库地址"]').setValue(repository.path)
    await $('button=读取仓库').click()
    await $('[aria-label="Git 仓库路径"]').waitForDisplayed()
    assert.equal(await $('[aria-label="Git 仓库路径"]').getValue(), repository.path)
    await select('默认基准分支', 'main')
    await $('button=保存关联').click()
    await browser.waitUntil(async () => (await saved()).gitRepository?.path === repository.path)
    await $('button=更换仓库').waitForEnabled()
    await $('button=保存关联').waitForEnabled()
    await capture('git-settings.png')
    await $('[aria-label="Git 仓库地址"]').setValue(join(root, 'missing-git-repository'))
    assert.equal(await $('button=保存关联').isEnabled(), false)
    await $('button=读取仓库').click()
    await $('.git-settings [role="alert"]').waitForDisplayed()
    assert.equal((await saved()).gitRepository.path, repository.path)
    assert.equal(await $('button=保存关联').isEnabled(), false)
    // The folder picker remains an alternative after a manually entered address fails.
    await $('button=更换仓库').click()
    await $('button=保存关联').waitForEnabled()
    assert.equal(await $('[aria-label="Git 仓库地址"]').getValue(), repository.path)
    await $('button=保存关联').click()
    await $('button=更换仓库').waitForEnabled()
    await $('button=返回工作空间').click()
    const linked = await saved()
    assert.deepEqual(linked.gitRepository, { path: repository.path, baseBranch: 'main' })
    const invalidRepository = await browser.execute(
      async (path) => {
        try {
          await window.__TAURI__.core.invoke('inspect_git_repository', { path })
          return null
        } catch (cause) {
          return String(cause)
        }
      },
      join(root, 'missing-git-repository'),
    )
    assert.match(invalidRepository, /Git|git|仓库/)

    await $('button=创建迭代').click()
    await $('[aria-label="迭代名称"]').setValue('注册流程与 Git')
    await $('[aria-label="Git 分支名称"]').setValue('iteration/画板注册')
    await select('迭代基准分支', 'release/base')
    await $('button=创建分支并开始迭代').waitForEnabled()
    await capture('git-create.png')
    await $('button=创建分支并开始迭代').click()
    const started = await closeSubmittedDialog()
    assertBinding(
      graph(started, 'fixture-project').iteration.git,
      'iteration/画板注册',
      'release/base',
      repository.baseCommit,
    )
    assert.match(await $('.iteration-context').getText(), /iteration\/画板注册/)
    assert.equal(await $('[aria-label="撤销画板操作"]').isEnabled(), false)
    await unchangedRepository()

    await $('[aria-label="组件 注册表单"]').click()
    await $('button=编辑组件').click()
    await $('[aria-label="组件说明"]').setValue('迭代中完善注册流程')
    await $('button=保存组件').click()
    await saved()
    await $('button=更新为现状').click()
    await $('button=确认更新现状').click()
    const published = await closeSubmittedDialog()
    assert.equal(graph(published, 'fixture-project').iteration, undefined)
    assertBinding(
      graph(published, 'fixture-project').history[0].git,
      'iteration/画板注册',
      'release/base',
      repository.baseCommit,
    )

    await $('button=创建迭代').click()
    await $('[aria-label="迭代名称"]').setValue('不应覆盖已有分支')
    await $('[aria-label="Git 分支名称"]').setValue('iteration/画板注册')
    await browser.waitUntil(async () =>
      (await $('.iteration-git-fields').getText()).includes('分支已存在'),
    )
    assert.equal(await $('button=创建分支并开始迭代').isEnabled(), false)
    assert.equal(graph(await saved(), 'fixture-project').iteration, undefined)
    await $('[aria-label="Git 分支名称"]').setValue('bad..branch')
    assert.equal(await $('button=创建分支并开始迭代').isEnabled(), false)
    await $('button=取消').click()

    await manage()
    const second = await startManaged('sales', '管理创建后放弃', 'iteration/管理放弃')
    assertBinding(
      graph(second, 'sales').iteration.git,
      'iteration/管理放弃',
      'main',
      repository.headCommit,
    )
    await card('sales').$('[aria-label="放弃迭代 管理创建后放弃"]').click()
    await $('button=放弃并恢复现状').click()
    const discarded = await closeSubmittedDialog()
    assert.equal(graph(discarded, 'sales').iteration, undefined)
    assert.equal(git('show-ref', '--hash', 'refs/heads/iteration/管理放弃'), repository.headCommit)
    const result = await startManaged('leads', '重启后继续迭代', 'iteration/管理保留')
    assertBinding(
      graph(result, 'leads').iteration.git,
      'iteration/管理保留',
      'main',
      repository.headCommit,
    )
    assert.equal(await $$('[data-iteration-board]').length, 1)
    await unchangedRepository()
    await capture('git-management.png')

    await $('.settings-button:not(.iteration-nav)').click()
    await $('#settings-title').waitForDisplayed()
    await $('[aria-label="Git 仓库地址"]').waitForEnabled()
    const remoteUrl = pathToFileURL(repository.path).href
    await $('[aria-label="Git 仓库地址"]').setValue(remoteUrl)
    assert.equal(await $('button=保存关联').isEnabled(), false)
    await $('button=克隆并读取分支').click()
    await $('button=保存关联').waitForEnabled()
    const clonePath = await $('[aria-label="Git 仓库路径"]').getValue()
    assert.notEqual(clonePath, repository.path)
    assert.equal(
      execFileSync('git', ['-C', clonePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      repository.headCommit,
    )
    await $('button=保存关联').click()
    await browser.waitUntil(async () => (await saved()).gitRepository?.remoteUrl === remoteUrl)
    await $('button=更换仓库').waitForEnabled()
    assert.deepEqual((await saved()).gitRepository, {
      path: clonePath,
      baseBranch: 'main',
      remoteUrl,
    })
    await capture('git-remote-address.png')
    await $('button=返回工作空间').click()
    await manage()
    const remoteResult = await startManaged('sales', '通过仓库地址创建', 'iteration/地址输入')
    assertBinding(
      graph(remoteResult, 'sales').iteration.git,
      'iteration/地址输入',
      'main',
      repository.headCommit,
      clonePath,
    )
    assert.equal(git('branch', '--list', 'iteration/地址输入'), '')
    await unchangedRepository()
    await writeFile(join(root, 'workspace-snapshot.json'), JSON.stringify(remoteResult, null, 2))
  })
})
