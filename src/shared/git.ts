import { z } from 'zod'

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !!path.trim() && !path.includes('\0'))
const remoteUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((address) => !!address.trim() && !/\p{Cc}/u.test(address))
export const gitBranchSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((branch) => !!branch.trim() && !/\p{Cc}/u.test(branch))
export const gitRepositorySchema = z
  .object({
    path: repositoryPathSchema,
    baseBranch: gitBranchSchema,
    remoteUrl: remoteUrlSchema.optional(),
  })
  .strict()
export const iterationGitSchema = z
  .object({
    repositoryPath: repositoryPathSchema,
    branch: gitBranchSchema,
    baseBranch: gitBranchSchema,
    baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  })
  .strict()
export const gitRepositoryInfoSchema = z.object({
  path: repositoryPathSchema,
  currentBranch: gitBranchSchema.nullable(),
  branches: z.array(gitBranchSchema),
  remoteUrl: remoteUrlSchema.optional(),
})
export type GitRepository = z.infer<typeof gitRepositorySchema>
export type IterationGit = z.infer<typeof iterationGitSchema>
export type GitRepositoryInfo = z.infer<typeof gitRepositoryInfoSchema>
export type GitStartOptions = { branch: string; baseBranch: string }

// This only chooses UI copy; the native resolver validates the address before using it.
export function isRemoteRepositoryAddress(address: string): boolean {
  const value = address.trim()
  return (
    /^(?:https?|ssh|file):\/\//i.test(value) ||
    (!/^[A-Za-z]:[\\/]/.test(value) && /^[^/\\\s@:]+@[^/\\\s:]+:.+/.test(value))
  )
}

export function gitBranchError(branch: string): string | null {
  if (
    !gitBranchSchema.safeParse(branch).success ||
    branch === '@' ||
    branch.startsWith('-') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[ ~^:?*[\\]/.test(branch) ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')) ||
    branch.endsWith('.')
  )
    return '请填写有效的 Git 分支名，例如 iteration/signup'
  return null
}

export function defaultIterationBranch(
  name = '',
  suffix = crypto.randomUUID().slice(0, 8),
): string {
  const slug = name
    .trim()
    .replace(/\p{Cc}/gu, '-')
    .replace(/[\s~^:?*[\\/@{}]+/g, '-')
    .replace(/\.+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return `iteration/${slug ? `${slug}-` : ''}${suffix}`
}
