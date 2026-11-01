import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react'
import {
  isRemoteRepositoryAddress,
  type GitRepository,
  type GitRepositoryInfo,
} from '../../../shared/git'
import { chooseRepository, inspectRepository, resolveRepository } from '../services/git'
import { isDesktop } from '../services/desktop'
import './git.css'

export function GitRepositorySettings({
  repository,
  onSave,
}: {
  repository?: GitRepository
  onSave: (repository: GitRepository | undefined) => Promise<void>
}) {
  const repositoryPath = repository?.path
  const storedBaseBranch = repository?.baseBranch
  const storedAddress = repository?.remoteUrl ?? repositoryPath ?? ''
  const [address, setAddress] = useState(storedAddress)
  const [loadedAddress, setLoadedAddress] = useState('')
  const [info, setInfo] = useState<GitRepositoryInfo | null>(null)
  const [baseBranch, setBaseBranch] = useState(storedBaseBranch ?? '')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const requestState = useRef({ sequence: 0, busy: false })

  useEffect(() => {
    const state = requestState.current
    const sequence = ++state.sequence
    setAddress(storedAddress)
    setLoadedAddress('')
    setBaseBranch(storedBaseBranch ?? '')
    setInfo(null)
    setError('')
    state.busy = !!repositoryPath && isDesktop
    setBusy(state.busy ? '正在读取仓库…' : '')
    if (repositoryPath && isDesktop)
      void inspectRepository(repositoryPath)
        .then(
          (next) => {
            if (sequence !== state.sequence) return
            setInfo(next)
            setLoadedAddress(storedAddress)
          },
          (cause: unknown) => {
            if (sequence === state.sequence)
              setError(cause instanceof Error ? cause.message : '无法读取 Git 仓库')
          },
        )
        .finally(() => {
          if (sequence === state.sequence) {
            state.busy = false
            setBusy('')
          }
        })
    return () => {
      state.sequence++
      state.busy = false
    }
  }, [repositoryPath, storedAddress, storedBaseBranch])

  const perform = async (status: string, action: (current: () => boolean) => Promise<void>) => {
    const state = requestState.current
    if (state.busy) return
    const sequence = ++state.sequence
    const current = () => sequence === state.sequence
    state.busy = true
    setBusy(status)
    setError('')
    setSaved('')
    try {
      await action(current)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : '无法保存 Git 设置')
    } finally {
      if (current()) {
        state.busy = false
        setBusy('')
      }
    }
  }
  const acceptRepository = (next: GitRepositoryInfo, input: string, preserveBase = false) => {
    const nextAddress = isRemoteRepositoryAddress(input) ? input.trim() : next.path
    setAddress(nextAddress)
    setLoadedAddress(nextAddress)
    setInfo(next)
    setBaseBranch(
      preserveBase && next.branches.includes(baseBranch)
        ? baseBranch
        : (next.currentBranch ?? next.branches[0] ?? ''),
    )
  }
  const remote = isRemoteRepositoryAddress(address)
  const loadAddress = () =>
    perform(remote ? '正在克隆仓库并读取分支…' : '正在读取仓库…', async (current) => {
      const input = address.trim()
      if (!input) throw new Error('请填写 Git 仓库地址')
      const next = await resolveRepository(input)
      if (current()) acceptRepository(next, input, loadedAddress === input)
    })
  const validInfo = info && loadedAddress === address.trim() ? info : null
  const validBase = !!validInfo?.branches.includes(baseBranch)

  return (
    <section className="settings-section" aria-labelledby="workspace-git-title">
      <h2 id="workspace-git-title">Git 仓库</h2>
      <div className="settings-card git-settings" aria-busy={!!busy}>
        <div className="settings-row">
          <div>
            <h3>
              <GitBranch size={16} /> 关联代码仓库
            </h3>
            <p>创建迭代时，从基准分支拉出独立的 Git 分支。</p>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={!isDesktop || !!busy}
            onClick={() =>
              void perform('正在选择仓库…', async (current) => {
                const next = await chooseRepository()
                if (next && current()) acceptRepository(next, next.path)
              })
            }
          >
            <FolderOpen size={14} />
            {repository ? '更换仓库' : '选择仓库'}
          </button>
        </div>
        <form
          className="git-address-form"
          onSubmit={(event) => {
            event.preventDefault()
            void loadAddress()
          }}
        >
          <label htmlFor="git-repository-address">仓库地址</label>
          <div className="git-address-input-row">
            <input
              id="git-repository-address"
              className="settings-directory-path"
              aria-label="Git 仓库地址"
              value={address}
              required
              maxLength={4096}
              disabled={!isDesktop || !!busy}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/team/project.git 或本地仓库路径"
              onChange={(event) => {
                setAddress(event.target.value)
                setLoadedAddress('')
                setInfo(null)
                setBaseBranch('')
                setError('')
                setSaved('')
              }}
            />
            <button
              type="submit"
              className="button secondary"
              disabled={!isDesktop || !!busy || !address.trim()}
            >
              {remote ? '克隆并读取分支' : '读取仓库'}
            </button>
          </div>
          <p className="settings-directory-hint">
            支持 HTTPS、SSH 地址和本地目录。远程仓库会克隆到本地，使用本机已有的 Git 登录配置。
          </p>
        </form>
        {!isDesktop && (
          <p className="settings-directory-hint">
            请在桌面版中关联 Git 仓库。浏览器预览支持查看已保存的关联信息。
          </p>
        )}
        {validInfo && (
          <>
            <label className="git-local-path">
              本地仓库目录
              <input
                className="settings-directory-path"
                aria-label="Git 仓库路径"
                readOnly
                value={validInfo.path}
                title={validInfo.path}
              />
            </label>
            <div className="git-settings-fields">
              <label>
                默认基准分支
                <select
                  aria-label="默认基准分支"
                  value={baseBranch}
                  disabled={!!busy || !isDesktop}
                  onChange={(event) => {
                    setBaseBranch(event.target.value)
                    setSaved('')
                  }}
                >
                  {!validBase && (
                    <option value={baseBranch}>
                      {baseBranch || '请选择基准分支'}
                      {baseBranch ? '（不可用）' : ''}
                    </option>
                  )}
                  {validInfo.branches.map((branch) => (
                    <option value={branch} key={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button text compact"
                disabled={!!busy || !isDesktop}
                onClick={() => void loadAddress()}
              >
                <RefreshCw size={14} />
                刷新分支
              </button>
            </div>
            <p className="settings-directory-hint">
              每次创建迭代可修改分支名与基准分支。创建本地分支后，代码目录保持当前检出的分支。完成或放弃迭代后，Git
              分支继续保留。
            </p>
          </>
        )}
        {(repository || validInfo) && (
          <div className="git-settings-actions">
            {repository && (
              <button
                type="button"
                className="button text"
                disabled={!!busy || !isDesktop}
                onClick={() =>
                  void perform('正在解除关联…', async (current) => {
                    await onSave(undefined)
                    if (!current()) return
                    setAddress('')
                    setLoadedAddress('')
                    setInfo(null)
                    setBaseBranch('')
                    setSaved('已解除仓库关联')
                  })
                }
              >
                解除关联
              </button>
            )}
            <button
              type="button"
              className="button primary compact"
              disabled={!!busy || !isDesktop || !validBase}
              onClick={() =>
                void perform('正在保存关联…', async (current) => {
                  if (!validInfo) throw new Error('请先读取仓库并选择基准分支')
                  const next = await inspectRepository(validInfo.path)
                  if (!current()) return
                  setInfo(next)
                  if (!next.branches.includes(baseBranch))
                    throw new Error('基准分支已不存在，请刷新后重新选择')
                  await onSave({
                    path: next.path,
                    baseBranch,
                    ...(remote ? { remoteUrl: address.trim() } : {}),
                  })
                  if (current()) setSaved('Git 仓库关联已保存')
                })
              }
            >
              保存关联
            </button>
          </div>
        )}
        {busy && (
          <p className="git-loading" role="status">
            <LoaderCircle size={14} className="spin" />
            {busy}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {saved && (
          <p className="git-saved" role="status">
            {saved}
          </p>
        )}
      </div>
    </section>
  )
}
