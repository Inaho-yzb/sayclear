import { manageIteration, type IterationAction } from '../../../shared/iteration-management'
import { type Workspace } from '../../../shared/model'
import { gitBranchError, type GitStartOptions } from '../../../shared/git'
import { storage } from './storage'

export async function applyIterationAction(
  workspace: Workspace,
  action: IterationAction,
  options?: GitStartOptions,
): Promise<Workspace> {
  const next = manageIteration(workspace, action)
  if (action.type !== 'start' || !workspace.gitRepository) return next
  if (!options) throw new Error('请选择基准分支并填写新分支名')
  const error = gitBranchError(options.branch) ?? gitBranchError(options.baseBranch)
  if (error) throw new Error(error)
  return storage.createGitIteration(next, action.boardId, options)
}
