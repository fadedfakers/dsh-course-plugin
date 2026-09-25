/**
 * dsh-course-teacher —— 教师端课程面板（宿主半区）
 *
 * 与学生端是两个独立插件：前缀不同、侧栏入口不同、能同时装。
 * 教师端在学生端之上多出四件事：
 *   1. 看到**全部**学生的提问与提交（学生端只能看到自己的 + 已公开的）
 *   2. 审计：把一条学生提问判成「值得共享」或「只答本人」
 *   3. 汇总共性问题：同一个问题被多个学生踩到，才值得沉淀
 *   4. 归档与发布：把策展结果写进公共面，交给 git 同步出去
 *   5. 教案补全：老师给 PPT / 示例代码，模型补出同构教案，老师审批后才成为基准
 *
 * 关于「花不花额度」—— 这两件事必须分开看：
 *   审计、共性问题、汇总、发布：**纯读写**，一分钱不花。
 *   教案补全（plan.*）：老师主动发起的写作任务，一次一课，花**他自己**的额度，
 *     面板上明说「这一步会用模型」，用量随结果一起回报。
 *   学生端的提问与批改：花**学生**的额度，与教师端无关。
 * 「谁发起谁付费」是这门课一开始就定下的口径，两条路不能混。
 */
import { loadCore, PLUGIN_ROOT } from './core-loader.js'

export const name = 'course-panel-teacher'
export const inject = ['webServer']

const PREFIX = process.env.CIP_TEA_PREFIX || '/cip-tea'
const LABEL = '至圣先师鼹鼠精·教师端'
const COURSE_CODE = process.env.CIP_COURSE_CODE || ''

/** 教师端自己的模型选择（不写进 DSH 设置，也不和学生端共用一份） */
const TEACHER_MODEL_REL = '教案草稿\\_模型.json'

/**
 * 公开仓工作区与发布清单的位置。
 *
 * 它们是**课程仓库的东西**，不是本包的一部分 —— 换一门课时它们跟着工作区走。
 * 所以统一写成相对工作区的路径常量，而不是在几个动作里各写一遍字符串：
 * 发布页要新建仓库、要判断清单在不在，两处写不一致的症状是
 * 「状态卡说没有清单，而发布工具明明生成过」。
 */
const PUBLIC_REPO_REL = '课程发布\\public'
const PUBLISH_MANIFEST_REL = '课程发布\\publish.manifest.json'

/**
 * git 本体的候选路径。
 *
 * ⚠️ 教师机上 git 装在 D:\Git\cmd\git.exe，而**它未必在 PATH 里** ——
 *    面板进程是 DSH 拉起来的，继承的是 DSH 自己的环境。只写 'git' 会得到
 *    ENOENT，报出来却是「找不到 git」，明明装了。所以先试写死的路径，再回落 'git'。
 */
const GIT_HARD_PATH = 'D:\\Git\\cmd\\git.exe'

export async function apply(ctx) {
  const C = await loadCore()
  const core = C.createCore(ctx, { prefix: PREFIX, role: 'teacher', pkgRoot: PLUGIN_ROOT, label: LABEL })
  core.warn()

  const {
    oneLine, today, safeId,
    // ⚠️ 这里**故意不**解构 PUBLIC_ITEMS_REL / STUDENT_ITEMS_REL。
    //    它们是内核的**模块级**常量，写死的是默认形状（'课程问题池\公共'）；
    //    而 createCore 内部用同名的**局部** const 把布局配置遮蔽掉了
    //    （这样那几十处老代码一个字都不用改就跟着配置走）。
    //    于是「解构进来的那个」永远是默认值、「core.PUBLIC_ITEMS_REL」才是按
    //    课程配置算出来的那个 —— 两个名字长得一样、值不一样，这是最坏的一种。
    //    症状：老师把 questionsRel 配成「答疑」后，界面上仍显示「课程问题池\公共」，
    //    而审计「共享给学生」那一步会把副本写进**默认目录**、core.writeItem 却写进
    //    **配置目录** —— 两条路径分叉，学生在面板里看不到老师共享的那条。
    //    凡是目录类常量，一律从 **core 实例**上取，不要从模块上解构。
    // 教案补全。注意这里没有 callModel —— 模型调用只发生在 runPlanDraft 里，
    // 由 core 统一扣在「发起方」头上，教师端不自己拼消息。
    PLAN_DRAFT_DIR, PLAN_SECTIONS, listModelCatalog,
    outlineStatus, collectLesson, sliceSlideText, runPlanDraft,
    readAnchors, writeAnchors, inferModuleSpans, anchorFor,
    findDraft, saveDraft, removeDraft, updateDraftMeta, readDraftIndex,
    acceptDraft, rebuildIndex, planTemplate, parsePlan,
    // 多轮改稿：与学生提问同一套证据形状（拖选文字 / 框选截图）
    runPlanRevise, snapshotDraft, MAX_PLAN_IMAGES, PLAN_HISTORY_DIR,
    // 人的身份：名册是老师维护的，显示名以它为准（学生自填的名字会填错）
    readRoster, writeRoster, readStudentInfo, nameOf, labelOf, ROSTER_REL,
    // 就绪清单 + 今天要做什么
    teacherReadiness, teacherTodo,
    // 材料归位建议（只读）：老师上传课程文件时先说清「建议放哪、为什么」
    suggestPlacement, planWrites, TARGETS,
    // 仓库管理（发布页）。这一组里只有 remoteUrl() 会碰到 token，而且**只在内存里拼** ——
    // 它唯一的去处是「显示给老师自己敲」的那条命令。readRepoState() 的返回已经脱敏，
    // 界面拿到的 remote 永远不含凭据（这条踩过两次，见 repo.js 里的注释）。
    repoSlug, readRepoState, repoSummary, manualSteps, remoteUrl,
    // 起子进程并**收回输出**。必须用它，不能用带 encoding 的 spawnSync ——
    // 沙箱不给管道，那种写法一律 EPERM 且不抛异常（详见 core/src/run.js）。
    runCaptured, runOutput, runExitCode,
  } = C

  const TEACHER = safeId(process.env.CIP_TEACHER || process.env.USERNAME || 'teacher') || 'teacher'

  /**
   * 显示名解析器。**每次现读名册**，不缓存 ——
   * 老师刚在「学生」页改完名字，提问列表里就该立刻是新名字。
   * 名册是个几百字节的小文件，读它比缓存失效出错便宜得多。
   */
  function who(sid) {
    if (!sid) return ''
    const roster = readRoster(core)
    const info = readStudentInfo(core, sid)
    return { sid, name: nameOf(sid, roster, info), label: labelOf(sid, roster, info) }
  }

  /** 归一化问题文本，用来判断「是不是同一个问题」 */
  function fingerprint(s) {
    return oneLine(s)
      .replace(/[\s，。、；：（）()【】\[\]「」《》"'`]/g, '')
      .replace(/^(为什么|为何|请问|如何|怎么|什么是)/, '')
      .toLowerCase()
      .slice(0, 40)
  }

  /** 从一条条目的正文/线程里取出「问题文本」，用于聚合 */
  function problemTextOf(it) {
    if (it.title) return it.title
    return ''
  }

  // ── 教师端的模型选择 ─────────────────────────────────────────
  function readModelChoice() {
    try {
      if (!core.exists(TEACHER_MODEL_REL)) return null
      const j = JSON.parse(core.readText(TEACHER_MODEL_REL))
      return (j && j.provider && j.model) ? j : null
    } catch (e) { return null }
  }
  function writeModelChoice(sel) {
    try {
      core.writeText(TEACHER_MODEL_REL, JSON.stringify(sel || { provider: '', model: '' }, null, 2) + '\n')
      return true
    } catch (e) { return false }
  }
  function resolveChoice(saved, catalog) {
    if (saved && saved.provider && saved.model) return saved
    return (catalog && catalog.current) || null
  }

  /**
   * 课件「课时分隔页」的模块归并结果。
   *
   * 为什么要单独一个函数：它一次要读 3 个章节的 JSON（每个上百 KB），
   * 而 outline.status / plan.draft / anchor.set 都要用它。
   * 读三次会让「生成一份教案」白等好几秒。
   */
  const spanCache = { at: 0, spans: {}, byChapter: {} }
  async function moduleSpans() {
    if (spanCache.at && Date.now() - spanCache.at < 60000) return spanCache
    const byChapter = {}
    for (const ch of (C.CHAPTERS || [])) {
      try {
        const d = await core.getSlides(ch)
        if (d && !d.error) byChapter[ch] = d
      } catch (e) { /* 某一章读不出来不影响其它章 */ }
    }
    spanCache.spans = inferModuleSpans(byChapter)
    spanCache.byChapter = byChapter
    spanCache.at = Date.now()
    return spanCache
  }

  /**
   * 取某课时的课件正文（供提示词）。没有课件页就返回 null，绝不编。
   * 只在「锚点确认」这类只需要页码的地方用 —— 生成教案时正文由
   * collectLesson 自己取（见 plan.js 里的注释：别让调用方有机会忘掉它）。
   */
  async function slideTextFor(lessonNo, moduleName) {
    const { spans, byChapter } = await moduleSpans()
    const anchors = readAnchors(core)
    const a = anchorFor(lessonNo, moduleName, spans, anchors)
    if (!a) return { anchor: null, slideText: null }
    const data = byChapter[a.chapter]
    if (!data) return { anchor: null, slideText: null }
    return { anchor: a, slideText: sliceSlideText(data, a.from, a.to) }
  }

  const handlers = {
    async info() {
      const items = await core.listItems()
      const byScope = { public: 0, student: 0, legacy: 0 }
      const students = new Set()
      for (const i of items) {
        byScope[i.scope] = (byScope[i.scope] || 0) + 1
        if (i.student) students.add(i.student)
      }
      // 名册人数单列：数据里有 3 个学号、名册里只认领了 1 个，是个值得看见的差
      const rosterNow = readRoster(core)
      const named = [...students].filter((s) => nameOf(s, rosterNow, readStudentInfo(core, s))).length
      const subs = core.listSubmissions()
      const subStudents = new Set(subs.map((s) => s.student).filter(Boolean))
      // 顺手把「学生公开了 / 没公开」分开报：老师看到的条目数与他实际能处理的数量
      // 应该对得上，否则他会以为「怎么才这么几条」。
      const sharedCount = items.filter((i) => i.audit === 'shared').length
      return Object.assign(core.info(), {
        teacher: TEACHER, courseCode: COURSE_CODE,
        counts: {
          items: items.length, byScope,
          shared: sharedCount, notShared: items.length - sharedCount,
          students: students.size, submissions: subs.length, submitStudents: subStudents.size,
          named,
        },
        publicDir: core.PUBLIC_ITEMS_REL, studentDir: core.STUDENT_ITEMS_REL,
      })
    },
    async tree() { return { tree: await core.getTree() } },
    async slides(args) { return (await core.getSlides(args && args.chapter)) || { error: '该章课件数据不存在' } },
    async docs(args) {
      if (args && typeof args.path === 'string' && args.path) {
        return { path: args.path, name: args.path.split('\\').pop(), text: core.readText(args.path) }
      }
      return { docs: await core.listDocs() }
    },

    /**
     * 条目列表。
     *
     * ⚠️ 默认 **onlyShared**：只给老师看**学生主动公开过**的条目（audit === 'shared'）。
     *
     * 为什么改：作业批改一次会判出十几条问题，原来它们全部自动流向教师端 ——
     * 老师那边瞬间堆到 76 条，绝大多数是同一份代码的细节，他根本看不过来。
     * 现在公开与否由**学生**决定（学生端「我的提问」里逐条或批量选择）。
     *
     * 但老师仍然需要能审计：`onlyShared: false` 就是「全部（含学生未公开的）」视图，
     * 用于排查「某个学生是不是卡住了」这类问题。默认关闭不是藏起来，是排序 ——
     * 默认给他最该看的那些。
     */
    async threads(args) {
      const input = args && typeof args === 'object' ? args : {}
      const onlyShared = input.onlyShared !== false
      const all = (await core.listItems()).map((i) => Object.assign({}, i, {
        // 「谁提问的」——原来这一栏是 Administrator（机器用户名），
        // 对教学毫无用处。现在在学生数据出去之前统一贴一个能认的名字。
        who: who(i.student),
      }))
      let items = onlyShared ? all.filter((i) => i.audit === 'shared') : all
      if (input.student) items = items.filter((i) => i.student === input.student)
      if (input.scope) items = items.filter((i) => i.scope === input.scope)
      if (input.lesson) items = items.filter((i) => String(i.lesson) === String(input.lesson))
      const students = [...new Set(all.map((i) => i.student).filter(Boolean))].sort()
      return {
        teacher: TEACHER, items, students, publicDir: core.PUBLIC_ITEMS_REL,
        onlyShared: onlyShared,
        // 让界面能说清「还有多少条学生没公开」—— 老师有权知道有这个池子，
        // 但默认不去打扰他。
        hidden: onlyShared ? all.filter((i) => i.audit !== 'shared').length : 0,
        total: all.length,
      }
    },
    /**
     * 教师答复：把老师的文字回答追加进这条提问的线程。
     *
     * 为什么要单独一个动作：
     *   审计（audit）决定的是**去向**，答复是**内容**。两者经常不同步 ——
     *   有的问题只答本人（不进公共池），但学生仍然需要拿到那段回答；
     *   有的问题值得共享，老师也可能先答再决定。混在一个动作里，
     *   就会出现「为了答复学生而不得不先决定是否公开」这种别扭的流程。
     *
     * 答复以 by:'teacher' 记进线程，学生端会把它显示成「教师答复」而不是 AI 答复 ——
     * 两者的可信度不同，界面上不能混为一谈。
     */
    async answer(args) {
      const input = args && typeof args === 'object' ? args : {}
      const p = typeof input.path === 'string' ? input.path : ''
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!p || !core.exists(p)) throw new Error('条目不存在')
      if (!text) throw new Error('答复内容不能为空')

      const it = core.readItem(p)
      const turns = it.turns
      turns.push({ by: 'teacher', q: '', a: text, at: new Date().toISOString(), author: TEACHER })
      const sections = core.sectionsOf(it.body)
      it.fields.updated = today()
      if (it.fields.status === '待处理') it.fields.status = '已答复'
      it.fields.teacher = TEACHER
      core.writeItem(p, it.fields, sections, turns)

      // 如果这条已经公开过，公共面那份也要同步 —— 否则全班看到的是没有老师答复的版本，
      // 而提问的那个学生看到了，两边内容不一致。
      let syncedPublic = false
      const pubRel = core.PUBLIC_ITEMS_REL + '\\' + p.split('\\').pop()
      if (core.exists(pubRel)) {
        const pubIt = core.readItem(pubRel)
        const pubTurns = pubIt.turns
        pubTurns.push({ by: 'teacher', q: '', a: text, at: new Date().toISOString(), author: TEACHER })
        core.writeItem(pubRel, Object.assign({}, it.fields, { audit: 'shared' }), core.sectionsOf(pubIt.body), pubTurns)
        syncedPublic = true
      }
      return { ok: true, path: p, turns: turns.length, syncedPublic, status: it.fields.status }
    },

    /**
     * 插件内的发布入口：真的去跑发布工具，而不是让老师自己去敲命令。
     * 只跑 `course-repo.mjs publish`（写公开仓工作区）—— 这一步不需要 git 凭据。
     * git commit / push 仍留给老师手动执行，因为那一步要用他的凭据，
     * 而凭据不该进插件（设计原则：插件里不放任何人的密钥）。
     */
    async publish(args) {
      const input = args && typeof args === 'object' ? args : {}
      const mode = input.mode === 'check' ? 'check' : 'publish'
      const fs = await import('node:fs')
      const pathMod = await import('node:path')
      // ── 发布工具在哪 ────────────────────────────────────────────────────
      // 按顺序试三个位置，第一个存在的胜出：
      //
      //   ① CIP_REPO_TOOL       显式指定。给「工具不在常规位置」的课用。
      //   ② <工作区>/课程发布/course-repo.mjs
      //                         **课程仓库自带**的位置。老师自己那门课的仓库里
      //                         就有一份（它是课程的东西，跟着课程走）。
      //   ③ <本包>/../tools/course-repo.mjs
      //                         插件仓库里的那一份。**只在 monorepo 检出时成立** ——
      //                         三个包并排躺在同一个仓库里，父目录就是仓库根。
      //                         profile 用 link: 装的时候三个包各自被 link 进
      //                         node_modules，父目录是 node_modules，这一步找不到，
      //                         所以它只是「万一在 monorepo 里跑」的便利，不是主路径。
      //
      // ⚠️ 为什么要写这条注释：从 GitHub 装插件的人**工作区里没有** 课程发布/ ——
      //    发布工具是课程仓库的东西，不是插件自带的。所以「找不到」在这个场景下
      //    是**正常状态**，不是故障。报错必须告诉他去哪儿拿，
      //    否则他会以为插件坏了（原来的文案只说了一句「这台机器上可能不是课程工作区」）。
      const candidates = [
        process.env.CIP_REPO_TOOL || '',
        pathMod.join(core.WORKSPACE, '课程发布', 'course-repo.mjs'),
        pathMod.join(PLUGIN_ROOT, '..', 'tools', 'course-repo.mjs'),
      ].filter(Boolean)
      const tool = candidates.find((p) => fs.existsSync(p)) || ''
      if (!tool) {
        return {
          ok: false,
          notFound: true,
          error: '没有找到发布工具 course-repo.mjs。它是**课程仓库**的一部分，不是插件自带的，'
            + '所以刚装完插件时它不存在是正常的。三个办法（任选一个）：'
            + '① 把课程仓库里的 课程发布/course-repo.mjs 放回 <工作区>/课程发布/；'
            + '② 用环境变量 CIP_REPO_TOOL 指到它的绝对路径；'
            + '③ 如果你的课不用这套发布流程，这一步可以跳过 —— '
            + '「发布」只是把公共面写进公开仓工作区，手工复制同样可行。'
            + '　（找过：' + candidates.join('　|　') + '）',
          tried: candidates,
        }
      }
      // ⚠️ 必须显式告诉发布工具「发的是哪个工作区」，并且 cwd 也用工作区。
      //
      //    工具默认按「它自己就在 <工作区>/课程发布/ 里」推工作区（WORKSPACE = HERE/..）。
      //    从 GitHub 装插件的人，工具在插件仓库的 tools/ 下 —— 按 HERE 推出来的
      //    「工作区」会指向插件仓库的父目录。**它不报错**，只是把内容发到别处，
      //    或者报一堆莫名其妙的「找不到课时」。所以这里把 CIP_WORKSPACE 显式传下去，
      //    工具那边也支持这个覆盖口（见 course-repo.mjs 的 WORKSPACE 注释）。
      //    cwd 同样用工作区：万一工具里还有别的相对路径，落点才是对的。
      const r = runCaptured(process.execPath, [tool, mode], {
        cwd: core.WORKSPACE,
        timeout: 120000,
        hintDir: core.WORKSPACE,
        env: Object.assign({}, process.env, { CIP_WORKSPACE: core.WORKSPACE }),
      })
      const out = runOutput(r)
      // ⚠️ ok 必须由 runExitCode 判定，不能写 r.status === 0：
      //    起不来时 status 是 null，而每次调用都成功时 status 才是 0。
      //    「起不来」和「跑成功」绝不能落到同一个分支上。
      const code = runExitCode(r)
      return {
        ok: code === 0, mode, exit: code, output: out.slice(-4000),
        next: [
          'cd ' + pathMod.join(core.WORKSPACE, '课程发布', 'public'),
          'git add -A && git commit -m "publish: ..."',
          'git push',
        ],
        note: 'git 那三步要你自己执行 —— 提交与推送要用你的凭据，插件里不放任何人的密钥。',
      }
    },

    async thread(args) {
      const p = args && typeof args.path === 'string' ? args.path : ''
      if (!p || !core.exists(p)) throw new Error('条目不存在：' + p)
      const it = core.readItem(p)
      // fields 里补一个 who：详情页顶部「谁提问的」用的就是它。
      // 不在客户端拼，是因为名册可能与列表返回时已经不同 ——
      // 老师刚在「学生」页改完名字，点进详情就该看到新名字。
      const fields = Object.assign({}, it.fields, { who: who(it.fields.student) })
      return { path: p, fields, body: it.body, turns: it.turns }
    },

    /**
     * 审计：一条学生提问的去向。
     *   shared  → 进公共面（写进 课程问题池/公共/），下次发布带给全班
     *   private → 留在该学生的私有目录里，只答本人
     * 老师可以顺手改标题与总结 —— 这是「统一风格」的最后一关：
     * 模型凝练过一次，但老师有权覆盖，公共池的措辞由老师负责。
     */
    async audit(args) {
      const input = args && typeof args === 'object' ? args : {}
      const p = typeof input.path === 'string' ? input.path : ''
      const decision = input.decision === 'shared' ? 'shared' : (input.decision === 'private' ? 'private' : '')
      if (!p || !core.exists(p)) throw new Error('条目不存在')
      if (!decision) throw new Error('decision 只能是 shared 或 private')

      const it = core.readItem(p)
      const sections = core.sectionsOf(it.body)
      it.fields.updated = today()
      it.fields.audit = decision
      if (typeof input.title === 'string' && oneLine(input.title)) it.fields.title = oneLine(input.title).slice(0, 60)
      if (typeof input.summary === 'string' && oneLine(input.summary)) it.fields.summary = oneLine(input.summary).slice(0, 300)
      if (typeof input.note === 'string' && oneLine(input.note)) sections['教师归档'] = oneLine(input.note)

      if (decision === 'shared') {
        it.fields.status = '已沉淀'
        // 复制进公共面：原条留在学生私有目录（学生那边仍看得到自己的），公共面是策展副本。
        // 两份而不是移动 —— 移动会让学生的历史记录突然消失。
        const pubRel = core.PUBLIC_ITEMS_REL + '\\' + p.split('\\').pop()
        core.writeItem(pubRel, Object.assign({}, it.fields, { audit: 'shared', status: '已沉淀' }), sections, it.turns)
        core.writeItem(p, it.fields, sections, it.turns)
        return { ok: true, decision, status: it.fields.status, publicPath: pubRel }
      }
      it.fields.status = '已答复'
      core.writeItem(p, it.fields, sections, it.turns)
      // 曾经公开过又要撤回：把公共面那份删掉，否则学生还能看到
      const pubRel = core.PUBLIC_ITEMS_REL + '\\' + p.split('\\').pop()
      let removed = false
      if (core.exists(pubRel)) { try { (await import('node:fs')).unlinkSync(core.abs(pubRel)); removed = true } catch (e) { /* 忽略 */ } }
      return { ok: true, decision, status: it.fields.status, removedFromPublic: removed }
    },

    /**
     * 共性问题汇总。
     * 判据不是「有几条」，而是「有几个**不同学生**踩到」——
     * 一个学生反复问同一个东西，那是他自己的困惑；三个学生各问一次，
     * 那才是教案或讲法的问题，值得沉淀。
     */
    async common(args) {
      const input = args && typeof args === 'object' ? args : {}
      const items = await core.listItems()
      const groups = new Map()
      for (const it of items) {
        const key = (it.lesson || '未标注') + '||' + fingerprint(problemTextOf(it))
        if (!groups.has(key)) {
          groups.set(key, { lesson: it.lesson || '未标注', module: it.module || '', type: it.type || '', sample: problemTextOf(it), students: new Set(), items: [], maxSeverity: '' })
        }
        const g = groups.get(key)
        if (it.student) g.students.add(it.student)
        g.items.push(it)
        const rank = { '阻塞': 4, '高': 3, '中': 2, '低': 1 }
        if ((rank[it.severity] || 0) > (rank[g.maxSeverity] || 0)) g.maxSeverity = it.severity
      }
      const out = []
      for (const g of groups.values()) {
        const shared = g.items.some((i) => i.audit === 'shared')
        out.push({
          lesson: g.lesson, module: g.module, type: g.type, sample: g.sample,
          students: [...g.students], studentCount: g.students.size,
          count: g.items.length, maxSeverity: g.maxSeverity, alreadyShared: shared,
          paths: g.items.map((i) => i.path),
        })
      }
      // 排序：多个学生踩到 > 严重度 > 条数
      out.sort((a, b) => (b.studentCount - a.studentCount)
        || (({ '阻塞': 4, '高': 3, '中': 2, '低': 1 }[b.maxSeverity] || 0) - ({ '阻塞': 4, '高': 3, '中': 2, '低': 1 }[a.maxSeverity] || 0))
        || (b.count - a.count))
      const minStudents = Number(input.minStudents) > 0 ? Number(input.minStudents) : 2
      return { groups: out, common: out.filter((g) => g.studentCount >= minStudents), minStudents }
    },

    /** 把一条共性问题批量标为共享（老师点「这批都值得共享」时用） */
    async 'audit.batch'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const paths = Array.isArray(input.paths) ? input.paths : []
      const decision = input.decision === 'private' ? 'private' : 'shared'
      const out = []
      for (const p of paths) {
        try {
          const r = await handlers.audit({ path: p, decision, note: input.note })
          out.push({ path: p, ok: true, publicPath: r.publicPath })
        } catch (e) { out.push({ path: p, ok: false, error: oneLine(e && e.message) }) }
      }
      return { ok: true, done: out.filter((x) => x.ok).length, results: out }
    },

    /** 待发布清单：公共面里有什么，将会被 publish 带进公开仓 */
    async staged() {
      const pubDir = core.abs(core.PUBLIC_ITEMS_REL)
      const fs = await import('node:fs')
      let files = []
      try { files = fs.readdirSync(pubDir).filter((n) => /\.md$/i.test(n)) } catch (e) { files = [] }
      const subs = core.listSubmissions()
      return {
        publicDir: core.PUBLIC_ITEMS_REL, files,
        submissions: subs,
        workspace: core.WORKSPACE,
        note: '把公共面 + 教案发到公开仓：在课程发布目录执行 node course-repo.mjs publish，然后 git push',
      }
    },

    /**
     * 仓库状态（**只读**：不调用 git、不联网、不写任何文件）。
     *
     * ── 为什么状态直接从 .git/config 读 ──────────────────────────────
     * 在插件里 spawn 一个 git 会带来两个额外问题（「这台机器上找不找得到 git」
     * 「不同 git 版本的输出格式不一样」），而我们只想知道三件事：有没有仓库、
     * remote 指向哪、在哪个分支。这三样 .git/config 里都是明文。
     *
     * ── 为什么每一项都要带 repoSummary() ─────────────────────────────
     * 这一页是给**不懂 git 的老师**看的。他看不懂 `ahead 3`，也不该在界面上
     * 看到 `remoteSafe` / `hasRepo` 这种字段名 —— 界面上一出现术语，等于把
     * 「现在到底能不能发出去」这个判断又推回给他。所以每个仓库状态都附一句人话。
     *
     * 参数里的 owner/name **不改任何东西**（这个动作只读），只用来现拼
     * 「照抄即可」的那几条手动命令：老师刚在表单里改了 owner，折叠块里的命令
     * 就必须跟着变，否则他照抄下来推的是别人家的仓库地址。
     */
    async 'repo.status'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const fsMod = await import('node:fs')
      const info = core.info()
      const course = info.course || {}
      // 仓名兜底顺序：课程码 → 课程名 → 'course'。
      // 用课程码而不是课程名，是因为仓名要进 URL、clone 命令和学生每天敲的东西；
      // 而 repoSlug 会把非 ASCII 全折掉，一个中文课程名只会折成 'course'。
      // 课程名放**仓库简介**，这一条在 repo.js 里写着。
      const slug = repoSlug(course.code || course.title || '', 'course')
      const pubAbs = core.sharedAbs(PUBLIC_REPO_REL)
      const publicRepo = readRepoState(pubAbs)
      const privateRepo = readRepoState(core.WORKSPACE)
      // 表单填了就用表单的，没填就用仓库里已经连着的那个，再没有就用课程码折出来的 ——
      // 「看两条手动步骤」在老师还没建仓、表单还空着的时候也得有内容，否则那块是空的。
      const owner = oneLine(input.owner) || publicRepo.owner || ''
      const name = repoSlug(oneLine(input.name) || publicRepo.name || slug, slug)
      const privateName = repoSlug(oneLine(input.privateName) || (name + '-privated'), name + '-privated')
      const branch = publicRepo.branch || 'main'
      return {
        // 原始字段留着给界面判断该亮哪个按钮；summary 是给人看的那一句
        publicRepo: Object.assign({}, publicRepo, { summary: repoSummary(publicRepo) }),
        privateRepo: Object.assign({}, privateRepo, { summary: repoSummary(privateRepo) }),
        slug, courseName: course.title || '', courseCode: course.code || '',
        // 发布清单：没有它发布工具会生成一份，但老师得先知道「现在还没有」
        manifestReady: fsMod.existsSync(core.sharedAbs(PUBLISH_MANIFEST_REL)),
        publicDir: PUBLIC_REPO_REL,
        manifestPath: PUBLISH_MANIFEST_REL,
        resolved: { owner, name, privateName, branch },
        // 没有 Token 时那两条命令（照抄即可）。带 token 的那条只在 repo.init 里现拼 ——
        // 这个动作会**切换页面就被调用**，它的返回会被界面长期持有，token 不该进这里。
        manual: manualSteps(owner, name, { privateName }),
        // 推送命令的兜底版本：不带凭据。cd 用绝对路径 —— 老师从别处打开的终端也能照抄。
        next: [
          'cd "' + pubAbs + '"',
          'git add -A',
          'git commit -m "首次发布"',
          'git push -u origin ' + branch,
        ],
      }
    },

    /**
     * 建仓 —— **只在本机把仓库准备好，不联网、不推送**。
     *
     * ── 为什么只做到「本机准备好」────────────────────────────────────
     * 在 GitHub 上建仓要走它的接口，而接口要凭据。插件收下凭据、再代表老师去建仓，
     * 等于插件成了一个凭据保管者 —— 这门课从第一天起的口径是「插件里不放任何人的密钥」。
     * 所以分工是：本机这两步（git init / git remote add）插件替他做；
     * **GitHub 上的空仓与第一次 push 由他自己敲**（命令照抄即可，见返回的 next）。
     *
     * ── 硬要求：Token 绝不写进 .git/config ────────────────────────────
     * .git/config 会**跟着仓库被复制走**（拷目录、打包发人、被发布工具扫进公开仓），
     * 而写进去的 Token 是一把长期有效的钥匙。所以：
     *   · remote 只写**不带 token** 的 https 地址（remoteUrl(owner, name, '')）；
     *   · 带 token 的地址只在内存里用 remoteUrl() 现拼，**只显示给老师自己敲**；
     *   · 故意**不加 `-u`**：`git push -u <带token的URL>` 会把那条地址记进
     *     branch.<名>.remote，等于绕一圈又落盘了。这是个很容易踩的坑。
     *
     * ⚠️ 失败一律 `return { ok:false, error }`，**不抛异常**（同 publish 的写法）。
     *    异常到了界面上只剩「未知错误」，而老师需要知道的是「哪一步、为什么、怎么办」——
     *    所以错误信息里带上**失败那一步的命令原文与输出**。
     */
    async 'repo.init'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const fsMod = await import('node:fs')
      const owner = oneLine(input.owner)
      const nameTyped = oneLine(input.name)
      const token = String(input.token === undefined || input.token === null ? '' : input.token).trim()
      const description = oneLine(input.description).slice(0, 300)
      const info = core.info()
      const course = info.course || {}

      // owner 校验。GitHub 的用户名/组织名只可能是 ASCII 字母、数字与横线。
      // 不校验的话，一个中文 owner 会拼出 https://github.com/张三/x.git，
      // 而 git 只会回一句 404 —— 老师会以为是网络问题，去查网。
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(owner)) {
        return {
          ok: false,
          error: 'owner 要填 GitHub 上的用户名或组织名（只能是英文字母、数字、横线）。现在填的是「'
            + (owner || '（空）') + '」—— 它会被原样拼进仓库地址，拼错了 git 只会回一个 404，'
            + '看起来像网络问题。',
        }
      }

      const name = repoSlug(nameTyped || course.code || course.title || '', 'course')
      // 私有仓名：界面没填就按「公开仓名 + -privated」推出来（manualSteps 的默认值也是它）。
      // **参数要真的被用上**：声明了却不读，等于给调用方一个「能配」的假象 ——
      // 配了没生效，而这一页的后果是老师以为私有仓在 A、实际在 B。
      const privateName = repoSlug(oneLine(input.privateName) || (name + '-privated'), 'course-privated')

      // git 本体：先试写死的路径，再回落 PATH 里的 git。两个都没有就明确报错。
      //
      // ⚠️ 原来这里用 `spawnSync('git', ['--version'], { encoding:'utf8' })` 探测，
      //    在本机**永远是 EPERM**（沙箱不给管道），于是 `git` 判为空、
      //    老师点「建仓」得到的是「找不到 git，请装一个 Git for Windows」——
      //    而 git 装得好好的（D:\Git\cmd\git.exe，version 2.55）。方向全错。
      //    所以探测必须走 runCaptured（重定向到文件描述符，不走管道）。
      let git = ''
      if (fsMod.existsSync(GIT_HARD_PATH)) git = GIT_HARD_PATH
      else {
        const probe = runCaptured('git', ['--version'], { timeout: 20000, hintDir: core.WORKSPACE })
        if (!probe.error && probe.status === 0) git = 'git'
      }
      if (!git) {
        return {
          ok: false,
          error: '找不到 git。这台机器上既没有 ' + GIT_HARD_PATH + '，PATH 里也没有 git。'
            + '装一个 Git for Windows 再回来点这个按钮（插件不会替你下载安装）；'
            + '装到别处的话，把它的 cmd 目录加进 PATH 就行。',
        }
      }

      const pubAbs = core.sharedAbs(PUBLIC_REPO_REL)
      if (!fsMod.existsSync(pubAbs)) {
        // **不替你新建这个目录**：在一个空目录上建仓再推上去，学生的仓里会是空的，
        // 而他那边看起来一切正常 —— 这是最难发现的一种「发布成功」。
        return {
          ok: false,
          error: '找不到「' + PUBLIC_REPO_REL + '」这个目录（' + pubAbs + '）。'
            + '它是公开仓的工作区，由课程仓库带过来。目录不在时插件不替你新建 —— '
            + '在一个空目录上建仓再推上去，学生的仓里会是空的，看起来却像发布成功了。',
        }
      }

      const steps = []
      const warnings = []
      /**
       * 失败一律走这里：**带上已经跑过的 steps**。
       *
       * 只回一句 error 的话，老师在界面上看不到「前一步其实成功了」——
       * 例如 git init 成功、remote add 失败时，他会以为仓库根本没准备好，
       * 而其实已经有了一个（下一次点这个按钮会跳过 init）。
       * steps 在界面上暂时显示不出来（api() 见到 error 就当异常抛），
       * 但它留在返回里，排查脚本与日志能看到完整的经过。
       */
      const fail = (msg) => ({ ok: false, error: msg, steps, next: [] })
      /**
       * 跑一条 git，把**命令原文**与输出一起留下 ——
       * 老师看得见刚才发生了什么，也学得到这几条命令（这一页的目的之一就是这个）。
       * 输出截尾 2000 字：git 报错有时很长，但有用的那几句在末尾。
       */
      const run = (argv) => {
        // 走 runCaptured 而不是 spawnSync 的 encoding：见 run.js 顶部 ——
        // 带管道的 spawnSync 在本机一律 EPERM，且不抛异常。
        const r = runCaptured(git, argv, { cwd: pubAbs, timeout: 60000, hintDir: core.WORKSPACE })
        // ⚠️ r.error 必须并进 out（runOutput 已经做了）。只取 stdout/stderr 的话，
        //    **连进程都没起来**那种失败（路径不对、被拦、没有权限）会得到一句
        //    「（没有输出）」，老师无从下手。踩过一次：spawn 失败表现为
        //    exit -1 + 空输出，看起来像 git 自己没说话。
        const out = runOutput(r).slice(-2000)
        const code = runExitCode(r)
        steps.push({ cmd: 'git ' + argv.join(' '), code, out })
        return { code, out }
      }

      if (nameTyped && nameTyped !== name) {
        warnings.push('仓库名「' + nameTyped + '」按 GitHub 的规则折成了「' + name + '」'
          + '（只留小写字母、数字和横线）。中文仓名虽然允许，但 URL、clone 命令、'
          + '学生要敲的东西全都会变难用 —— 课程名请写进「仓库简介」。')
      }

      const before = readRepoState(pubAbs)
      if (before.hasRepo) {
        // 已经是仓库了就跳过。**不重复 init**：重复跑虽然无害，但会让「刚才做了什么」变模糊。
        steps.push({
          cmd: 'git init', code: 0, skipped: true,
          out: '这个目录已经是 git 仓库了，跳过（当前分支 ' + (before.branch || '?') + '）',
        })
      } else {
        const r = run(['init'])
        if (r.code !== 0) {
          return fail('「git init」没成功（exit ' + r.code + '）：' + (r.out || '（没有输出）'))
        }
      }

      const url = remoteUrl(owner, name, '')   // ⚠️ 空 token：这一条是刻意的，见上面的硬要求
      const existing = (before.remotes && before.remotes.origin) || null
      if (existing && existing.url) {
        // 已经有的 remote **不覆盖**：它可能是老师自己配的，也可能指向另一个仓。
        // 覆盖掉的后果是「推到别人家去了」或者「推不动」，两种都很难自己发现 ——
        // 所以只如实报出来，要改由他执行 set-url（那一步我们不做）。
        steps.push({
          cmd: 'git remote add origin ' + url, code: 0, skipped: true,
          out: '已经有 origin，没有覆盖它。它现在指向：' + existing.url,
        })
        if (existing.url !== url) {
          warnings.push('原来的 origin 指向 ' + existing.url + '，和你这次填的 '
            + owner + '/' + name + ' 不一样 —— 插件**没有覆盖**它。要换成新的地址，'
            + '自己执行： git remote set-url origin ' + url
            + '（覆盖 remote 会让下一次 push 推到别的地方，必须你自己确认）')
        }
      } else {
        const r = run(['remote', 'add', 'origin', url])
        if (r.code !== 0) {
          // 报错里带上**命令原文**（这个 url 是不带 token 的，见上面的硬要求）：
          // 老师照这条自己敲一遍，就能看到 git 的原话，而不是只看到「失败了」。
          return fail('「git remote add origin ' + url + '」没成功（exit ' + r.code + '）：'
            + (r.out || '（没有输出）'))
        }
      }

      const after = readRepoState(pubAbs)
      const branch = after.branch || before.branch || 'main'
      const commitMsg = description ? ('首次发布：' + description) : '首次发布'
      const next = [
        'cd "' + pubAbs + '"',
        'git add -A',
        'git commit -m "' + commitMsg + '"',
        token
          // 带 token 的地址**只在这里现拼**（内存里），而且不加 -u：
          // -u 会把这条地址写进 .git/config 的 branch.<名>.remote，等于又落盘了。
          ? ('git push ' + remoteUrl(owner, name, token) + ' ' + branch)
          : ('git push -u origin ' + branch),
      ]
      return {
        ok: true, steps, next, warnings,
        // 界面靠这个**明确的布尔值**判断「那条命令里有 Token」，不在字符串里搜
        // 'x-access-token' —— 判据落在明确的字段上，不落在「字符串长得像什么」上。
        hasToken: !!token,
        resolved: { owner, name, privateName, branch, publicUrl: url, privateUrl: remoteUrl(owner, privateName, '') },
        manual: manualSteps(owner, name, { privateName }),
        description,
        hint: description
          ? ('在 GitHub 上建这两个空仓时，「Description」填：' + description + '（仓名是 ASCII，人话放简介）')
          : '',
        note: '本机已经准备好了，但**没有替你推**：push 那一步用你自己的凭据，插件里不放任何人的密钥。'
          + '照抄下面那几条命令就能发出去。',
      }
    },

    /** 学生提交（教师视角：全部学生） */
    async submissions(args) {
      const input = args && typeof args === 'object' ? args : {}
      let files = core.listSubmissions()
      if (input.student) files = files.filter((s) => s.student === input.student)
      if (input.lesson) files = files.filter((s) => s.name.indexOf(input.lesson) >= 0)
      const students = [...new Set(core.listSubmissions().map((s) => s.student).filter(Boolean))].sort()
      return {
        files: files.map((s) => Object.assign({}, s, { who: who(s.student) })),
        students,
        labels: students.map((s) => who(s).label),
      }
    },
    async 'submission.read'(args) {
      const p = args && typeof args.path === 'string' ? args.path : ''
      if (!p || !core.exists(p)) throw new Error('提交不存在')
      const text = core.readText(p)
      return { path: p, name: p.split('\\').pop(), text, bytes: Buffer.byteLength(text, 'utf8') }
    },

    /**
     * 就绪清单 + 今天要做什么。
     *
     * 老师打开面板最想知道的是「现在先干哪件事」，而不是五个标签页里的数字。
     * 所以这里把已有数据压成一句话，并给出一个**有序的待办**。
     */
    async readiness() {
      const info = core.info()
      const tree = await core.getTree()
      const items = await core.listItems()
      const subs = core.listSubmissions()
      const roster = readRoster(core)
      const students = new Set(items.map((i) => i.student).filter(Boolean))
      for (const s of subs) if (s.student) students.add(s.student)
      const named = [...students].filter((s) => nameOf(s, roster, readStudentInfo(core, s))).length
      const lessons = []
      for (const m of ((tree && tree.modules) || [])) for (const l of (m.lessons || [])) lessons.push(l)
      const withPlan = lessons.filter((l) => l.hasPlan).length

      // 公开仓：没推上去时学生拿到的是旧内容，而老师以为已经发布了
      const fsMod = await import('node:fs')
      const pubDir = core.abs(core.PUBLIC_ITEMS_REL)
      let staged = 0
      try { staged = fsMod.readdirSync(pubDir).filter((n) => /\.md$/i.test(n)).length } catch (e) { staged = 0 }
      let hasRemote = false
      try {
        hasRemote = fsMod.existsSync(core.sharedAbs('课程发布\\public\\.git'))
      } catch (e) { hasRemote = false }

      const counts = {
        ungraded: subs.filter((s) => !s.graded).length,
        sharedUnanswered: items.filter((i) => i.audit === 'shared' && !i.hasTeacherAnswer).length,
        missingPlan: lessons.length - withPlan,
        unnamed: students.size - named,
        unpublished: 0,   // 真正的待发布数要跑发布工具才知道，这里不猜（见 readiness.js 的硬规则）
      }
      return teacherReadiness(core, {
        workspaceOk: core.exists('课程中心\\课程结构索引.json'),
        workspace: core.WORKSPACE,
        course: info.course,
        hasIndex: !!tree,
        totalLessons: lessons.length,
        withPlan, missingPlan: counts.missingPlan,
        students: students.size, named,
        publish: { hasRemote, pending: false, unpublished: staged },
        todo: teacherTodo(counts),
      })
    },

    /**
     * 材料归位**建议**（只读，不落盘）。
     *
     * 老师拖进来一批文件，插件先说「我建议每个放哪、为什么」，由他逐条确认。
     * 判错的后果很具体：文件进了别人家，而面板照常显示、批改照常跑 ——
     * 和「页码锚点不能猜」是同一个道理。
     *
     * ⚠️ 这个动作**只读**：不收字节、不写任何文件。
     *    真落盘放在后面的 materials.apply，而且只写老师确认过的那些。
     */
    async 'materials.plan'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const files = (Array.isArray(input.files) ? input.files : [])
        .filter((f) => f && typeof f.relPath === 'string')
        .slice(0, 400)
        .map((f) => ({ relPath: f.relPath, bytes: Number(f.bytes) || 0 }))
      const tree = await core.getTree()
      const modules = []
      for (const m of ((tree && tree.modules) || [])) if (m.dir) modules.push(m.dir)
      const r = suggestPlacement(files, { modules, chapters: C.CHAPTERS })
      return Object.assign(r, {
        targets: TARGETS,
        modules: modules,
        note: '这里是**建议**，不是结果。待定的默认没有勾选 —— 认不出的东西不该'
          + '被默认塞进某个目录里。你改完落点再点确认，插件才会落盘。',
      })
    },

    /**
     * 材料归位**落盘**。
     *
     * ── 为什么不走「上传字节」这条路 ──────────────────────────────────
     * 老师的 PPT 实测 100 MB 上下（这次拖进来的一个是 **227 MB**），而浏览器上传
     * 只能走 JSON 里的 dataURL —— base64 先膨胀 1/3，还要在内存里过一遍，
     * 再撞上 MAX_BLOB_BYTES（12 MB）。把上限调大只是把问题推后：
     * 一个 227 MB 的 POST 体在面板里本来就不该发生。
     *
     * **插件和课程文件在同一台机器上** —— 这是关键事实。
     * 所以正确做法是让老师给一个**本机路径**，宿主直接读盘拷贝：
     * 没有上传、没有 base64、没有大小限制，而且快得多。
     * 拖放仍保留给小文件（配置文件、单个 md），两条路并存。
     *
     * ── 三条不肯让步的规则 ──────────────────────────────────────────
     *   1. **只写老师勾选过的行**（selected=false 直接跳过）
     *   2. 落盘前**再跑一遍** planWrites 的三条防线（前端传什么都不信）
     *   3. 已存在的目标**不覆盖**，改写 `.new` 旁挂并报出来 ——
     *      覆盖别人的教案是不可逆的，而重名很常见
     */
    async 'materials.apply'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const srcRoot = oneLine(input.srcRoot)
      const items = (Array.isArray(input.items) ? input.items : []).slice(0, 400)
      if (!srcRoot) {
        throw new Error('要给一个本机路径（放课程文件的那个文件夹）—— '
          + '走路径而不是上传，是因为课件常有 100 MB 以上，上传既慢又会被大小限制挡住')
      }
      const fsMod = await import('node:fs')
      const pathMod = await import('node:path')
      if (!fsMod.existsSync(srcRoot)) throw new Error('这个路径不存在：' + srcRoot)

      const plan = planWrites(items, {})
      const written = []
      const skipped = []
      for (const w of plan.writes) {
        const src = pathMod.join(srcRoot, w.from.replace(/\//g, pathMod.sep))
        if (!fsMod.existsSync(src)) { skipped.push({ to: w.rel, why: '源文件找不到：' + w.from }); continue }
        const dst = core.sharedAbs(w.rel)
        if (fsMod.existsSync(dst)) {
          const alt = dst.replace(/(\.[A-Za-z0-9]+)?$/, '.new$1')
          try {
            fsMod.mkdirSync(pathMod.dirname(alt), { recursive: true })
            fsMod.copyFileSync(src, alt)
            skipped.push({ to: w.rel, why: '目标已存在，改写成 ' + pathMod.basename(alt) + '（没有覆盖原有文件）' })
          } catch (e) { skipped.push({ to: w.rel, why: '目标已存在且旁挂失败：' + oneLine(e && e.message) }) }
          continue
        }
        try {
          fsMod.mkdirSync(pathMod.dirname(dst), { recursive: true })
          fsMod.copyFileSync(src, dst)
          written.push({ to: w.rel, bytes: fsMod.statSync(dst).size, kind: w.kind })
        } catch (e) { skipped.push({ to: w.rel, why: '写入失败：' + oneLine(e && e.message) }) }
      }
      for (const r of plan.rejected) skipped.push({ to: r.relPath, why: r.why })
      if (written.length) core.invalidateCache()
      const total = written.reduce((a, x) => a + x.bytes, 0)
      return {
        ok: true, written: written, skipped: skipped, bytes: total, srcRoot: srcRoot,
        note: written.length
          ? ('写入 ' + written.length + ' 个文件（' + Math.round(total / 1024) + ' KB）'
            + (skipped.length ? ('，另有 ' + skipped.length + ' 条没写，原因逐条列在下面') : ''))
          : '一个文件都没写 —— 原因逐条列在下面',
      }
    },

    // ═══════════════════════════════════════════════════════════
    //  学生 —— 「谁提问的」这一栏原来写的是 Administrator
    //
    //  那不是学生，是这台 Windows 机器的用户名（身份 = CIP_STUDENT ||
    //  USERNAME）。老师要看的是「谁卡住了，好针对性教学」，所以这里
    //  把三个人（机器 / 学生自报 / 老师名册）合起来给出一个能认的名字。
    //  显示名优先级：**老师名册 > 学生自报 > 学号**。
    // ═══════════════════════════════════════════════════════════

    /**
     * 学生总表：把提问、提交、批改问题按人聚起来。
     *
     * 判据用「每个人自己的一行」，而不是只给一个学生列表 ——
     * 老师真正要回答的问题是「这一班谁需要我管」，所以每行都要带
     * 可比较的计数（提问数 / 未批改数 / 最后活跃），能排序。
     */
    async roster() {
      const items = await core.listItems()
      const subs = core.listSubmissions()
      const roster = readRoster(core)
      const map = new Map()
      const touch = (sid) => {
        if (!map.has(sid)) {
          const info = readStudentInfo(core, sid)
          const row = roster.students[sid] || null
          map.set(sid, {
            sid,
            name: nameOf(sid, roster, info),
            label: labelOf(sid, roster, info),
            klass: (row && row.klass) || (info && info.klass) || '',
            note: (row && row.note) || '',
            fromRoster: !!(row && row.name),
            selfName: (info && info.name) || '',
            asked: 0, shared: 0, answered: 0, ungraded: 0,
            severity: { '阻塞': 0, '高': 0, '中': 0, '低': 0 },
            lessons: {}, topics: {}, tokens: 0,
            lastAt: '', items: [], submissions: [],
          })
        }
        return map.get(sid)
      }
      for (const it of items) {
        const sid = it.student || '（未标注）'
        const r = touch(sid)
        r.asked += 1
        if (it.audit === 'shared') r.shared += 1
        if (it.hasTeacherAnswer) r.answered += 1
        if (it.severity && r.severity[it.severity] !== undefined) r.severity[it.severity] += 1
        const l = it.lesson || '未标注'
        r.lessons[l] = (r.lessons[l] || 0) + 1
        const t = it.topic || '未分类'
        r.topics[t] = (r.topics[t] || 0) + 1
        r.tokens += Number(it.tokens || 0)
        if (it.updated && it.updated > r.lastAt) r.lastAt = it.updated
        r.items.push({ path: it.path, title: it.title, lesson: it.lesson, severity: it.severity, status: it.status })
      }
      for (const s of subs) {
        const sid = s.student || '（未标注）'
        const r = touch(sid)
        r.submissions.push({ path: s.path, name: s.name, lesson: s.lesson, at: s.at, graded: s.graded })
        if (!s.graded) r.ungraded += 1
        if (s.at && s.at > r.lastAt) r.lastAt = s.at
      }
      const students = [...map.values()]
      // 排序：需要老师管的排前面（未批改 + 阻塞/高严重度），再看提问量
      students.sort((a, b) => ((b.ungraded + b.severity['阻塞'] * 2 + b.severity['高'])
        - (a.ungraded + a.severity['阻塞'] * 2 + a.severity['高'])) || (b.asked - a.asked))
      return {
        students,
        total: students.length,
        rosterFile: ROSTER_REL,
        rosterSource: roster.source || '（还没有名册，显示的是学生自报或学号）',
        // 数据里有、但人已经不在这门课里的（换过学号、导错的数据）
        note: '显示名：老师名册 > 学生自报 > 学号。名册是你说了算的那一份，学生自己填的可能写错或写昵称。',
      }
    },

    /** 老师改一个学生的姓名/班级/备注（人的权威在老师这边） */
    async 'roster.save'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const sid = safeId(input.sid)
      if (!sid) throw new Error('要指定学号（sid）')
      const roster = readRoster(core)
      const students = roster.students
      if (input.remove === true) {
        delete students[sid]
      } else {
        students[sid] = {
          name: oneLine(input.name).slice(0, 24),
          klass: oneLine(input.klass).slice(0, 24),
          note: oneLine(input.note).slice(0, 200),
          at: new Date().toISOString(),
        }
      }
      writeRoster(core, students)
      return { ok: true, sid, removed: input.remove === true, label: who(sid).label, file: ROSTER_REL }
    },

    /**
     * 一个学生的全部情况 —— 老师点名字进来看的那一页。
     * 这是「便于更好教学」真正落地的地方：不是给一串学号，而是给
     * 「这个人卡在哪几课、哪一类问题上、作业批没批」。
     */
    async 'student.detail'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const sid = safeId(input.sid)
      if (!sid) throw new Error('要指定学号（sid）')
      const items = (await core.listItems()).filter((i) => i.student === sid)
      const subs = core.listSubmissions().filter((s) => s.student === sid)
      const roster = readRoster(core)
      const info = readStudentInfo(core, sid)
      const byLesson = {}
      for (const it of items) {
        const k = it.lesson || '未标注'
        if (!byLesson[k]) byLesson[k] = { lesson: k, asked: 0, shared: 0, worst: '', topics: {} }
        const row = byLesson[k]
        row.asked += 1
        if (it.audit === 'shared') row.shared += 1
        const rank = { '阻塞': 4, '高': 3, '中': 2, '低': 1 }
        if ((rank[it.severity] || 0) > (rank[row.worst] || 0)) row.worst = it.severity || ''
        const t = it.topic || '未分类'
        row.topics[t] = (row.topics[t] || 0) + 1
      }
      const lessons = Object.keys(byLesson).map((k) => byLesson[k])
        .sort((a, b) => b.asked - a.asked)
      return {
        sid,
        label: labelOf(sid, roster, info),
        name: nameOf(sid, roster, info),
        rosterRow: roster.students[sid] || null,
        selfInfo: info || null,
        items, submissions: subs,
        ungraded: subs.filter((s) => !s.graded).length,
        lessons,
        tokens: items.reduce((a, i) => a + Number(i.tokens || 0), 0),
        // 「这个人需要我做什么」—— 直接给结论，别让老师自己从表格里推
        todo: [
          subs.filter((s) => !s.graded).length ? (subs.filter((s) => !s.graded).length + ' 份提交还没批改') : '',
          items.filter((i) => i.severity === '阻塞').length ? (items.filter((i) => i.severity === '阻塞').length + ' 条阻塞级问题') : '',
          items.filter((i) => i.audit === 'shared' && !i.hasTeacherAnswer).length
            ? (items.filter((i) => i.audit === 'shared' && !i.hasTeacherAnswer).length + ' 条已公开但你还没答复') : '',
          !nameOf(sid, roster, info) ? '这个人还没有姓名 —— 在名册里补一个，以后一眼就认得' : '',
        ].filter(Boolean),
      }
    },

    // ── 换课 ────────────────────────────────────────────────────
    /**
     * 老师同时教几门课时切换当前课程。
     *
     * 热切换，**不重启**（见 core 里 useCourse 的注释：三样东西在一个同步块里
     * 换完，Node 单线程，中间插不进别的请求）。换的只有**私有数据**那一半
     * （问题池 / 作业 / 草稿 / 名册），课件与教案是全校共享内容，留在根目录不动。
     */
    async 'course.use'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const code = oneLine(input.code)
      const r = core.useCourse(code)
      const info = core.info()
      return Object.assign(r, {
        course: info.course,
        note: code
          ? ('已切到课程 ' + (info.course.title || code) + '（' + r.dir + '）。提问、作业、名册都跟着换。')
          : '已切回「工作区根目录即课程」的那一门。',
      })
    },

    async 'course.list'() {
      const info = core.info()
      return {
        current: info.course,
        available: info.course.available || [],
        workspace: core.WORKSPACE,
      }
    },

    /**
     * 继续修改草稿 —— 一轮一轮改，像学生追问那样。
     *
     * 为什么不重生成：老师看出来的问题几乎都是**局部的**（这节推导跳步、
     * 验收标准太虚、第 12 页那张图要讲进去）。重生成会把已经满意的部分一起洗掉；
     * 逐轮改只动该动的，而且每轮都能看见「改了什么」。
     *
     * 老师可以像学生提问那样递证据：在课件上拖选一段文字、或框一张图，
     * 指着它说「把这块讲进推导」。证据块与学生端提问**同一套形状**，
     * 因为两边本来就该是同一种操作。
     */
    async 'plan.revise'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson)
      if (!(lessonNo > 0)) throw new Error('要指定课时号（lesson）')
      const d = findDraft(core, lessonNo)
      if (!d) throw new Error('第 ' + lessonNo + ' 课时还没有草稿 —— 先生成一份再改')
      const instruction = oneLine(input.instruction)
      const evidence = Array.isArray(input.evidence) ? input.evidence.slice(0, 6) : []
      const images = Array.isArray(input.images)
        ? input.images.filter((x) => typeof x === 'string' && x).slice(0, MAX_PLAN_IMAGES) : []
      if (!instruction && !evidence.length) {
        throw new Error('这一轮是空的：写一句要改什么，或者在课件上圈一块内容')
      }

      const before = core.readText(PLAN_DRAFT_DIR + '\\' + d.file)
      const catalog = await listModelCatalog(ctx)
      const choice = resolveChoice(readModelChoice(), catalog)
      if (!choice) throw new Error('拿不到模型选择：面板里选一个模型，或先在 DSH 里设置默认模型')

      const trace = []
      const r = await runPlanRevise(ctx, {
        data: {
          lessonNo, title: d.title || '', current: before,
          anchor: d.anchor || anchorFor(lessonNo, d.module, (await moduleSpans()).spans, readAnchors(core)),
          instruction, evidence, images, imageCount: images.length,
          history: d.turns || [],
        },
        trace, choice,
      })

      // 改之前先留快照：逐轮改就必须能回退（改坏了要能退回去重来）
      const snap = snapshotDraft(core, lessonNo, before, 'rev' + ((d.turns || []).length + 1))

      const turn = {
        q: instruction || '（只圈了内容）',
        a: '改了 ' + (r.diff.changed.length ? r.diff.changed.map((c) => c.title).join('、') : '（内容有微调）'),
        at: new Date().toISOString(),
        model: r.provider + '/' + r.model,
        usage: r.usage,
        changed: r.diff.changed,
        keptFromOld: r.keptFromOld,
        evidence: evidence.map((e) => ({ chapter: e.chapter, page: e.page, kind: e.kind, chars: (e.text || '').length })),
        images: r.imagesAttached,
        snapshot: snap,
        charsBefore: r.diff.charsBefore, charsAfter: r.diff.charsAfter,
      }
      core.writeText(PLAN_DRAFT_DIR + '\\' + d.file, r.text)
      const parsed = parsePlan(r.text)
      const turns = (d.turns || []).concat([turn])
      updateDraftMeta(core, lessonNo, {
        chars: r.text.length, missing: parsed.missing, turns: turns,
        revisions: (d.revisions || 0) + 1, editedAt: new Date().toISOString(),
      })
      return {
        ok: true, lesson: lessonNo, text: r.text, turn: turn, turns: turns.length,
        missing: parsed.missing, usage: r.usage, trace,
        note: '第 ' + turns.length + ' 轮改完：'
          + (r.diff.changed.length
            ? r.diff.changed.map((c) => c.title + (c.delta >= 0 ? (' +' + c.delta) : (' ' + c.delta)) + ' 字').join('、')
            : '内容有微调')
          + (r.keptFromOld.length ? ('；其中 ' + r.keptFromOld.join('、') + ' 新稿写空了，保留了原来的') : '')
          + (snap ? ('　旧版已存 ' + snap) : ''),
      }
    },

    /** 一轮一轮改的过程（面板上要显示「第一轮改了什么」） */
    async 'plan.turns'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const d = findDraft(core, Number(input.lesson))
      if (!d) throw new Error('第 ' + input.lesson + ' 课时还没有草稿')
      return { lesson: Number(input.lesson), turns: d.turns || [], revisions: d.revisions || 0 }
    },

    /** 退回某一轮之前的版本（快照在 教案草稿/_历史/ 里） */
    async 'plan.revert'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson)
      const d = findDraft(core, lessonNo)
      if (!d) throw new Error('第 ' + lessonNo + ' 课时还没有草稿')
      const turns = d.turns || []
      if (!turns.length) throw new Error('这个草稿还没有改过，没有可退回的版本')
      const keep = Number(input.keepTurns)
      const n = Number.isFinite(keep) ? Math.max(0, keep) : turns.length - 1
      const snap = n < turns.length ? turns[n].snapshot : ''
      if (!snap) throw new Error('要退回的那一轮没有快照（可能是早期版本）')
      const rel = PLAN_HISTORY_DIR + '\\' + snap
      if (!core.exists(rel)) throw new Error('快照文件不在了：' + rel)
      const text = core.readText(rel)
      core.writeText(PLAN_DRAFT_DIR + '\\' + d.file, text)
      const parsed = parsePlan(text)
      updateDraftMeta(core, lessonNo, {
        chars: text.length, missing: parsed.missing, turns: turns.slice(0, n),
        revertedAt: new Date().toISOString(),
      })
      return {
        ok: true, lesson: lessonNo, text: text, keptTurns: n,
        note: '已退回第 ' + n + ' 轮完成时的版本（之后那 ' + (turns.length - n) + ' 轮的要求已丢弃）',
      }
    },

    // ═══════════════════════════════════════════════════════════
    //  教案补全 —— 老师准备 PPT，教案由模型补，老师只做审批
    //
    //  这一组动作是教师端**唯一会花 token** 的地方（老师自己的额度）。
    //  其余动作（审计、汇总、发布）都是纯读写，一分钱不花 ——
    //  这个界线在界面上也是明说的，老师能看见「点这个按钮会用模型」。
    // ═══════════════════════════════════════════════════════════

    /** 可选模型目录 + 当前会用哪个（教案生成用） */
    async 'plan.catalog'() {
      const catalog = await listModelCatalog(ctx)
      const saved = readModelChoice()
      return {
        providers: catalog.providers, models: catalog.models,
        sessionDefault: catalog.current, saved: saved,
        effective: resolveChoice(saved, catalog),
        warnings: catalog.warnings || [],
        templateRel: C.PLAN_TEMPLATE_REL, draftDir: PLAN_DRAFT_DIR,
        sections: PLAN_SECTIONS,
      }
    },
    /** 记住「以后生成教案用哪个模型」 */
    async 'plan.model'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const provider = oneLine(input.provider)
      const model = oneLine(input.model)
      if (!provider || !model) {
        writeModelChoice({ provider: '', model: '' })
        return { ok: true, cleared: true }
      }
      const catalog = await listModelCatalog(ctx)
      const known = (catalog.models || []).some((m) => m.provider === provider && m.model === model)
      const sel = { provider, model, reasoningEffort: oneLine(input.reasoningEffort) }
      if (!writeModelChoice(sel)) throw new Error('保存模型选择失败：写入 ' + TEACHER_MODEL_REL + ' 失败')
      return { ok: true, saved: sel, inCatalog: known, path: TEACHER_MODEL_REL }
    },

    /**
     * 大纲体检：30 个课时各自缺什么，一次说清。
     *
     * 「缺教案」和「缺课件」必须分开报 —— 前者可以让模型补，后者要去录课，
     * 是完全不同的补救动作。混成一个「完成度 60%」对老师没有任何用。
     */
    async 'outline.status'() {
      const tree = await core.getTree()
      const { spans } = await moduleSpans()
      const r = outlineStatus(core, tree, { spans, anchors: readAnchors(core) })
      return Object.assign(r, {
        template: planTemplate(core, 0, '').source,
        draftDir: PLAN_DRAFT_DIR,
        anchors: readAnchors(core),
        // 课件分隔页本身也报出来：老师确认锚点时就是拿它对照的
        dividers: Object.keys(spans).map((k) => ({ module: k, spans: spans[k] })),
      })
    },

    /**
     * 锚点确认：老师把「课时 N ↔ 第几章第几页」钉下来。
     *
     * 为什么必须让老师过一手：PPT 里的课时标题与索引标题**并不严格一致**
     * （例：PPT 写「用线性代数勒死自己」，索引写「从统计学习理论到深度学习的
     * 矩阵化重构」），而且 30 个课时只有 10 张分隔页，一个分隔页常常覆盖两课时。
     * 由代码猜出来的页码一旦进了教案，就会变成批改的基准 —— 错的基准比没有基准更糟。
     */
    async 'anchor.set'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const patches = Array.isArray(input.anchors) ? input.anchors : [input]
      const cur = readAnchors(core).list
      let n = 0
      for (const p of patches) {
        const no = Number(p && p.lesson)
        if (!(no > 0)) continue
        if (p.clear) { delete cur[String(no)]; n += 1; continue }
        const chapter = oneLine(p.chapter)
        const from = Number(p.from)
        const to = Number(p.to) || from
        if (!chapter || !(from > 0)) continue
        cur[String(no)] = { chapter, from, to: Math.max(from, to), manual: true }
        n += 1
      }
      writeAnchors(core, cur)
      return { ok: true, changed: n, anchors: readAnchors(core) }
    },

    /** 草稿清单 + 每份的骨架完整度 */
    async 'plan.drafts'() {
      const j = readDraftIndex(core)
      const drafts = []
      for (const d of j.drafts || []) {
        const row = Object.assign({}, d)
        try {
          const text = core.readText(PLAN_DRAFT_DIR + '\\' + d.file)
          const p = parsePlan(text)
          row.chars = text.length
          row.missingSections = p.missing
          row.title2 = p.title
          row.preview = text.slice(0, 400)
        } catch (e) { row.error = '草稿文件读不到：' + oneLine(e && e.message) }
        drafts.push(row)
      }
      return { drafts, dir: PLAN_DRAFT_DIR, sections: PLAN_SECTIONS }
    },

    /**
     * 生成一份教案草稿（**一次一课**）。
     *
     * 为什么不做「整模块一次生成」：一次生成 6 课时的输出会很长，
     * 模型在后半段明显变糙，而老师要审的是一大坨、改一处就得整块重跑。
     * 逐课生成可以「生成 → 看一眼 → 采纳 → 下一课」，成本也是逐次可见的。
     */
    async 'plan.draft'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson)
      if (!(lessonNo > 0)) throw new Error('要指定课时号（lesson）')
      const tree = await core.getTree()
      if (!tree) throw new Error('读不到课程结构索引：' + C.INDEX_REL)

      const { spans, byChapter } = await moduleSpans()
      const anchors = readAnchors(core)
      const st = outlineStatus(core, tree, { spans, anchors })
      const row = st.lessons.find((r) => Number(r.no) === lessonNo)
      if (!row) throw new Error('索引里没有第 ' + lessonNo + ' 课时')

      // 课件正文由 collectLesson 自己取（传 slidesByChapter 进去）。
      // 不让调用方在外面填 slideText：忘填的症状是模型看不到课件却照样写出推导，
      // 而且**不报错**。
      const data = collectLesson(core, tree, lessonNo, { spans, anchors, slidesByChapter: byChapter })

      const catalog = await listModelCatalog(ctx)
      const choice = resolveChoice(readModelChoice(), catalog)
      if (!choice) throw new Error('拿不到模型选择：面板里选一个模型，或先在 DSH 里设置默认模型')

      const trace = []
      const r = await runPlanDraft(ctx, {
        lessonNo,
        data,
        courseTitle: (core.info().course || {}).title || '',
        courseGoal: (core.info().course || {}).goal || '',
        trace,
        choice,
      })
      const meta = {
        lesson: lessonNo, title: row.title, module: row.module,
        file: undefined, status: 'draft', chars: r.text.length,
        sections: PLAN_SECTIONS.map((s) => s.title),
        missing: r.parsed.missing,
        model: r.provider + '/' + r.model,
        usage: r.usage,
        promptChars: r.promptChars,
        saw: r.saw,
        anchor: data.anchor,
        at: new Date().toISOString(),
        teacher: TEACHER,
      }
      // 文件名由「课时号 + 标题」定，与正式教案同构 —— 采纳时不用改名，
      // 索引里的 plan 字段也就直接对得上。
      const entry = saveDraft(core, Object.assign(meta, { file: C.draftFileName(lessonNo, row.title) }), r.text)
      const out = Object.assign({}, entry)
      delete out.text
      return {
        ok: true, draft: Object.assign(out, { preview: entry.text.slice(0, 600) }),
        // 骨架解析用的是**落盘后**的那份：模型输出里可能带前言/代码块，
        // 清洗之后节标题才算数，用原始输出解析会误报「缺验收标准」。
        missing: parsePlan(entry.text).missing, usage: r.usage, trace,
        next: '去「教案补全」里读一遍 → 采纳（写进 ' + (data.module ? (data.module.dir + '\\' + data.module.planDir) : '详细教案')
          + '\\ 并更新索引）或先手改草稿。',
      }
    },

    /** 读一份草稿或正式教案的全文（审批界面用） */
    async 'plan.read'(args) {
      const input = args && typeof args === 'object' ? args : {}
      if (input.lesson !== undefined) {
        const d = findDraft(core, Number(input.lesson))
        if (!d) throw new Error('第 ' + input.lesson + ' 课时还没有草稿')
        return { kind: 'draft', file: d.file, meta: d, text: core.readText(PLAN_DRAFT_DIR + '\\' + d.file) }
      }
      const p = typeof input.path === 'string' ? input.path : ''
      if (!p || !core.exists(p)) throw new Error('文件不存在：' + p)
      return { kind: 'plan', path: p, text: core.readText(p) }
    },

    /** 老师直接改草稿后保存（不改就采纳的场景不用它） */
    async 'plan.save'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson)
      const d = findDraft(core, lessonNo)
      if (!d) throw new Error('第 ' + lessonNo + ' 课时还没有草稿')
      if (typeof input.text !== 'string') throw new Error('缺少 text')
      core.writeText(PLAN_DRAFT_DIR + '\\' + d.file, input.text)
      const p = parsePlan(input.text)
      updateDraftMeta(core, lessonNo, { chars: input.text.length, missing: p.missing, editedAt: new Date().toISOString() })
      return { ok: true, lesson: lessonNo, chars: input.text.length, missingSections: p.missing }
    },

    /**
     * 采纳：草稿 → `<模块>/详细教案/课时N_*.md`，并把索引里的 plan 指过去。
     *
     * 这是**唯一**会写进正式教案的入口，而且是老师按的按钮 ——
     * 教案是验收基准，批改会拿它逐条 judge 学生，不能由代码自己背书。
     */
    async 'plan.accept'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson)
      if (!(lessonNo > 0)) throw new Error('要指定课时号（lesson）')
      const r = acceptDraft(core, lessonNo, { overwrite: input.overwrite === true })
      // 索引改了 → 课程树的缓存必须失效，否则面板还会说「教案未撰写」
      core.invalidateCache()
      return Object.assign(r, { note: '已写进正式教案，索引已同步。学生端下次拉取就能拿到新教案。' })
    },

    /** 不采纳：标记为 rejected（留着，不删 —— 老师可能过两天想捡回来） */
    async 'plan.reject'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson)
      const d = updateDraftMeta(core, lessonNo, { status: 'rejected', rejectedAt: new Date().toISOString() })
      if (!d) throw new Error('第 ' + lessonNo + ' 课时还没有草稿')
      return { ok: true, draft: d }
    },
    /** 彻底删掉一份草稿 */
    async 'plan.delete'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const d = removeDraft(core, Number(input.lesson))
      if (!d) throw new Error('第 ' + input.lesson + ' 课时还没有草稿')
      return { ok: true, removed: d }
    },

    /**
     * 重建索引：扫 `详细教案/` 把索引里的 `plan` 对齐磁盘。
     *
     * 存在的理由：老师写完一份教案放进目录，很容易忘了回来改索引；
     * 而索引一漏，学生端就说「这一课时没有教案」，批改随即退化成通用初筛，
     * **且没有任何报错**。列出的每一处改动都给老师看一眼，不静默修正。
     */
    async 'index.rebuild'() {
      const r = rebuildIndex(core)
      if (r.wrote) core.invalidateCache()
      return Object.assign(r, { note: r.wrote ? '索引已更新（上面每一处都列出来了）' : '索引与磁盘一致，没有需要改的' })
    },

    /**
     * 课堂记录汇总：把一次课的提问按课时与类型排成一个可读列表，
     * 用于课后归档。老师可以据此改教案或写答疑课提纲。
     */
    async digest(args) {
      const input = args && typeof args === 'object' ? args : {}
      const items = await core.listItems()
      const byLesson = new Map()
      for (const it of items) {
        const k = it.lesson || '未标注'
        if (!byLesson.has(k)) byLesson.set(k, [])
        byLesson.get(k).push(it)
      }
      const out = []
      for (const [lesson, list] of byLesson) {
        out.push({
          lesson,
          total: list.length,
          byType: list.reduce((a, i) => { a[i.type || '未分类'] = (a[i.type || '未分类'] || 0) + 1; return a }, {}),
          bySeverity: list.reduce((a, i) => { a[i.severity || '未标注'] = (a[i.severity || '未标注'] || 0) + 1; return a }, {}),
          students: [...new Set(list.map((i) => i.student).filter(Boolean))].length,
          shared: list.filter((i) => i.audit === 'shared').length,
          titles: list.slice(0, 40).map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, student: i.student })),
        })
      }
      out.sort((a, b) => b.total - a.total)
      return { generatedAt: new Date().toISOString(), teacher: TEACHER, lessons: out, courseCode: COURSE_CODE, want: input.lesson || null }
    },
  }

  core.registerApi(handlers)
  core.mount()
  console.log('[' + LABEL + '] 就绪 v0.2.0 · 教师=' + TEACHER + ' · 工作区=' + core.WORKSPACE + '（' + core.WS.how + '）· 前缀 ' + PREFIX)
}

export default { name, inject, apply }
