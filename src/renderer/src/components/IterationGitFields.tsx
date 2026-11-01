import { useEffect, useState } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import {
  gitBranchError,
  type GitRepository,
  type GitRepositoryInfo,
  type GitStartOptions,
} from '../../../shared/git'
import { inspectRepository } from '../services/git'
import { isDesktop } from '../services/desktop'
import './git.css'

export function IterationGitFields({
  repository,
  value,
  onChange,
  onReadyChange,
  disabled = false,
}: {
  repository: GitRepository
  value: GitStartOptions
  onChange: (value: GitStartOptions) => void
  onReadyChange: (ready: boolean) => void
  disabled?: boolean
}) {
  const [info, setInfo] = useState<GitRepositoryInfo | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    setInfo(null)
    void inspectRepository(repository.path)
      .then(
        (next) => {
          if (!disposed) setInfo(next)
        },
        (cause: unknown) => {
          if (!disposed) setError(cause instanceof Error ? cause.message : '无法读取 Git 仓库')
        },
      )
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [repository.path, refresh])
  const validBase = !!info?.branches.includes(value.baseBranch)
  const branchError = gitBranchError(value.branch)
  const exists = !!info?.branches.includes(value.branch)
  const ready = !loading && !error && validBase && !branchError && !exists
  useEffect(() => {
    onReadyChange(ready)
  }, [ready, onReadyChange])
  return (
    <div className="iteration-git-fields">
      <div className="iteration-git-heading">
        <GitBranch size={15} />
        <strong>同步创建 Git 分支</strong>
        <button
          type="button"
          className="button text compact"
          disabled={disabled || loading || !isDesktop}
          onClick={() => setRefresh((count) => count + 1)}
          aria-label="刷新 Git 分支"
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <p className="iteration-git-path" title={repository.path}>
        {repository.path}
      </p>
      <label>
        新分支名称
        <input
          aria-label="Git 分支名称"
          required
          maxLength={240}
          value={value.branch}
          disabled={disabled || !isDesktop}
          spellCheck={false}
          onChange={(event) => onChange({ ...value, branch: event.target.value })}
        />
      </label>
      <label>
        基准分支
        <select
          aria-label="迭代基准分支"
          value={value.baseBranch}
          disabled={disabled || loading || !isDesktop}
          required
          onChange={(event) => onChange({ ...value, baseBranch: event.target.value })}
        >
          {!validBase && (
            <option value={value.baseBranch}>
              {loading ? '正在读取分支…' : `${value.baseBranch || '请选择基准分支'}（不可用）`}
            </option>
          )}
          {info?.branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-directory-hint">
        创建本地分支并保存迭代关联，代码目录保持当前检出的分支。
      </p>
      {(error || branchError || exists || (!loading && info && !validBase)) && (
        <p className="form-error" role="alert">
          {error ||
            branchError ||
            (exists ? '分支已存在，请使用新的分支名称' : '基准分支已不存在，请重新选择')}
        </p>
      )}
    </div>
  )
}
