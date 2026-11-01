import { gitRepositoryInfoSchema, type GitRepositoryInfo } from '../../../shared/git'
import { isDesktop, nativeInvoke } from './desktop'

export async function inspectRepository(path: string): Promise<GitRepositoryInfo> {
  if (!isDesktop) throw new Error('请在桌面版中关联本地 Git 仓库')
  return gitRepositoryInfoSchema.parse(await nativeInvoke('inspect_git_repository', { path }))
}

export async function chooseRepository(): Promise<GitRepositoryInfo | null> {
  if (!isDesktop) throw new Error('请在桌面版中关联本地 Git 仓库')
  const selected = await nativeInvoke('choose_git_repository')
  return selected === null ? null : gitRepositoryInfoSchema.parse(selected)
}

export async function resolveRepository(address: string): Promise<GitRepositoryInfo> {
  if (!isDesktop) throw new Error('请在桌面版中关联 Git 仓库')
  return gitRepositoryInfoSchema.parse(
    await nativeInvoke('resolve_git_repository', { address: address.trim() }),
  )
}
