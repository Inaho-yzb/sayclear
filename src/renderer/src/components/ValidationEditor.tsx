import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import {
  newValidationRule,
  passConditionLabels,
  validationDescription,
  validationStrategyLabel,
  type Validation,
  type ValidationRule,
} from '../../../shared/validation'

export function ValidationEditor({
  value,
  onChange,
}: {
  value: Validation
  onChange: (value: Validation) => void
}) {
  const updateRule = (id: string, patch: Partial<ValidationRule>) =>
    onChange({
      ...value,
      rules: value.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    })
  const move = (index: number, offset: number) => {
    const rules = [...value.rules]
    ;[rules[index], rules[index + offset]] = [rules[index + offset], rules[index]]
    onChange({ ...value, rules })
  }
  return (
    <fieldset className="diagram-ports-editor validation-editor">
      <legend>
        校验规则与策略 <span>{value.rules.length} / 32</span>
      </legend>
      <div className="diagram-form-row">
        <label>
          整体通过条件
          <select
            aria-label="整体通过条件"
            value={value.passCondition}
            onChange={(e) =>
              onChange({ ...value, passCondition: e.target.value as Validation['passCondition'] })
            }
          >
            <option value="all">全部满足（AND）</option>
            <option value="any">任一满足（OR）</option>
          </select>
        </label>
        <label>
          检查方式
          <select
            aria-label="校验检查方式"
            value={value.strategy}
            onChange={(e) =>
              onChange({ ...value, strategy: e.target.value as Validation['strategy'] })
            }
          >
            <option value="collectAll">检查全部，汇总结果</option>
            <option value="stopWhenDecided">
              {value.passCondition === 'all' ? '首条失败即停止' : '首条通过即停止'}
            </option>
          </select>
        </label>
      </div>
      <p className="type-description">{validationDescription(value)}</p>
      <ol className="validation-rule-edit-list">
        {value.rules.map((rule, index) => (
          <li className="validation-rule-edit" key={rule.id}>
            <div className="validation-rule-heading">
              <strong>规则 {index + 1}</strong>
              <div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`上移规则 ${index + 1}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`下移规则 ${index + 1}`}
                  disabled={index === value.rules.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`删除规则 ${index + 1}`}
                  onClick={() =>
                    onChange({ ...value, rules: value.rules.filter((r) => r.id !== rule.id) })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <label>
              规则名称
              <input
                required
                maxLength={80}
                aria-label={`规则 ${index + 1} 名称`}
                value={rule.name}
                placeholder="例如：邮箱格式正确"
                onChange={(e) => updateRule(rule.id, { name: e.target.value })}
              />
            </label>
            <label>
              判断条件
              <textarea
                required
                maxLength={1000}
                rows={2}
                aria-label={`规则 ${index + 1} 判断条件`}
                value={rule.condition}
                placeholder="满足什么条件才算通过"
                onChange={(e) => updateRule(rule.id, { condition: e.target.value })}
              />
            </label>
            <div className="diagram-form-row">
              <label>
                适用条件（选填）
                <input
                  maxLength={1000}
                  aria-label={`规则 ${index + 1} 适用条件`}
                  value={rule.when}
                  placeholder="留空表示始终检查"
                  onChange={(e) => updateRule(rule.id, { when: e.target.value })}
                />
              </label>
              <label>
                失败提示（选填）
                <input
                  maxLength={1000}
                  aria-label={`规则 ${index + 1} 失败提示`}
                  value={rule.failureMessage}
                  placeholder="不满足时提示什么"
                  onChange={(e) => updateRule(rule.id, { failureMessage: e.target.value })}
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
      {!value.rules.length && (
        <p className="type-description">尚未添加规则。添加后可用上下箭头调整检查顺序。</p>
      )}
      <button
        type="button"
        className="button text compact"
        disabled={value.rules.length >= 32}
        onClick={() => onChange({ ...value, rules: [...value.rules, newValidationRule()] })}
      >
        <Plus size={14} /> 添加规则
      </button>
    </fieldset>
  )
}

export function ValidationSummary({ value }: { value: Validation }) {
  return (
    <div className="validation-node-summary">
      <div className="validation-node-policy">
        <strong>{value.rules.length} 条规则 · 按序检查</strong>
        <span>{passConditionLabels[value.passCondition]}</span>
      </div>
      <ol>
        {value.rules.slice(0, 3).map((rule) => (
          <li
            key={rule.id}
            title={`${rule.name}：${rule.condition}${rule.when ? `（适用：${rule.when}）` : ''}`}
          >
            {rule.name}
          </li>
        ))}
      </ol>
      <div className="validation-node-more">
        {value.rules.length > 3
          ? `另有 ${value.rules.length - 3} 条，点击查看全部`
          : value.rules.length
            ? '适用条件不满足时跳过'
            : '未配置规则 · 不通过'}
      </div>
      <div className="validation-node-strategy">{validationStrategyLabel(value)}</div>
    </div>
  )
}

export function ValidationDetails({ value }: { value: Validation }) {
  return (
    <section className="diagram-detail-section validation-details" aria-label="校验规则详情">
      <h3>校验规则 · {value.rules.length} 条</h3>
      <dl className="diagram-metadata">
        <div>
          <dt>通过条件</dt>
          <dd>{passConditionLabels[value.passCondition]}</dd>
        </div>
        <div>
          <dt>检查方式</dt>
          <dd>{validationStrategyLabel(value)}</dd>
        </div>
      </dl>
      <p>{validationDescription(value)}</p>
      <ol>
        {value.rules.map((rule) => (
          <li key={rule.id}>
            <strong>{rule.name}</strong>
            <p>{rule.condition}</p>
            <p>适用：{rule.when || '始终检查'}</p>
            <p>失败提示：{rule.failureMessage || '未填写'}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
