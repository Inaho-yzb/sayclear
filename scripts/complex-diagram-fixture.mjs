// A self-contained fixture for exploring deep navigation and connected board versions.
// Only domain objects are returned; callers decide where to save the generated systems.
export function createComplexDiagramSystems(m) {
  const id = (suffix) => `complex-${suffix}`
  const rootId = id('commerce')
  const analyticsId = id('analytics')
  const nodes = []
  const add = (suffix, parent, kind, name, description, extra = {}) => {
    const node = { id: id(suffix), parentId: id(parent), kind, name, description, ...extra }
    nodes.push(node)
    return node
  }
  const app = (suffix, name, description, extra) =>
    add(suffix, 'commerce', 'application', name, description, extra)
  const group = (suffix, parent, name, description, extra) =>
    add(suffix, parent, 'aggregate', name, description, extra)
  const leaf = (suffix, parent, name, config) =>
    add(suffix, parent, 'atomic', name, config.description, config)

  app('trade', '交易应用', '订单提交、取消与补偿编排；通过明确的业务事件联接支付、库存与履约。', {
    mode: 'route',
  })
  group('checkout', 'trade', '下单全流程', '准备交易上下文并创建订单；新旧库存预留能力可同时对照。')
  group('prepare', 'checkout', '交易准备', '并行完成身份与购物车校验，再统一计算优惠及应付金额。')
  group(
    'validation',
    'prepare',
    '提交前联合校验',
    '身份资格与商品有效性都通过后才能提交，任一不通过则拒绝。',
    { mode: 'parallel' },
  )
  leaf('identity', 'validation', '身份与限购资格', {
    description: '校验登录态、会员资格、黑名单和活动限购次数。',
    request: '读取购买人上下文',
    check: '购买资格校验',
    rule: '用户已登录且不在黑名单，活动内购买次数 < 限购上限',
    execute: '冻结本次活动购买资格',
    store: '购买资格快照',
    ok: '资格校验通过',
    failed: '购买资格拒绝',
  })
  leaf('cart', 'validation', '购物车与商品校验', {
    description: '批量核对 SKU、商品上下架状态与请求数量，拒绝部分无效购物车。',
    request: '接收购物车商品明细',
    check: '商品可售性校验',
    rule: '所有 SKU 已上架，购买数量 > 0 且 <= 单笔购买上限',
    execute: '生成已验证购物车',
    store: '购物车校验快照',
    ok: '商品校验通过',
    failed: '购物车不可提交',
  })
  leaf('price', 'prepare', '优惠叠加与金额试算', {
    description: '计算会员价、满减、优惠券和运费，校验服务端金额与用户确认金额一致。',
    request: '接收订单试算请求',
    check: '优惠券与金额校验',
    rule: '优惠券有效且未被核销，应付金额 >= 0，客户端金额 = 服务端金额',
    execute: '计算优惠分摊与应付金额',
    store: '价格分摊明细',
    ok: '金额试算完成',
    failed: '价格需要重新确认',
  })
  leaf('order-create', 'checkout', '订单创建与幂等落库', {
    description: '使用提交令牌防重，先确认库存预留，再持久化订单并请求支付授权。',
    request: '接收订单提交令牌',
    check: '提交幂等性校验',
    rule: '提交令牌有效；重复请求必须返回同一订单，不重复扣减资源',
    execute: '创建待支付订单',
    store: '订单与幂等映射表',
    ok: '订单创建成功',
    failed: '订单创建拒绝',
  })
  group(
    'cancel',
    'trade',
    '取消与补偿处理',
    '取消请求驱动退款和释放资源；所有补偿动作可重放并具有幂等标识。',
  )
  leaf('cancel-request', 'cancel', '取消资格与请求受理', {
    description: '区分未支付取消、已支付退款、已发货拦截；禁止已完成订单直接取消。',
    request: '接收用户取消请求',
    check: '订单取消资格校验',
    rule: '订单属于当前用户且未完成；已发货订单需先通过拦截审批',
    execute: '登记取消原因与补偿任务',
    store: '取消申请与任务表',
    ok: '取消申请已受理',
    failed: '取消申请不允许',
  })
  leaf('compensate', 'cancel', 'Saga 补偿与对账重试', {
    description: '接收退款及库存释放回执，对未完成步骤按指数退避重试；循环请求靠补偿 ID 去重。',
    request: '接收补偿任务或步骤回执',
    check: '补偿步骤与租约校验',
    rule: '补偿 ID 唯一；未完成步骤才能重试；已完成步骤仅确认回执',
    execute: '调度未完成的补偿步骤',
    store: 'Saga 步骤执行日志',
    ok: '全部补偿步骤完成',
    failed: '补偿进入人工处理',
  })

  app('payment', '支付应用', '支付渠道路由、回调验签、退款及账务一致性。', { mode: 'route' })
  group(
    'payment-route',
    'payment',
    '支付受理与回调',
    '发起支付授权，再接收渠道异步结果；回调不可信任客户端状态。',
  )
  leaf('authorize', 'payment-route', '渠道选择与支付授权', {
    description: '基于支付方式、金额和渠道健康度选择通道，使用请求号防止重复扣款。',
    request: '接收待支付订单',
    check: '金额与支付渠道校验',
    rule: '订单金额 > 0，币种支持且渠道健康，商户请求号尚未成功扣款',
    execute: '调用渠道预授权接口',
    store: '支付尝试与渠道流水',
    ok: '支付授权已受理',
    failed: '支付授权拒绝',
  })
  leaf('callback', 'payment-route', '回调验签与支付入账', {
    description: '对渠道回调验签并检查金额，幂等更新支付结果，发布支付成功或失败事件。',
    request: '接收渠道异步回调',
    check: '签名、金额与流水校验',
    rule: '签名可信且金额与订单一致，渠道流水未被其他订单使用',
    execute: '原子更新支付与账务状态',
    store: '支付结果与账务流水',
    ok: '支付入账成功',
    failed: '支付回调拒绝',
  })
  group(
    'refund',
    'payment',
    '退款与资金冲正',
    '先检查可退余额与审批结果，再调用原路退款并等待幂等结果。',
  )
  leaf('refund-validate', 'refund', '退款金额与权限校验', {
    description: '校验退款原因、审批权限及可退额度，避免并发超额退款。',
    request: '接收业务退款申请',
    check: '退款权限与余额校验',
    rule: '退款金额 <= 剩余可退金额，原因合法且审批权限满足要求',
    execute: '冻结本次可退额度',
    store: '退款额度占用记录',
    ok: '退款资格通过',
    failed: '退款资格拒绝',
  })
  leaf('refund-execute', 'refund', '退款执行与资源释放', {
    description: '幂等提交原路退款；退款确认后释放库存占用，并向补偿编排回传结果。',
    request: '接收已审批退款单',
    check: '退款幂等与渠道校验',
    rule: '退款请求号唯一，原交易已支付且目标渠道支持原路退款',
    execute: '调用原支付渠道退款',
    store: '退款单与渠道回执',
    ok: '退款执行成功',
    failed: '退款执行失败',
  })

  app('inventory', '库存应用', '跨仓库存预留、支付确认扣减、取消及超时释放。')
  group(
    'stock',
    'inventory',
    '库存占用生命周期',
    '按事件类型路由到预留、确认或释放；同一预留 ID 的状态转换不可逆。',
    { mode: 'route' },
  )
  leaf('reserve', 'stock', '库存预留与租约', {
    description: '按 SKU 和仓库原子占用库存，为待支付订单建立有时限的预留租约。',
    request: '接收 SKU 预留请求',
    check: '可售库存与租约校验',
    rule: '可售库存 >= 请求数量，预留 ID 唯一且租约时间在允许范围内',
    execute: '原子预留可售库存',
    store: '库存预留与租约表',
    ok: '库存预留成功',
    failed: '库存预留不足',
  })
  leaf('commit', 'stock', '支付成功确认扣减', {
    description: '支付成功后确认预留库存；重复支付事件只返回已处理结果。',
    request: '接收支付成功事件',
    check: '预留状态与支付结果校验',
    rule: '预留属于当前订单且状态为已预留，支付流水校验通过',
    execute: '确认库存扣减并关闭租约',
    store: '库存扣减与消费幂等表',
    ok: '库存扣减完成',
    failed: '库存确认异常',
  })
  leaf('release', 'stock', '库存释放与补偿回执', {
    description: '订单取消或租约超时后释放资源，将执行结果回传 Saga；已释放请求保持幂等。',
    request: '接收取消或租约到期事件',
    check: '释放条件与幂等校验',
    rule: '库存尚未确认出库；已释放请求不重复增加可售库存',
    execute: '释放剩余库存占用',
    store: '库存释放与补偿流水',
    ok: '库存释放完成',
    failed: '库存释放需要核对',
  })

  app('delivery', '履约应用', '多仓分配、出库打包、承运商路由与物流状态回流。')
  group('warehouse', 'delivery', '仓内履约', '先选择有货仓库，再生成拣货及包装任务。')
  leaf('allocate', 'warehouse', '多仓分配与拆单', {
    description: '按库存、距离、时效和成本拆分履约子单，支持单订单多仓发货。',
    request: '接收已支付履约单',
    check: '地址、仓库与库存校验',
    rule: '地址可配送，至少一个仓库可覆盖全部 SKU，拆单数量 <= 允许上限',
    execute: '生成仓库分配与拆单方案',
    store: '履约子单与仓库计划',
    ok: '仓库分配完成',
    failed: '仓库分配失败',
  })
  leaf('pack', 'warehouse', '拣货复核与包装出库', {
    description: '校验实物 SKU 与数量，超时任务可重派，复核通过后登记出库。',
    request: '接收仓库拣货任务',
    check: '商品与包装复核',
    rule: '实物 SKU、数量与子单一致，包装规格符合易碎及禁运要求',
    execute: '登记包装并确认出库',
    store: '包装清单与出库流水',
    ok: '仓库出库完成',
    failed: '仓内作业异常',
  })
  group(
    'transport',
    'delivery',
    '配送与签收回流',
    '创建运输任务，持续消费轨迹回调并收敛到签收或异常终态。',
  )
  leaf('dispatch', 'transport', '承运商路由与发货通知', {
    description: '根据目的地和包裹规格选承运商，下单成功后异步发送发货通知。',
    request: '接收已出库包裹',
    check: '承运商覆盖与运单校验',
    rule: '承运商覆盖目的地且运单未创建，重量体积在渠道上限内',
    execute: '创建承运商运单',
    store: '包裹与运单映射',
    ok: '运输任务创建成功',
    failed: '承运商受理失败',
  })
  leaf('track', 'transport', '物流轨迹与异常闭环', {
    description: '消费乱序或重复轨迹，异常进入工单并回补查询，签收后闭环履约。',
    request: '接收承运商轨迹回调',
    check: '轨迹验签与状态转换校验',
    rule: '运单归属匹配且回调签名可信，不允许已签收回退到运输中',
    execute: '更新物流状态与异常工单',
    store: '物流轨迹与异常工单',
    ok: '签收或异常闭环',
    failed: '物流事件需要人工核对',
  })

  app('message', '消息应用', '消息模板、渠道投递、重试退避及最终失败处理。')
  group(
    'message-policy',
    'message',
    '通知投递策略',
    '模板渲染后投递，临时失败进入退避队列，超过阈值进入死信。',
  )
  leaf('render', 'message-policy', '模板渲染与变量校验', {
    description: '按业务类型与语言选择模板，对敏感变量脱敏，生成可投递载荷。',
    request: '接收业务通知事件',
    check: '模板与变量完整性校验',
    rule: '模板已发布且必填变量完整，手机号等敏感信息已按渠道规则脱敏',
    execute: '渲染短信、站内信与邮件内容',
    store: '模板版本与渲染摘要',
    ok: '通知载荷生成成功',
    failed: '模板渲染拒绝',
  })
  leaf('deliver', 'message-policy', '多渠道投递与降级', {
    description: '按用户偏好选择渠道，主渠道超时切换备用渠道，同一业务消息保持幂等。',
    request: '接收已渲染通知载荷',
    check: '接收人偏好与频控校验',
    rule: '接收人允许该通知类型，渠道配置有效且未达到分钟级频控',
    execute: '调用主渠道并准备备用渠道',
    store: '渠道投递与回执记录',
    ok: '通知投递完成',
    failed: '通知投递最终失败',
  })
  leaf('retry', 'message-policy', '退避重试与死信处理', {
    description: '临时失败按指数退避重新投递，永久失败或超过次数进入死信队列。',
    request: '接收失败消息与重试时间',
    check: '重试次数与错误分类校验',
    rule: '错误属于可重试类型，当前重试次数 < 5，消息未过期',
    execute: '计算退避时间并重新入队',
    store: '重试队列与死信归档',
    ok: '消息重试已完成',
    failed: '消息进入死信队列',
  })

  const analyticsNodes = [
    {
      id: id('analytics-ingest'),
      parentId: analyticsId,
      kind: 'aggregate',
      name: '事件分析与指标汇总',
      description: '订阅交易链路事件，比较新旧支付回调并产出业务指标。',
    },
    {
      id: id('analytics-collect'),
      parentId: id('analytics-ingest'),
      kind: 'atomic',
      name: '事件采集与新旧版本对比',
      description: '消费消息投递和支付回调事件，保留来源版本用于归因对照。',
      request: '接收业务事件信封',
      check: '事件格式与来源校验',
      rule: '事件 ID 唯一，来源应用在允许列表中且事件时间合法',
      execute: '规范化业务事件与来源版本',
      store: '原始事件与版本映射',
      ok: '事件采集完成',
      failed: '事件进入隔离队列',
    },
    {
      id: id('analytics-metric'),
      parentId: id('analytics-ingest'),
      kind: 'atomic',
      name: '支付转化与履约漏斗',
      description: '按订单、渠道和时间窗口聚合指标，迟到事件触发增量补算。',
      request: '接收已规范化业务事件',
      check: '维度与时间窗口校验',
      rule: '订单与渠道维度齐全，迟到事件在可补算窗口内',
      execute: '增量计算支付与履约漏斗',
      store: '漏斗指标与补算任务',
      ok: '指标更新完成',
      failed: '指标计算需要修复',
    },
  ]
  const architecture = {
    ...m.createArchitecture(
      '电商履约 · 复杂全链路',
      '六层导航、五个应用边界、跨应用调用与事件、退款补偿环、新旧版本对照。建议先打开“下单全流程”或“电商履约 · 复杂全链路”的组合视图。',
    ),
    id: rootId,
    kind: 'system',
    boards: nodes.map(({ id, parentId, kind, name, description }) => ({
      id,
      parentId,
      kind,
      name,
      description,
    })),
  }
  const analytics = {
    ...m.createArchitecture(
      '经营分析 · 跨系统事件消费',
      '独立分析应用，订阅电商系统中的公开事件；用于测试跨系统引用与反向链路展开。',
    ),
    id: analyticsId,
    boards: analyticsNodes.map(({ id, parentId, kind, name, description }) => ({
      id,
      parentId,
      kind,
      name,
      description,
    })),
  }
  let workspace = m.initializeBoards({
    schemaVersion: 2,
    activeNodeId: rootId,
    systems: [m.buildSystem(architecture), m.buildSystem(analytics)],
  })
  const definitions = [
    { id: rootId, kind: 'system', name: architecture.name, description: architecture.description },
    ...nodes,
    {
      id: analyticsId,
      kind: 'application',
      name: analytics.name,
      description: analytics.description,
    },
    ...analyticsNodes,
  ]
  const byId = new Map(definitions.map((node) => [node.id, node]))
  const port = (id, name, dataType = 'object') => ({
    id,
    name,
    dataType,
    description: `${name}；携带 orderId、requestId 和 traceId。`,
  })
  const component = (type, componentId, name, description, x, y, exposed = false) => ({
    ...m.newComponent(type, { x, y }),
    id: componentId,
    name,
    description,
    exposed,
    ownerId: componentId === 'board-entry' ? null : 'board-entry',
    inputs: [port('request', '业务上下文')],
    outputs: [port('response', '处理结果')],
  })
  let edgeSequence = 0
  const edge = (
    source,
    target,
    name,
    type = 'control',
    condition = '',
    sourcePortId = null,
    targetPortId = null,
  ) => ({
    ...m.newConnection(source, target),
    id: `edge-${++edgeSequence}-${type}`,
    name,
    type,
    condition,
    sourcePortId,
    targetPortId,
    description: condition ? `${name}；仅在 ${condition} 时触发。` : name,
    protocol: type === 'event' ? '业务事件 / 幂等消费' : type === 'data' ? 'JSON' : '',
  })
  const update = (boardId, transform) => {
    workspace = m.updateNodeContent(workspace, boardId, (content) => ({
      ...content,
      diagram: transform(content.diagram),
      updatedAt: new Date().toISOString(),
    }))
  }
  const contracts = (node) => [
    component('capability', 'board-entry', node.name, node.description, 0, 140, true),
    component(
      'event',
      'result-ok',
      node.ok ?? `${node.name}完成`,
      '本图成功终态；携带业务结果和幂等标识，对外开放供其他画板订阅。',
      1680,
      140,
      true,
    ),
    component(
      'event',
      'result-failed',
      node.failed ?? `${node.name}失败`,
      '本图不可自动恢复的失败终态；包含原因码、已完成步骤和人工处理建议。',
      1680,
      540,
      true,
    ),
  ]
  for (const node of definitions) {
    const base = contracts(node)
    if (node.kind !== 'atomic') {
      const orchestrator = component(
        'action',
        'orchestrate',
        node.mode === 'route'
          ? '按业务动作分派'
          : node.mode === 'parallel'
            ? '并行发起校验'
            : '推进业务编排',
        '按照图中明确连接调度子流程；每个请求携带相同 traceId，结果必须幂等合并。',
        340,
        140,
      )
      const join = component(
        'action',
        'join',
        node.mode === 'parallel' ? '等待全部分支通过' : '汇合当前业务动作结果',
        '收集子流程完成状态；并行模式要求全部成功，路由模式只等待被选中的分支。',
        1320,
        140,
      )
      update(node.id, () => ({
        ...m.emptyDiagram(),
        components: [...base, orchestrator, join],
        connections: [
          edge(base[0], orchestrator, '开始编排'),
          edge(join, base[1], '发布本图完成事件', 'event'),
        ],
      }))
      continue
    }
    const request = component(
      'api',
      'request',
      node.request,
      '输入包含业务 ID、幂等请求号、发起方与 traceId；重复请求返回相同处理结果。',
      320,
      140,
    )
    const guard = component('validation', 'guard', node.check, node.rule, 640, 80)
    guard.outputs = [port('pass', '通过', 'boolean'), port('reject', '不通过', 'boolean')]
    guard.validation = {
      passCondition: 'all',
      strategy: 'stopWhenDecided',
      rules: [
        {
          id: 'business-rule',
          name: '业务条件',
          condition: node.rule,
          when: '',
          failureMessage: node.failed,
        },
        {
          id: 'idempotent-rule',
          name: '幂等和追踪标识',
          condition: 'requestId、业务 ID 和 traceId 完整；同一 requestId 不重复执行有副作用的动作',
          when: '',
          failureMessage: '缺少标识或请求状态冲突',
        },
      ],
    }
    const execute = component(
      'action',
      'execute',
      node.execute,
      '业务校验通过后执行；写操作受业务幂等键与数据库事务保护。',
      1000,
      140,
    )
    const store = component(
      'store',
      'store',
      node.store,
      '保存执行结果、请求摘要、版本与更新时间；失败重试查询已落库结果。',
      1340,
      140,
    )
    const reject = component(
      'action',
      'reject',
      '记录拒绝原因',
      '业务不满足时返回明确原因码，保留审计记录，不进入正常执行路径。',
      1000,
      540,
    )
    const retry = component(
      'action',
      'retry',
      '超时退避与有限重试',
      '仅网络超时、限流等暂时错误进入重试；最多三次，达到上限转失败终态。',
      1340,
      540,
    )
    const components = [...base, request, guard, execute, store, reject, retry]
    const connections = [
      edge(base[0], request, '接收业务请求'),
      edge(request, guard, '传入业务上下文', 'data', '', 'response', 'request'),
      edge(guard, execute, '通过后执行', 'control', '全部适用规则通过', 'pass', 'request'),
      edge(guard, reject, '拒绝并记录原因', 'control', '至少一条规则不通过', 'reject', 'request'),
      edge(execute, store, '事务写入处理结果', 'writes', '执行成功', 'response', 'request'),
      edge(store, base[1], '发布成功事件', 'event', '事务已提交', 'response', 'request'),
      edge(reject, base[2], '返回业务拒绝', 'event', '业务条件不满足', 'response', 'request'),
      edge(
        execute,
        retry,
        '进入临时错误重试',
        'control',
        '超时或可恢复错误',
        'response',
        'request',
      ),
      edge(
        retry,
        execute,
        '重试原业务步骤',
        'control',
        '重试次数 < 3 且幂等检查通过',
        'response',
        'request',
      ),
      edge(
        retry,
        base[2],
        '重试耗尽或永久失败',
        'event',
        '重试次数 >= 3 或错误不可恢复',
        'response',
        'request',
      ),
    ]
    update(node.id, () => m.layoutDiagram({ ...m.emptyDiagram(), components, connections }))
  }
  // Every definition is complete before references are adopted. Adding a reference
  // never changes the public entry/output contract of its source.
  const makeRef = (targetId, sourceId, version = 'current', details = {}, refId) => ({
    ...m.createReference(m.referenceBoards(workspace), targetId, {
      boardId: sourceId,
      componentId: 'board-entry',
      version,
      outputIds: ['result-ok', 'result-failed'],
      ...details,
    }),
    id: refId,
    ownerId: 'board-entry',
  })
  for (const node of definitions.filter((node) => node.kind !== 'atomic')) {
    let children = definitions.filter((child) => child.parentId === node.id)
    if (node.id === rootId)
      children = ['trade', 'inventory', 'payment', 'delivery', 'message'].map((suffix) =>
        byId.get(id(suffix)),
      )
    if (!children.length) continue
    const refs = children.map((child, index) => ({
      ...makeRef(node.id, child.id, 'current', {}, `ref-child-${index + 1}`),
      position: {
        x: 680 + index * 380,
        y: node.mode === 'route' || node.mode === 'parallel' ? 80 + index * 320 : 140,
      },
    }))
    update(node.id, (graph) => {
      const find = (componentId) => graph.components.find((c) => c.id === componentId)
      const start = find('orchestrate'),
        join = find('join'),
        failure = find('result-failed')
      const connections = [...graph.connections]
      for (const [index, ref] of refs.entries()) {
        const parallel = node.mode === 'route' || node.mode === 'parallel'
        const previous = index ? refs[index - 1] : start
        connections.push(
          edge(
            parallel || !index ? start : previous,
            ref,
            parallel ? `分派：${children[index].name}` : `进入：${children[index].name}`,
            'control',
            node.mode === 'route'
              ? `业务动作 = ${children[index].name}`
              : node.mode === 'parallel'
                ? '同一请求并行执行'
                : index
                  ? '上一步成功'
                  : '',
            index && !parallel ? m.exportedPortId(children[index - 1].id, 'result-ok') : 'response',
            ref.inputs[0].id,
          ),
        )
        if (parallel || index === refs.length - 1)
          connections.push(
            edge(
              ref,
              join,
              '收集成功结果',
              'event',
              node.mode === 'parallel' ? '全部并行分支成功后汇合' : '当前分支成功',
              m.exportedPortId(children[index].id, 'result-ok'),
              'request',
            ),
          )
        connections.push(
          edge(
            ref,
            failure,
            '传播子流程失败',
            'event',
            '子流程失败且无法自动恢复',
            m.exportedPortId(children[index].id, 'result-failed'),
            'request',
          ),
        )
      }
      join.position = { x: 680 + refs.length * 380, y: 140 }
      find('result-ok').position = { x: join.position.x + 340, y: 140 }
      failure.position = { x: join.position.x + 340, y: 620 }
      return m.layoutDiagram({ ...graph, components: [...graph.components, ...refs], connections })
    })
  }
  let crossCount = 0
  const crossByTarget = new Map()
  function cross(target, source, options = {}) {
    const targetId = id(target),
      sourceId = id(source)
    const sourceBoard = m.referenceBoards(workspace).find((b) => b.id === sourceId)
    const version = options.version ?? 'current'
    const details =
      version === 'history'
        ? { historyId: sourceBoard.diagram.history[0].id }
        : version === 'iteration'
          ? { iterationId: sourceBoard.diagram.iteration.id }
          : {}
    const ref = makeRef(targetId, sourceId, version, details, `ref-cross-${++crossCount}`)
    update(targetId, (graph) => {
      const index = crossByTarget.get(targetId) ?? 0
      crossByTarget.set(targetId, index + 1)
      ref.position = { x: 700 + (index % 3) * 380, y: 1100 + Math.floor(index / 3) * 280 }
      const find = (componentId) => graph.components.find((c) => c.id === componentId)
      const start = find(options.start ?? (find('execute') ? 'execute' : 'orchestrate'))
      const target = find(options.end ?? (find('store') ? 'store' : 'join'))
      if (options.subscribe) {
        const receiver = find('request')
        return m.layoutDiagram({
          ...graph,
          components: [...graph.components, ref],
          connections: [
            ...graph.connections,
            edge(
              ref,
              receiver,
              options.name ?? '消费来源成功事件',
              'event',
              options.when ?? '来源发布成功事件',
              m.exportedPortId(sourceId, 'result-ok'),
              receiver.inputs[0].id,
            ),
            edge(
              ref,
              receiver,
              '消费来源失败事件用于归因',
              'event',
              '来源发布业务失败事件；记录失败漏斗而非触发来源执行',
              m.exportedPortId(sourceId, 'result-failed'),
              receiver.inputs[0].id,
            ),
          ],
        })
      }
      let connections = graph.connections
      if (options.replace)
        connections = connections.filter(
          (connection) => !(connection.sourceId === start.id && connection.targetId === target.id),
        )
      const type = options.event ? 'event' : 'calls'
      return m.layoutDiagram({
        ...graph,
        components: [...graph.components, ref],
        connections: [
          ...connections,
          edge(
            start,
            ref,
            options.name ?? `调用${sourceBoard.name}`,
            type,
            options.when ?? '当前业务动作需要该能力',
            start.outputs[0]?.id ?? null,
            ref.inputs[0].id,
          ),
          edge(
            ref,
            target,
            '接收公开成功结果',
            'event',
            '关联请求成功；按 requestId 幂等合并',
            m.exportedPortId(sourceId, 'result-ok'),
            target.inputs[0]?.id ?? null,
          ),
          edge(
            ref,
            find('result-failed'),
            '接收公开失败结果',
            'event',
            '关联请求失败且无法自动恢复',
            m.exportedPortId(sourceId, 'result-failed'),
            'request',
          ),
        ],
      })
    })
  }
  cross('retry', 'deliver', { name: '退避到期后再次投递', when: '未过期且重试次数未达到阈值' })
  cross('deliver', 'retry', {
    name: '临时失败进入退避重试',
    event: true,
    when: '当前渠道返回可重试错误',
  })
  const versioned = (suffix, versionId, name, modify, publish) => {
    update(id(suffix), (graph) => {
      const next = m.startIteration(graph, name)
      next.iteration.id = id(versionId)
      modify(next)
      const laidOut = m.layoutDiagram(next)
      return publish ? m.publishIteration(laidOut) : laidOut
    })
  }
  versioned(
    'callback',
    'history-callback-v1',
    '渠道验签升级',
    (graph) => {
      const guard = graph.components.find((c) => c.id === 'guard'),
        execute = graph.components.find((c) => c.id === 'execute')
      const certificate = component(
        'rule',
        'certificate',
        '证书轮换与渠道流水复核',
        '新版增加渠道证书轮换检查；保留旧历史契约用于上线前后对照。',
        900,
        40,
      )
      graph.components.push(certificate)
      graph.connections = graph.connections.filter(
        (connection) => !(connection.sourceId === guard.id && connection.targetId === execute.id),
      )
      graph.connections.push(
        edge(guard, certificate, '进入新版验签复核', 'control', '基础规则通过', 'pass', 'request'),
        edge(
          certificate,
          execute,
          '证书与流水复核通过',
          'control',
          '当前证书有效且渠道流水一致',
          'response',
          'request',
        ),
        edge(
          certificate,
          graph.components.find((c) => c.id === 'result-failed'),
          '证书或流水异常',
          'event',
          '复核不通过',
          'response',
          'request',
        ),
      )
    },
    true,
  )
  versioned(
    'analytics-collect',
    'history-analytics-v1',
    '事件来源版本追踪',
    (graph) => {
      const execute = graph.components.find((c) => c.id === 'execute'),
        store = graph.components.find((c) => c.id === 'store')
      const version = component(
        'data',
        'source-version',
        '来源画板与版本标识',
        '新版事件信封补充来源画板、现状/迭代/历史标识，支持新旧链路归因对比。',
        1250,
        700,
      )
      graph.components.push(version)
      graph.connections.push(
        edge(execute, version, '记录来源版本', 'data', '', 'response', 'request'),
        edge(version, store, '持久化来源映射', 'writes', '', 'response', 'request'),
      )
    },
    true,
  )
  versioned(
    'reserve',
    'iteration-stock-v2',
    '预留租约超时自动释放',
    (graph) => {
      const execute = graph.components.find((c) => c.id === 'execute'),
        store = graph.components.find((c) => c.id === 'store')
      const lease = component(
        'state',
        'lease',
        '租约 Token 与超时释放状态',
        '新增租约版本和到期时间；支付确认与超时释放使用同一 Token 做乐观并发检查。',
        1250,
        700,
      )
      graph.components.push(lease)
      graph.connections.push(
        edge(execute, lease, '生成预留租约', 'data', '原子预留成功', 'response', 'request'),
        edge(lease, store, '保存租约状态', 'writes', '', 'response', 'request'),
      )
    },
    false,
  )
  versioned(
    'deliver',
    'iteration-message-v2',
    '主备渠道自动降级',
    (graph) => {
      const execute = graph.components.find((c) => c.id === 'execute'),
        store = graph.components.find((c) => c.id === 'store')
      const fallback = component(
        'action',
        'fallback',
        '两秒超时切换备用渠道',
        '新增备用投递路径；最终回执按消息 ID 去重，主备均失败才进入退避重试。',
        1250,
        900,
      )
      graph.components.push(fallback)
      graph.connections.push(
        edge(
          execute,
          fallback,
          '主渠道超时后降级',
          'control',
          '2 秒内未收到主渠道确认',
          'response',
          'request',
        ),
        edge(
          fallback,
          store,
          '保存备用渠道成功回执',
          'writes',
          '备用渠道成功',
          'response',
          'request',
        ),
        edge(
          fallback,
          graph.components.find((c) => c.id === 'retry'),
          '主备均失败后退避',
          'control',
          '备用渠道也返回临时错误',
          'response',
          'request',
        ),
      )
      graph.connections.find(
        (connection) => connection.sourceId === 'execute' && connection.targetId === 'retry',
      ).condition = '主渠道返回可重试错误且不满足备用渠道降级条件'
    },
    false,
  )

  cross('order-create', 'reserve', {
    version: 'iteration',
    start: 'guard',
    end: 'execute',
    replace: true,
    name: '调用新版库存预留',
    when: '校验通过且命中租约灰度',
  })
  cross('order-create', 'reserve', {
    start: 'guard',
    end: 'execute',
    name: '调用现状库存预留',
    when: '校验通过且未命中租约灰度',
  })
  cross('order-create', 'authorize', {
    start: 'store',
    end: 'result-ok',
    replace: true,
    name: '订单落库后请求支付授权',
    when: '订单事务已提交且需要在线支付',
  })
  cross('checkout', 'reserve', {
    start: 'orchestrate',
    end: 'join',
    name: '对照现状库存契约',
    when: '灰度关闭时采用现状能力',
  })
  cross('checkout', 'reserve', {
    version: 'iteration',
    start: 'orchestrate',
    end: 'join',
    name: '对照租约迭代契约',
    when: '灰度开启时采用迭代能力',
  })
  cross('cancel-request', 'refund-validate', {
    name: '已支付订单申请退款',
    when: '订单已支付且允许取消',
  })
  cross('compensate', 'refund-execute', {
    name: '幂等重试未完成退款',
    when: '退款步骤未完成，补偿 ID 未处理',
  })
  cross('refund-execute', 'release', { name: '退款确认后释放占用', when: '渠道确认退款成功' })
  cross('release', 'compensate', {
    name: '回传库存释放补偿结果',
    event: true,
    when: '库存释放成功且属于 Saga 补偿任务',
  })
  cross('callback', 'commit', {
    name: '支付入账后确认库存',
    event: true,
    when: '验签成功且支付结果为成功',
  })
  cross('dispatch', 'deliver', {
    version: 'iteration',
    name: '使用主备渠道发送发货通知',
    event: true,
    when: '承运商已受理运单',
  })
  cross('analytics-collect', 'callback', {
    version: 'history',
    name: '固定旧版支付入账契约',
    subscribe: true,
    event: true,
    when: '对照上线前的支付转化统计',
  })
  cross('analytics-collect', 'callback', {
    name: '订阅当前支付入账事件',
    subscribe: true,
    event: true,
    when: '计算当前支付转化统计',
  })
  cross('analytics-collect', 'deliver', {
    name: '订阅通知投递结果',
    subscribe: true,
    event: true,
    when: '追踪通知到达对支付转化的影响',
  })
  cross('analytics-metric', 'reserve', {
    name: '关联现状库存预留结果',
    subscribe: true,
    event: true,
    when: '计算库存不足导致的漏斗损失',
  })
  cross('commerce', 'analytics', {
    name: '跨系统交付经营分析事件',
    event: true,
    when: '交易链路产生可归因业务事件',
  })

  workspace = m.workspaceSchema.parse(workspace)
  const boards = m.referenceBoards(workspace)
  let references = 0,
    histories = 0,
    iterations = 0,
    components = 0,
    connections = 0
  for (const board of boards) {
    components += board.diagram.components.length
    connections += board.diagram.connections.length
    histories += board.diagram.history.length
    iterations += board.diagram.iteration ? 1 : 0
    const snapshots = [
      board.diagram,
      board.diagram.iteration?.baseline,
      ...board.diagram.history.map((version) => version.snapshot),
    ].filter(Boolean)
    for (const graph of snapshots)
      for (const component of graph.components) {
        if (!component.reference) continue
        references++
        const resolution = m.resolveReference(boards, component)
        if (resolution.status !== 'ok')
          throw new Error(`${board.name} / ${component.name}：${resolution.message}`)
      }
  }
  const scopes = workspace.systems.flatMap((system) => m.flattenArchitecture(system.architecture))
  return {
    systems: workspace.systems,
    activeNodeId: rootId,
    summary: {
      systems: workspace.systems.length,
      applications: scopes.filter((node) => node.type === 'application').length,
      boards: boards.length,
      maxDepth: Math.max(...scopes.map((node) => node.depth)) + 1,
      components,
      connections,
      references,
      iterations,
      histories,
      boardVersions: boards.length + iterations + histories,
      entryBoards: {
        overview: rootId,
        checkout: id('checkout'),
        deepest: id('identity'),
        compensationCycle: id('compensate'),
        messageCycle: id('message-policy'),
        crossSystemAnalytics: analyticsId,
        versionComparison: id('checkout'),
      },
    },
  }
}
