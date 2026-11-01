import { z } from 'zod'

export const validationRuleSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().trim().min(1, '请填写规则名称').max(80),
    condition: z.string().trim().min(1, '请填写规则判断条件').max(1000),
    when: z.string().max(1000),
    failureMessage: z.string().max(1000),
  })
  .strict()

export const validationSchema = z
  .object({
    passCondition: z.enum(['all', 'any']),
    strategy: z.enum(['collectAll', 'stopWhenDecided']),
    rules: z.array(validationRuleSchema).max(32, '最多添加 32 条校验规则'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.rules.map((rule) => rule.id)).size !== value.rules.length)
      ctx.addIssue({ code: 'custom', message: '校验规则 ID 不能重复' })
  })

export type Validation = z.infer<typeof validationSchema>
export type ValidationRule = z.infer<typeof validationRuleSchema>
export const newValidation = (): Validation => ({
  passCondition: 'all',
  strategy: 'collectAll',
  rules: [],
})
export const newValidationRule = (): ValidationRule => ({
  id: crypto.randomUUID(),
  name: '',
  condition: '',
  when: '',
  failureMessage: '',
})
export const passConditionLabels = { all: '全部满足', any: '任一满足' } as const
export function validationStrategyLabel(value: Validation): string {
  if (value.strategy === 'collectAll') return '检查全部，汇总结果'
  return value.passCondition === 'all' ? '首条失败即停止' : '首条通过即停止'
}
export function validationDescription(value: Validation): string {
  const outcome =
    value.passCondition === 'all'
      ? '所有适用规则都满足时通过；任一失败则不通过。'
      : '至少一条适用规则满足时通过；全部失败则不通过。'
  return `按列表顺序检查；适用条件不满足的规则跳过。${outcome}未配置规则或没有适用规则时不通过。`
}
export function describeValidation(value: Validation): string {
  return [
    `通过条件：${passConditionLabels[value.passCondition]}`,
    `检查方式：${validationStrategyLabel(value)}`,
    ...value.rules.map(
      (rule, i) =>
        `${i + 1}. ${rule.name}：${rule.condition}${rule.when ? `；适用条件：${rule.when}` : ''}${rule.failureMessage ? `；失败提示：${rule.failureMessage}` : ''}`,
    ),
    ...(value.rules.length ? [] : ['未配置规则']),
  ].join('\n')
}
