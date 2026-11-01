import { describe, expect, it } from 'vitest'
import {
  defaultIterationBranch,
  gitBranchError,
  gitRepositorySchema,
  gitRepositoryInfoSchema,
  isRemoteRepositoryAddress,
  iterationGitSchema,
} from '../src/shared/git'
import { emptyDiagram, diagramSchema } from '../src/shared/diagram'
import { startIteration, renameIteration, publishIteration } from '../src/shared/iteration'
import { createInitialWorkspace, parseWorkspace } from '../src/shared/model'

const git = {
  repositoryPath: '/项目/代码 仓库',
  branch: 'iteration/注册改版-12345678',
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
}

describe('Git 仓库与迭代关联', () => {
  it('识别远程地址并保留本地路径输入方式', () => {
    for (const address of [
      'https://github.com/team/project.git',
      'http://git.example.com/project.git',
      'ssh://git@git.example.com:2222/team/project.git',
      'git@git.example.com:team/project.git',
      'file:///tmp/源仓库',
    ])
      expect(isRemoteRepositoryAddress(address), address).toBe(true)
    for (const address of ['/项目/代码 仓库', '~/code/project', 'C:\\code\\project', ''])
      expect(isRemoteRepositoryAddress(address), address).toBe(false)
  })
  it('保存远程地址及已克隆目录，并拒绝控制字符', () => {
    const repository = {
      path: '/本地/仓库',
      baseBranch: 'main',
      remoteUrl: 'git@git.example.com:team/project.git',
    }
    expect(gitRepositorySchema.parse(repository)).toEqual(repository)
    expect(
      gitRepositoryInfoSchema.parse({
        path: repository.path,
        currentBranch: 'main',
        branches: ['main'],
        remoteUrl: repository.remoteUrl,
      }).remoteUrl,
    ).toBe(repository.remoteUrl)
    expect(
      gitRepositorySchema.safeParse({ ...repository, remoteUrl: 'ssh://bad\naddress' }).success,
    ).toBe(false)
    const workspace = createInitialWorkspace()
    workspace.gitRepository = repository
    expect(parseWorkspace(JSON.parse(JSON.stringify(workspace))).gitRepository).toEqual(repository)
  })
  it('分支默认值兼容中文、特殊字符和空名称，并用独立后缀避免重名', () => {
    for (const name of [
      '',
      '  注册流程  ',
      'feature / a..b@{x}.lock',
      '\u0001bad\u007fname',
      'a'.repeat(300),
    ]) {
      const branch = defaultIterationBranch(name, '12345678')
      expect(branch.startsWith('iteration/')).toBe(true)
      expect(gitBranchError(branch)).toBeNull()
    }
    expect(defaultIterationBranch()).not.toEqual(defaultIterationBranch())
  })
  it('拒绝 Git 非法分支名，允许中文与多层分支', () => {
    for (const branch of [
      '',
      '-main',
      '@',
      'a b',
      'a..b',
      'a@{b',
      'a\\b',
      'a[b',
      '/a',
      'a/',
      'a//b',
      '.a',
      'a/.b',
      'a.lock',
      'a.',
      'a\nb',
      'a'.repeat(241),
    ]) {
      expect(gitBranchError(branch), branch).not.toBeNull()
    }
    for (const branch of ['main', 'feature/注册', 'iteration/signup-123', 'release/v1.2']) {
      expect(gitBranchError(branch), branch).toBeNull()
    }
  })
  it('校验仓库字段、Git 提交哈希及向后兼容的工作区', () => {
    expect(iterationGitSchema.parse(git)).toEqual(git)
    expect(iterationGitSchema.safeParse({ ...git, baseCommit: 'a'.repeat(64) }).success).toBe(true)
    expect(iterationGitSchema.safeParse({ ...git, baseCommit: 'unknown' }).success).toBe(false)
    expect(gitRepositorySchema.safeParse({ path: '/tmp/\0bad', baseBranch: 'main' }).success).toBe(
      false,
    )
    const workspace = createInitialWorkspace()
    expect(parseWorkspace(workspace).gitRepository).toBeUndefined()
    workspace.gitRepository = { path: git.repositoryPath, baseBranch: git.baseBranch }
    expect(parseWorkspace(JSON.parse(JSON.stringify(workspace))).gitRepository).toEqual(
      workspace.gitRepository,
    )
  })
  it('改名和完成迭代保留原分支及基准提交，下一次迭代独立关联', () => {
    const graph = startIteration(emptyDiagram(), '改版')
    graph.iteration!.git = git
    const renamed = renameIteration(diagramSchema.parse(graph), '完善注册')
    expect(renamed.iteration!.git).toEqual(git)
    const published = diagramSchema.parse(publishIteration(renamed))
    expect(published.history[0].git).toEqual(git)
    expect(startIteration(published, '下一次迭代').iteration!.git).toBeUndefined()
  })
})
