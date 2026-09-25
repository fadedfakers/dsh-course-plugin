/**
 * 就绪清单（Readiness）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 现在装完插件，面板是空的，用户得自己找「哪里不对」。而这几件事
 * **任何一件缺失，症状都是「面板打不开 / 答不出来」**，从界面上分不出是哪一件：
 *
 *   · 身份没填     → 老师那边看到的提问者是 `Administrator`（机器用户名），不是学生
 *   · 找不到工作区 → 面板全空，还以为是插件坏了
 *   · 模型没设     → 一提问就报错，而报错信息看起来像网络问题
 *   · 课程没就位   → 课件、教案、索引全是空的
 *
 * 清单把这些「说不清的故障」变成「缺哪一项，点一下怎么补」。
 *
 * ── 一条硬规则：只报**能自己判定的**事实 ─────────────────────────────
 * 每一项都必须是插件真的查过的东西（文件在不在、字段空不空），
 * 不做「可能吧」的推测。清单可信，用户才会照着做；
 * 报一条假问题，后面每一条他都会怀疑。
 */

/**
 * 生成学生端的就绪清单。
 *
 * @param core  createCore 的返回值
 * @param me    describeMe() 的结果（身份）
 * @param opts.workspaceOk   工作区里有没有 课程中心/
 * @param opts.hasModel      llm 服务在不在
 * @param opts.course        当前课程信息
 */
export function studentReadiness(core, me, opts) {
  const o = opts || {}
  const items = []
  const push = (key, ok, title, detail, fix) => items.push({ key, ok, title, detail, fix: fix || '' })

  // ① 身份。没填的症状最隐蔽：功能全正常，只是老师看到的是一串机器用户名
  push('identity', !!(me && me.identified), '我是谁',
    me && me.identified
      ? ((me.label || me.sid) + '　老师看到的提问者就是这个')
      : ('现在用的是「' + ((me && me.sid) || '') + '」，来自' + ((me && me.how) || '系统')
        + '。这多半不是你 —— 老师那边看到的就是这一串'),
    me && me.identified ? '' : '填一次学号与姓名（只写在这台机器上，不进任何仓库）')

  // ② 工作区。找不到的症状是「面板全空」，很容易被当成插件坏了
  push('workspace', !!o.workspaceOk, '课程工作区',
    o.workspaceOk
      ? (o.workspace || '')
      : '没有找到课程工作区（里面应该有 课程中心/课程结构索引.json）',
    o.workspaceOk ? '' : '把课程仓库 clone 到本机，或在课程配置里指定它的位置')

  // ③ 模型。没设的症状是一提问就报错，而报错看起来像网络问题
  push('model', !!o.hasModel, '模型',
    o.hasModel
      ? ('提问与批改用 ' + ((o.modelLabel) || '会话默认模型') + '，费用记在你自己账号上')
      : 'DSH 里还没有可用的模型 —— 这时提问会直接失败',
    o.hasModel ? '' : '在 DSH 里配置一个模型（面板不替你设，那属于别的插件的领地）')

  // ④ 课程。有了工作区但课程没就位时，课件与教案是空的
  push('course', !!(o.course && (o.course.title || o.course.code)), '课程信息',
    o.course && (o.course.title || o.course.code)
      ? ((o.course.title || '') + (o.course.code ? ('（' + o.course.code + '）') : '')
        + '　教案 ' + (o.lessonCount || 0) + ' 课时')
      : '还没认到是哪一门课',
    o.course && (o.course.title || o.course.code) ? '' : '确认课程配置.json 里有课程名与课程码')

  const missing = items.filter((x) => !x.ok)
  return {
    role: 'student',
    items,
    missing: missing.length,
    // canStart 的判据刻意**不含身份**：没填身份也能提问（只是老师认不出是谁），
    // 把它算成「不能开始」会让一个可选步骤变成硬门槛。
    canStart: !!(o.workspaceOk && o.hasModel),
    blockedBy: missing.filter((x) => x.key === 'workspace' || x.key === 'model').map((x) => x.key),
  }
}

/**
 * 教师端的就绪清单。
 *
 * 比学生端多两件只有老师才有的东西：
 *   · **公开仓有没有推上去** —— 没推的话学生 clone 到的是旧内容，而老师以为发布了
 *   · **名册填了没有** —— 没填的话满屏都是学号
 *
 * 另外单列一条「本周要做什么」：把已有数据变成一句能照着做的事，
 * 而不是让老师在五个标签页里自己拼。
 */
export function teacherReadiness(core, opts) {
  const o = opts || {}
  const items = []
  const push = (key, ok, title, detail, fix) => items.push({ key, ok, title, detail, fix: fix || '' })

  push('workspace', !!o.workspaceOk, '课程工作区',
    o.workspaceOk ? (o.workspace || '') : '没有找到课程工作区（里面应该有 课程中心/课程结构索引.json）',
    o.workspaceOk ? '' : '把课程仓库放到本机，或用 CIP_WORKSPACE 指定')

  push('course', !!(o.course && (o.course.title || o.course.code)), '课程信息',
    o.course && (o.course.title || o.course.code)
      ? ((o.course.title || '') + (o.course.code ? ('　课程码 ' + o.course.code) : ''))
      : '还没配课程名与课程码 —— 它们决定私有数据目录与公开仓名',
    o.course && (o.course.title || o.course.code) ? '' : '在 课程配置.json 里填课程名与课程码（课程码用英文）')

  push('index', !!o.hasIndex, '课程结构索引',
    o.hasIndex ? ('共 ' + (o.totalLessons || 0) + ' 课时') : '没有 课程中心/课程结构索引.json —— 面板不知道这门课有哪些课时',
    o.hasIndex ? '' : '从教学大纲生成索引，或复制一份改')

  push('plans', (o.missingPlan || 0) === 0, '教案覆盖',
    o.hasIndex
      ? ('有教案 ' + (o.withPlan || 0) + ' / ' + (o.totalLessons || 0)
        + ((o.missingPlan || 0) ? ('　缺 ' + o.missingPlan + ' 课时') : '　已齐'))
      : '索引还没有，无法统计',
    (o.missingPlan || 0) ? '去「教案补全」生成草稿，审完采纳' : '')

  push('roster', (o.named || 0) > 0 || (o.students || 0) === 0, '学生名册',
    (o.students || 0) === 0
      ? '还没有学生数据（他们提问或交作业后会自动出现）'
      : ('学生 ' + o.students + ' 人，其中 ' + (o.named || 0) + ' 人有姓名'),
    ((o.students || 0) > 0 && !(o.named || 0)) ? '去「学生」页给学号补上真名，之后一眼就认得' : '')

  // 公开仓：没推上去时学生拿到的是旧内容，而老师以为已经发布了
  if (o.publish) {
    push('publish', !o.publish.pending && !!o.publish.hasRemote, '公开仓',
      !o.publish.hasRemote
        ? '公开仓的 remote 还没配 —— 学生 clone 不到任何东西'
        : (o.publish.pending
          ? ((o.publish.unpublished || 0) + ' 个文件还没发布到公开仓')
          : '已同步'),
      (!o.publish.hasRemote || o.publish.pending)
        ? '在「归档发布」里发布，然后按提示 git push（推送要用你的凭据，插件里不放密钥）' : '')
  }

  const missing = items.filter((x) => !x.ok)
  return {
    role: 'teacher',
    items,
    missing: missing.length,
    canStart: !!(o.workspaceOk && o.hasIndex),
    blockedBy: missing.filter((x) => x.key === 'workspace' || x.key === 'index').map((x) => x.key),
    todo: o.todo || [],
  }
}

/**
 * 「今天要做什么」—— 把五个标签页里的数字压成一句能照着做的事。
 * 不做成统计面板，因为老师要的不是数字，是「先干哪件事」。
 */
export function teacherTodo(counts) {
  const c = counts || {}
  const out = []
  if (c.ungraded) out.push(c.ungraded + ' 份提交未批改')
  if (c.sharedUnanswered) out.push(c.sharedUnanswered + ' 条已公开但你还没答复')
  if (c.missingPlan) out.push(c.missingPlan + ' 课时缺教案')
  if (c.unnamed) out.push(c.unnamed + ' 个学生还没姓名')
  if (c.unpublished) out.push(c.unpublished + ' 个文件待发布')
  return out
}
