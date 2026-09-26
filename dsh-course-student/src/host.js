/**
 * dsh-course-student —— 学生端课程面板（宿主半区）
 *
 * 与教师端是**两个独立插件**：各自的路由前缀、各自的侧栏入口，可以装在同一个
 * DSH 进程里。DSH 的 webServer 对重复的 (kind, path) 会抛错，所以前缀必须不同 ——
 * 这不是偏好，是硬约束。
 *
 * 这个半区负责「花钱的那一侧」：
 *   · 提问与每一轮追问都调用模型（老师的原话：隐性提问，费用学生自己承担）
 *   · 作业按教案批改也调用模型
 * 因此每次调用都把 token 用量记进条目，面板里能看见自己花了多少。
 */
import path from 'node:path'
import { loadCore, PLUGIN_ROOT } from './core-loader.js'

export const name = 'course-panel-student'
export const inject = ['webServer']

const PREFIX = process.env.CIP_STU_PREFIX || '/cip-stu'
const LABEL = '鼹鼠仔·学生端'

export async function apply(ctx) {
  const C = await loadCore()
  const core = C.createCore(ctx, { prefix: PREFIX, role: 'student', pkgRoot: PLUGIN_ROOT, label: LABEL })
  core.warn()

  const {
    oneLine, today, safeId, pad4, extAllowed, pickEnum, parseIssueList, ALLOWED_EXT,
    MODULES, TYPES, SEVERITIES, SOURCES, MAX_SUB_BYTES, MAX_THREAD_TURNS,
    runTurn, makeFacets, makeSummary, runGrade, listModelCatalog,
    submitExtAllowed, SUBMIT_EXT, MAX_BLOB_BYTES, MAX_SUBMIT_FILES,
    // 缓存层（来自 dsh-course-core/src/cache.js）：提交清单是派生数据，
    // 每次打开面板都重扫目录 + 列附件目录，而原始数据一分钟内不会变。
    cached, statOf, clearCache, cacheInfo, cacheDir,
    // ⚠️ 这里**故意不**解构 PUBLIC_ITEMS_REL / STUDENT_ITEMS_REL。
    //    它们是内核的**模块级**常量，写死的是默认形状（'课程问题池\...'）；
    //    而 createCore 内部用同名的**局部** const 把布局配置遮蔽掉了
    //    （这样那几十处老代码一个字都不用改就跟着配置走）。
    //    于是「解构进来的那个」永远是默认值、「core.STUDENT_ITEMS_REL」才是按
    //    课程配置算出来的那个 —— 两个名字长得一样、值不一样，这是最坏的一种。
    //    症状：老师把 layout.questionsRel 配成「答疑」后，core 把自己的提问写进
    //    答疑\学生\<学号>\，而面板按默认目录去找 —— 学生**看不见自己刚提的问题**，
    //    不报错、也不像是坏了。所以目录类常量一律从 core 实例上取。
    // 起子进程并**收回输出**（拉取更新要跑 git）。不能用带 encoding 的 spawnSync：
    // 沙箱不给管道，那种写法一律 EPERM 且不抛异常（详见 core/src/run.js）。
    runCaptured, runOutput, runExitCode,
    // 人的身份：本机学号 / 学生自报 / 老师名册
    readIdentity, writeIdentity, resolveStudentId, IDENTITY_REL,
    readRoster, readStudentInfo, writeStudentInfo, nameOf, labelOf, moveStudent,
    STUDENT_INFO_FILE, IDENTITY_FIELDS,
    // zip：学生交整个项目时，把里面的代码解出来送进批改（只用内置 zlib）
    looksLikeZip, extractTextEntries,
    // 就绪清单：装完插件第一件事是告诉用户还差什么
    studentReadiness,
  } = C

  /**
   * 学生身份：用于把提问/作业归到自己名下。
   *
   * 解析顺序（见 core/people.js）：CIP_STUDENT 环境变量 > 本机身份文件 > 系统用户名。
   * 最后那档是**兜底而不是默认** —— 老师打开教师端看到提问者叫 `Administrator`
   * 就是这么来的：那不是学生，是这台 Windows 机器的用户名。
   * 所以面板会在它是兜底值时提示「你还没填学号」。
   *
   * ⚠️ 是 `let`：学生可以在面板里填/改自己的学号（identify），
   *    改学号要连带**搬迁**目录（见 identify 动作），不能只改一个字段 ——
   *    学号就是目录名，不搬等于把历史数据留在原地看不见。
   */
  let RESOLVED = resolveStudentId(core, process.env)
  let STUDENT = RESOLVED.sid
  let MY_DIR = core.STUDENT_ITEMS_REL + '\\' + STUDENT
  function reidentify(sid) {
    STUDENT = sid
    MY_DIR = core.STUDENT_ITEMS_REL + '\\' + STUDENT
  }

  /**
   * ── 模型选择（每个学生自己一份）──────────────────────────────────
   *
   * 为什么不写进 DSH 的设置：DSH 的模型选择是**整场会话**级别的 ——
   * 学生在这个面板里提问时改掉它，会连带改掉他整个会话的模型（包括和他自己
   * 的 DSH agent 对话）。那是别的插件的领地，这里不该动。
   *
   * 所以选择存在**课程工作区**里：课程问题池/学生/<学号>/模型选择.json。
   * 它跟着学生走，不跟着会话走，而且换机器 clone 下来还在（在 .gitignore 里，
   * 不会把自己的偏好推给别人）。
   */
  // ⚠️ 必须是函数而不是 const 字符串：学号可以在面板里改（identify 动作），
  //    固化成 const 会让「改完学号，模型选择还指着旧目录」——不报错，只是设置丢了。
  const modelChoiceRel = () => MY_DIR + '\\模型选择.json'
  function readModelChoice() {
    try {
      const t = core.readText(modelChoiceRel())
      if (!t) return null
      const j = JSON.parse(t)
      if (j && typeof j.provider === 'string' && typeof j.model === 'string' && j.provider && j.model) {
        return { provider: j.provider, model: j.model, reasoningEffort: typeof j.reasoningEffort === 'string' ? j.reasoningEffort : '' }
      }
      return null
    } catch (e) { return null }   // 文件坏了就当没选过，不要因此打不开面板
  }
  function writeModelChoice(sel) {
    try {
      core.writeText(modelChoiceRel(), JSON.stringify({
        provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || '',
        savedAt: new Date().toISOString(),
        _说明: '这个文件只属于你（在 .gitignore 里）。面板提问/批改默认用它指定的模型；清空为空对象即回到 DSH 会话默认。',
      }, null, 2) + '\n')
      return true
    } catch (e) { return false }
  }
  /** 把「学生选的 + 会话默认」合成一次调用要用的选择 */
  function resolveChoice(saved, catalog) {
    const c = catalog && catalog.current ? catalog.current : null
    if (saved && saved.provider && saved.model) return saved
    if (c) return { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort || '' }
    return null
  }

  function acc(a, b) {
    return {
      inputTokens: Number(a.inputTokens || 0) + Number(b && b.inputTokens || 0),
      outputTokens: Number(a.outputTokens || 0) + Number(b && b.outputTokens || 0),
    }
  }
  function usageField(u) {
    const s = 'in ' + Number(u.inputTokens || 0) + ' / out ' + Number(u.outputTokens || 0)
    return s
  }

  /** 把磁盘上的版本清单补齐（附件实时列目录，避免清单与磁盘不一致） */
  function versionsOf(lessonNo) {
    const list = core.readVersions(STUDENT, lessonNo)
    const pre = core.info().prefixes.sub
    return list.map((v) => Object.assign({}, v, {
      files: core.listVersionFiles(STUDENT, lessonNo, v.v).map((f) => Object.assign({}, f, {
        url: pre + '/' + encodeURIComponent(STUDENT) + '/' + encodeURIComponent('课时' + lessonNo)
          + '/' + encodeURIComponent('v' + v.v) + '/' + encodeURIComponent('_附件') + '/' + encodeURIComponent(f.name),
        image: /\.(png|jpe?g|webp|gif)$/i.test(f.name),
      })),
    })).sort((a, b) => Number(b.v) - Number(a.v))
  }

  /**
   * 公开 / 撤回一条提问。
   *
   * 只改 `audit` 字段，**不动文件位置**：
   *   学生自己的条目一直在他自己的目录里，公开只是把 audit 置为 shared，
   *   教师端的列表据此过滤。这样撤回也是立刻生效的（没有副本要回收），
   *   也不会出现「公开过就再也拿不回来」。
   *   真正的「策展副本」仍由教师端的 audit 动作产生 —— 那是老师的选择。
   */
  async function shareItem(input) {
    const p = typeof input.path === 'string' ? input.path : ''
    if (!p || !core.exists(p)) throw new Error('条目不存在')
    // 只能操作自己的东西：公开是「把自己的问题交出去」，
    // 不该能改到别人（或公共面）的条目。
    // 判据统一走 ownPathScope —— 原来的 `indexOf('\\' + STUDENT + '\\')` 有两个毛病：
    // 学号互为前缀时会误判（`S001` 命中 `S0011\`），而且对公共面的条目也可能放行。
    const mineScope = ownPathScope(p, core, STUDENT)
    if (mineScope !== 'mine') throw new Error('只能公开你自己的提问（这条不属于 ' + STUDENT + '）')
    const want = input.shared === true
    const it = core.readItem(p)
    it.fields.audit = want ? 'shared' : 'not_shared'
    it.fields.updated = today()
    // 公开时把状态推进一步，老师一眼能看出「这条是学生主动交上来的」
    if (want && (!it.fields.status || it.fields.status === '待处理')) it.fields.status = '已答复'
    core.writeItem(p, it.fields, core.sectionsOf(it.body), it.turns)
    return { ok: true, path: p, shared: want, audit: it.fields.audit, status: it.fields.status }
  }
  /** 建一条新条目（落在我自己的私有目录里） */
  async function createItem(fields, sections, turns) {
    const rel = core.itemRelFor(fields, fields.title, 'student', STUDENT)
    core.writeItem(rel, fields, sections, turns || [])
    return rel
  }

  // ── 证据（跨章节、跨页收集的多块内容）──────────────────────────────
  /**
   * 为什么证据要结构化而不是拼成一段文字：
   *   一个知识点常横跨好几页（这页给公式、下页给直觉、再下页给代码）。
   *   拼成一段就丢了「哪一段来自哪一页」，而这个信息正是老师复盘和自己回看时
   *   最需要的 ——「他问的是第 12 页那块，不是第 30 页」。
   *
   * 图片上限 MAX_IMAGES：每张图都要进上下文，费用是学生自己出的。
   *   超过上限的部分**不静默丢掉**，而是退回成只有位置与文字的块，
   *   并在 warn 里说清楚丢了几张 —— 静默截断会让学生以为模型看到了全部。
   */
  const MAX_EVIDENCE = 12
  const MAX_IMAGES = 4
  const MAX_EVIDENCE_TEXT = 900

  function normalizeEvidence(input) {
    const raw = Array.isArray(input.evidence) ? input.evidence : []
    const list = []
    for (const e of raw.slice(0, MAX_EVIDENCE)) {
      if (!e || typeof e !== 'object') continue
      list.push({
        chapter: oneLine(e.chapter) || '未标注章节',
        page: Number(e.page) || 0,
        kind: e.kind === 'text' ? 'text' : (e.kind === 'page' ? 'page' : 'region'),
        label: oneLine(e.label) || '',
        text: typeof e.text === 'string' ? e.text.slice(0, MAX_EVIDENCE_TEXT) : '',
        note: oneLine(e.note) || '',
      })
    }
    // 兼容老调用方：只传了一个 dataUrl（或只传了 text）也能工作
    let urls = Array.isArray(input.dataUrls) ? input.dataUrls.filter((u) => typeof u === 'string' && u) : []
    if (!urls.length && typeof input.dataUrl === 'string' && input.dataUrl) urls = [input.dataUrl]
    const images = urls.slice(0, MAX_IMAGES)
    // 页数按 **去重后的 (章节,页)** 算，不是数「整页截图块数」。
    // 这两个概念混过一次：字段文案写「2 块 / N 页」，而 N 当时数的是整页截图有几块，
    // 于是同一页收了两块会显示成「2 页」——老师看着以为是跨了两页。
    const pageKeys = {}
    list.forEach((x) => { pageKeys[x.chapter + '|' + x.page] = 1 })
    const counts = {
      regions: list.filter((x) => x.kind === 'region').length,
      texts: list.filter((x) => x.kind === 'text').length,
      fullPages: list.filter((x) => x.kind === 'page').length,
      pages: Object.keys(pageKeys).length,
      images: images.length,
      droppedImages: Math.max(0, urls.length - images.length),
    }
    return { list: list, images: images, counts: counts }
  }

  /** 把证据渲染成条目正文里的可读小节（老师和学生回看时靠它定位） */
  function formatEvidence(list) {
    if (!list || !list.length) return ''
    const out = ['', '', '**本次提供的证据（' + list.length + ' 块）**', '']
    list.forEach((e, i) => {
      const where = e.chapter + ' 第 ' + e.page + ' 页'
      const what = e.kind === 'page' ? '整页截图' : (e.kind === 'text' ? '拖选文字' : '框选图区')
      out.push((i + 1) + '. ' + where + ' · ' + what + (e.note ? '（' + e.note + '）' : ''))
      if (e.text) {
        out.push('')
        out.push('   > ' + e.text.replace(/\n+/g, ' ').slice(0, 600))
      }
    })
    return out.join('\n')
  }

  /**
   * 公开问答索引。优先读发布时生成的 公开问答.json；没有就现场汇总。
   * 两种来源都给同一个形状，客户端不必分情况处理。
   */
  async function publicIndex() {
    for (const rel of ['公开问答.json', '课程中心\\公开问答.json']) {
      if (!core.exists(rel)) continue
      try {
        const j = JSON.parse(core.readText(rel))
        return { source: rel, generatedAt: j.generatedAt || '', count: j.count || (j.items || []).length, withTeacherAnswer: j.withTeacherAnswer || 0, items: j.items || [] }
      } catch (e) { /* 换下一个候选 */ }
    }
    const all = await core.listItems()
    const pub = all.filter((i) => i.scope === 'public')
    const items = pub.map((i) => {
      let teacherTurns = 0
      try { teacherTurns = core.readThread(core.threadPathFor(core.abs(i.path))).filter((x) => x.by === 'teacher').length } catch (e) {
        console.error('[课程面板·学生端] 公开索引线程标记失败 ' + i.path + '：' + oneLine(e && e.message))
        teacherTurns = 0
      }
      return {
        path: i.path, id: i.id, title: i.title, summary: i.summary, module: i.module, lesson: i.lesson,
        type: i.type, severity: i.severity, status: i.status, created: i.created, student: i.student,
        teacherTurns, hasTeacherAnswer: teacherTurns > 0,
      }
    })
    return { source: '实时汇总', generatedAt: '', count: items.length, withTeacherAnswer: items.filter((x) => x.hasTeacherAnswer).length, items }
  }

  // ── 数据面 ──────────────────────────────────────────────────
  /**
   * 「我是谁」的当前状态。界面靠 `identified` 决定要不要弹那张填写卡片，
   * 靠 `how` 说清这个学号是从哪来的 —— 「Administrator」这种兜底值必须被
   * 明确标出来，否则学生永远不知道老师那边看到的是个机器用户名。
   */
  function describeMe() {
    const roster = readRoster(core)
    const info = readStudentInfo(core, STUDENT)
    const rosterRow = roster.students[STUDENT] || null
    return {
      sid: STUDENT,
      name: nameOf(STUDENT, roster, info),
      label: labelOf(STUDENT, roster, info),
      klass: (info && info.klass) || (rosterRow && rosterRow.klass) || '',
      // identified：本机身份文件里有没有这个人。环境变量指定的也算（多开/测试用）。
      identified: !RESOLVED.fallback,
      how: RESOLVED.how,
      fromEnv: !!process.env.CIP_STUDENT,
      identityFile: (readIdentity(core) || {}).file || core.courseAbs(IDENTITY_REL),
      identityRel: IDENTITY_REL,
      infoFile: MY_DIR + '\\' + STUDENT_INFO_FILE,
      fromRoster: !!(rosterRow && rosterRow.name),
      rosterName: rosterRow ? rosterRow.name : '',
      fields: IDENTITY_FIELDS,
    }
  }

  /** 改学号前先数一数会搬走什么 —— 搬迁是不可逆的，得让人看见搬多少。 */
  function inventoryOf(sid) {
    const items = core.listDir(core.STUDENT_ITEMS_REL + '\\' + sid).filter((e) => e.isFile() && /\.md$/i.test(e.name)).length
    let submissions = 0
    for (const d of core.listSubmissions()) if (d.student === sid) submissions += 1
    return { items, submissions }
  }

  const handlers = {
    async info() {
      const items = await core.listItems()
      const mine = items.filter((i) => i.student === STUDENT || i.scope === 'legacy')
      const pub = items.filter((i) => i.scope === 'public')
      return Object.assign(core.info(), {
        student: STUDENT, myDir: MY_DIR,
        // 「你是谁」——面板顶部要能显示出来，老师端看到的提问者就是这个名字。
        // 没填过时 how 会是「系统用户名（兜底，不是你的学号）」，界面据此提示。
        me: describeMe(),
        counts: { mine: mine.length, public: pub.length, total: items.length },
        // 当前会用哪个模型回答：界面顶部要显示出来。费用是学生自己出的，
        // 「这条问题用什么模型跑的」不能只藏在日志里。
        // 这里连会话默认一起解析，所以「没选过」时显示的是真实的会话模型，不是 null。
        modelChoice: resolveChoice(readModelChoice(), await listModelCatalog(ctx)),
      })    },
    async tree() { return { tree: await core.getTree() } },

    // ── 我是谁 ──────────────────────────────────────────────────
    /**
     * 一次填清楚「你是这个班的谁」。
     *
     * 为什么非要有这一步：学生身份原来就是 `process.env.USERNAME`，
     * 于是老师打开教师端，提问者一栏写着 **Administrator** —— 那不是学生，
     * 是这台 Windows 机器的用户名。老师要看的是「谁提问的，好针对性教学」。
     *
     * 改学号必须**搬迁**目录（学号就是目录名），而搬迁是不可逆的，
     * 所以分两步：第一次调用只回报「会搬多少东西」，带 confirm 才真搬。
     */
    async 'student.me'() { return describeMe() },

    /**
     * 就绪清单。面板装完第一件事就拉它 ——
     * 「面板是空的」有四种完全不同的原因，而界面上看起来一模一样。
     */
    async readiness() {
      const info = core.info()
      const tree = await core.getTree()
      const cat = await listModelCatalog(ctx)
      const saved = readModelChoice()
      const eff = resolveChoice(saved, cat)
      return studentReadiness(core, describeMe(), {
        // 用 core.exists 而不是 fs.existsSync + path.join：
        // 「共享内容在根目录、私有数据在课程目录」这套解析是 core 的职责，
        // 宿主里自己拼路径迟早会和它对不上（多课程下拼错就是静默读错地方）。
        // 这里查的是结构索引，它是共享内容，也是「这里是不是一个课程工作区」的判据。
        workspaceOk: core.exists('课程中心\\课程结构索引.json'),
        workspace: core.WORKSPACE,
        hasModel: !!(eff && eff.provider && eff.model),
        modelLabel: eff ? (eff.provider + '/' + eff.model) : '',
        course: info.course,
        lessonCount: tree && tree.totalLessons ? tree.totalLessons : 0,
      })
    },
    async 'student.identify'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const sid = safeId(input.sid)
      if (!sid) throw new Error('学号不能为空（它决定你的提问与作业放在哪个目录下）')
      const name = oneLine(input.name).slice(0, 24)
      const klass = oneLine(input.klass).slice(0, 24)
      const oldSid = STUDENT
      const changing = sid !== oldSid

      // 第一步：改学号前先把「会搬什么」报出来，不给 confirm 就先不动。
      if (changing && input.confirm !== true) {
        const inv = inventoryOf(oldSid)
        if (inv.items || inv.submissions) {
          return {
            ok: false, needsConfirm: true, from: oldSid, to: sid,
            willMove: inv,
            message: '学号从 ' + oldSid + ' 改成 ' + sid + ' 会把已有数据一起搬过去：'
              + '提问 ' + inv.items + ' 条、提交 ' + inv.submissions + ' 份。'
              + '搬完旧学号下就没有东西了（这是搬移，不是复制）。确认要改吗？',
          }
        }
      }

      // 第二步：搬目录（目标已存在时**不合并、不覆盖**，报出来让人处理）
      let move = null
      if (changing) {
        move = moveStudent(core, oldSid, sid)
        const conflict = (move.moved || []).filter((m) => m.conflict)
        if (conflict.length) {
          throw new Error('目标学号 ' + sid + ' 下已经有数据（'
            + conflict.map((c) => c.dst).join('、') + '）——不自动合并两个学生的数据，'
            + '请先确认那是不是你自己，或换一个学号。')
        }
      }

      const saved = writeIdentity(core, { sid, name, klass, code: (core.info().course || {}).code || '' })
      reidentify(sid)
      // ⚠️ **必须同时更新 RESOLVED**，否则「我是谁」那一项永远显示「缺」：
      //    describeMe() 的 identified 是从 RESOLVED.fallback 算的，而这里原来只改了
      //    STUDENT / MY_DIR。症状很有迷惑性 —— 提示写着「已改名为 1931，数据已跟着搬过去」，
      //    可清单里那一项还是红的，用户会以为没保存成功，于是再存一遍。
      RESOLVED = { sid: sid, how: '本机身份文件 ' + IDENTITY_REL, identity: saved }
      writeStudentInfo(core, sid, { name, klass })
      // 缓存里那个「我的提交清单」是按学号做键的，换了学号必须清，否则读到旧键的缓存
      try { clearCache(core.WORKSPACE) } catch (e) { /* 清不掉就重算 */ }
      return {
        ok: true, sid, name, klass, changed: changing, move,
        identityFile: saved.file,
        note: changing
          ? '已改名为 ' + sid + '，数据已跟着搬过去。'
          : '已记住。老师那边看到的提问者就是' + (name ? ('「' + name + '（' + sid + '）」') : ('「' + sid + '」')) + '。',
      }
    },

    /**
     * 可选模型目录（面板上的「用哪个模型回答」下拉框的数据源）。
     * 同时告诉界面「当前实际会用哪个」——学生选的，或者会话默认。
     */
    async 'model.catalog'() {
      const catalog = await listModelCatalog(ctx)
      const saved = readModelChoice()
      const effective = resolveChoice(saved, catalog)
      return {
        providers: catalog.providers,
        models: catalog.models,
        sessionDefault: catalog.current,
        saved: saved,
        effective: effective,
        warnings: catalog.warnings || [],
      }
    },
    /**
     * 记住「以后提问用哪个模型」。传空 provider 表示回到会话默认。
     * 只写自己的目录，不碰 DSH 的设置 —— 理由见 MODEL_CHOICE_REL 的注释。
     */
    async 'model.select'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const provider = oneLine(input.provider)
      const model = oneLine(input.model)
      if (!provider || !model) {
        if (writeModelChoice({ provider: '', model: '' })) return { ok: true, cleared: true }
        throw new Error('清除模型选择失败：写入 ' + modelChoiceRel() + ' 失败')
      }
      const catalog = await listModelCatalog(ctx)
      const known = (catalog.models || []).some((m) => m.provider === provider && m.model === model)
      // 目录里没有也允许保存（用户可能手填了一个还没被 listModels 报出来的模型），
      // 但要在返回值里说清楚，界面好提示。
      const sel = { provider, model, reasoningEffort: oneLine(input.reasoningEffort) }
      if (!writeModelChoice(sel)) throw new Error('保存模型选择失败：写入 ' + modelChoiceRel() + ' 失败')
      return { ok: true, saved: sel, inCatalog: known, path: modelChoiceRel() }
    },
    async slides(args) { return (await core.getSlides(args && args.chapter)) || { error: '该章课件数据不存在' } },
    async docs(args) {
      if (args && typeof args.path === 'string' && args.path) {
        return { path: args.path, name: args.path.split('\\').pop(), text: core.readText(args.path) }
      }
      return { docs: await core.listDocs() }
    },

    /** 问题列表：只有「我自己的」+「老师策展后公开的」，看不到别的同学的 */
    async threads() {
      const all = await core.listItems()
      const mine = all.filter((i) => i.scope === 'legacy' || (i.scope === 'student' && i.student === STUDENT))
      const pub = all.filter((i) => i.scope === 'public')
      // 有教师答复的条目标出来，列表里一眼能看出「老师答过我这条」
      const mark = (list) => list.map((i) => {
        try {
          const turns = core.readThread(core.threadPathFor(core.abs(i.path)))
          const t = turns.filter((x) => x.by === 'teacher').length
          return Object.assign({}, i, { teacherTurns: t, hasTeacherAnswer: t > 0 })
        } catch (e) {
          // 不能静默吞掉：这里曾经因为核心没暴露 readThread 而全部抛错，
          // 结果「教师已答复」标记永远是 false，界面上看不出任何异常。
          console.error('[课程面板·学生端] 线程标记失败 ' + i.path + '：' + oneLine(e && e.message))
          return Object.assign({}, i, { teacherTurns: 0, hasTeacherAnswer: false, markError: oneLine(e && e.message) })
        }
      })
      return { student: STUDENT, mine: mark(mine), public: mark(pub), myDir: MY_DIR, publicDir: core.PUBLIC_ITEMS_REL, publicIndex: await publicIndex() }
    },
    /**
     * 公开问答索引（课程发布时生成，随公开仓分发）。
     * 这是「共同数据库」公开那一半的结构化视图 —— 学生端因此能整体看到
     * 老师公开了哪些问题、每个问题的总结是什么，不必逐个解析 markdown。
     */
    async 'public.index'() {
      return await publicIndex()
    },

    /**
     * 从远端拉取课程更新（老师新公开的问答、新发布的教案）。
     *
     * 为什么要有这个：面板读的是**本机工作区**。老师公开了新内容、推上去了，
     * 学生本地那份不会自动变 —— 没有这个动作，「学生能看到老师公开的问答」
     * 只是理论上的。只做 `git pull --ff-only`：快进合并，绝不产生 merge commit，
     * 也绝不碰学生自己的东西（他的提问在 .gitignore 里，pull 不会动）。
     */
    async sync(args) {
      const input = args && typeof args === 'object' ? args : {}
      const fs = await import('node:fs')
      const pathMod = await import('node:path')
      if (!fs.existsSync(pathMod.join(core.WORKSPACE, '.git'))) {
        return { ok: false, error: '当前工作区不是一个 git 仓库（' + core.WORKSPACE + '），无法拉取更新' }
      }
      // ⚠️ 必须走 runCaptured，不能用带 encoding 的 spawnSync：
      //    沙箱不给管道，那种写法在本机一律 EPERM，而且**不抛异常** ——
      //    返回 {status:null,error:EPERM,stdout:''}，于是这里每一行都判断失败，
      //    学生点「拉取更新」永远得到「拉取失败（可能是本地有未提交的改动）」
      //    这句与真实原因毫无关系的话。详见 core/src/run.js 顶部。
      const run = (cmdArgs) => runCaptured('git', cmdArgs, { cwd: core.WORKSPACE, timeout: 120000, hintDir: core.WORKSPACE })
      // 先看远端有没有新东西，避免每次都白跑一次 pull
      const before = run(['rev-parse', '--short', 'HEAD'])
      const r = run(['pull', '--ff-only'])
      const after = run(['rev-parse', '--short', 'HEAD'])
      const out = runOutput(r)
      const changed = before.status === 0 && after.status === 0 && before.stdout.trim() !== after.stdout.trim()
      if (runExitCode(r) !== 0) {
        // 按真实原因给话术，而不是一句笼统的「可能是本地有改动」。
        // 详细的分类理由见文件末尾的 classifySyncFailure()。
        const cls = classifySyncFailure(out)
        return { ok: false, error: cls.error, detail: out.slice(-1500), hint: cls.hint }
      }
      void input
      return {
        ok: true, changed,
        before: before.status === 0 ? before.stdout.trim() : '', after: after.status === 0 ? after.stdout.trim() : '',
        output: out.slice(-1500),
        hint: changed ? '已更新。重新打开面板或点「刷新」看新内容。' : '已经是最新的。',
      }
    },
    /** 读一条：md 全文 + 结构化线程 */
    async thread(args) {
      const p = args && typeof args.path === 'string' ? args.path : ''
      if (!p || !core.exists(p)) throw new Error('条目不存在：' + p)
      // 学生只能读自己的和已公开的，别的同学的私有条目不给读。
      // 判据统一走 ownPathScope（原来的字符串比较会把 `S001` 当成 `S0011\` 的前缀）。
      const scope = ownPathScope(p, core, STUDENT)
      if (scope === 'other-student' || scope === 'outside') throw new Error('这条提问不属于你')
      const it = core.readItem(p)
      const turns = it.turns
      const teacherTurns = turns.filter((x) => x.by === 'teacher').length
      // 对客户端仍报 'public' / 'student' / 'legacy' 三值（历史约定），
      // 但归属判定本身用的是 ownPathScope 的细粒度结果。
      const scopeOut = scope === 'mine' ? 'student' : scope
      return { path: p, fields: it.fields, body: it.body, turns, scope: scopeOut, teacherTurns, hasTeacherAnswer: teacherTurns > 0 }
    },

    /**
     * 提问：模型凝练标题 → AI 作答 → 归档。
     * 标题先凝练再落盘，这样文件名和列表里的标题从第一刻起就是统一风格的。
     */
    async ask(args) {
      const trace = []
      const input = args && typeof args === 'object' ? args : {}
      const question = oneLine(input.question)
      if (!question) throw new Error('缺少提问内容')
      const anchorText = typeof input.text === 'string' ? input.text : ''
      const ev = normalizeEvidence(input)
      const origin = oneLine(input.origin) || '未标注来源'
      const counts = ev.counts
      // 用哪个模型回答：面板里学生选的优先，没选过就沿用 DSH 会话当前的模型。
      // 每次提问都重新解析（而不是启动时读一次），学生刚在面板上换完模型就生效。
      const choice = resolveChoice(readModelChoice(), await listModelCatalog(ctx))

      let usage = { inputTokens: 0, outputTokens: 0 }
      let title = ''
      let summary = ''
      let answer = ''
      let aiFailed = false
      let aiNote = ''
      let topic = '其他'
      let concept = ''

      // 标题 + 分类一次产出（受控词表），不额外增加模型调用
      const t = await makeFacets(ctx, { question, anchorText, trace, choice })
      title = t.title; topic = t.topic; concept = t.concept; usage = acc(usage, t.usage)

      try {
        const r = await runTurn(ctx, { question, anchorText, evidence: ev.list, images: ev.images, history: [], trace, choice })
        answer = r.answer; usage = acc(usage, r.usage)
      } catch (error) { aiFailed = true; aiNote = oneLine(error && error.message); answer = '（AI 暂未作答：' + aiNote + '）' }

      const s = await makeSummary(ctx, { question, answer, thread: [], trace, choice })
      summary = s.summary; usage = acc(usage, s.usage)
      const id = await core.nextId()
      // loc：这条提问**指着哪里**。它是把课件/教案/作业与问题池串起来的关键字段 ——
      //   「第二章 第12页」/「教案 课时8 §损失曲面」/「作业 课时8 mlp.py」
      // 有了它，同一处被问过几次一眼可见，老师改教案时也能直接定位。
      const loc = oneLine(input.loc) || origin
      const fields = {
        id, title, summary, topic, concept, loc,
        source: pickEnum(input.source, SOURCES, '阅读器框选图区'),
        module: pickEnum(input.module, MODULES, '模块一'),
        lesson: oneLine(input.lesson) || '未标注',
        // slideSeq：这条提问来自课件的第几个「课件课时」（由分隔页自动切分而来）。
        // 它和索引里的课时号是两套编号，故意分开存，映射由锚点文件负责。
        slideSeq: Number(input.slideSeq) || 0,
        type: pickEnum(input.type, TYPES, '概念问题'),
        severity: pickEnum(input.severity, SEVERITIES, '中'),
        status: '待处理', created: today(), updated: today(),
        reporter: '学生（' + STUDENT + '）', student: STUDENT,
        related_files: ev.list.length ? ev.list.map((x) => x.chapter + ' 第' + x.page + ' 页') : [origin],
        ai: aiFailed ? '失败' : '已作答',
        tokens: usageField(usage),
        // 证据块数：老师一眼能看出「这个学生是跨页问的」，也便于日后统计
        evidence: ev.list.length ? (ev.list.length + ' 块 / ' + counts.pages + ' 页') : '未框选',
      }
      const sections = {
        '原始提问': origin + '\n\n' + question + formatEvidence(ev.list),
        'AI 答复': answer,
      }
      const rel = await createItem(fields, sections, [])
      const warn = counts.droppedImages
        ? ('本次共 ' + (counts.images + counts.droppedImages) + ' 张截图，只随消息带了前 ' + counts.images + ' 张（其余仍留在条目里可回看）')
        : ''
      return { ok: true, id, path: rel, title, summary, topic, concept, loc, answer, aiFailed, aiNote, usage, trace, counts, warn }
    },

    /**
     * ── 公开 / 撤回一条 ────────────────────────────────────────────────
     *
     * 为什么要有这个：批改会一次判出十几条问题，如果全部自动流向教师端，
     * 老师那边会瞬间堆到几十上百条，根本看不过来。决定权应该在学生手上 ——
     * 哪几条是他自己没搞懂、值得问老师的，哪几条只是代码细节。
     *
     * 只改 `audit` 字段，**不动文件位置**：
     *   学生自己的条目一直在他自己的目录里，公开只是把 audit 置为 shared，
     *   教师端的列表据此过滤。这样撤回也是立刻生效的（没有副本要回收），
     *   也不会出现「公开过就再也拿不回来」的情况。
     *   真正的「策展副本」仍然由教师端的 audit 动作产生 —— 那是老师的选择。
     */
    async 'item.share'(args) {
      return shareItem(args && typeof args === 'object' ? args : {})
    },
    /** 批量公开 / 撤回（批改一次出十几条，逐条点太累） */
    async 'item.share.batch'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const list = Array.isArray(input.paths) ? input.paths : []
      const want = input.shared === true
      if (!list.length) throw new Error('没有选择任何条目')
      const done = []
      const failed = []
      for (const p of list.slice(0, 200)) {
        try {
          const r = await shareItem({ path: p, shared: want })
          done.push(r.path)
        } catch (e) { failed.push({ path: p, error: oneLine(e && e.message) }) }
      }
      return { ok: true, shared: want, done: done.length, failed: failed }
    },

    /**
     * 追问：**每一轮都真的调模型作答**，没有「同上」。
     * 线程满 MAX_THREAD_TURNS 轮后会拒绝，避免一次提问无限烧 token。
     */
    async followup(args) {
      const trace = []
      const input = args && typeof args === 'object' ? args : {}
      const p = typeof input.path === 'string' ? input.path : ''
      const question = oneLine(input.question)
      if (!p || !core.exists(p)) throw new Error('条目不存在')
      // 只能追问**自己**的条目。
      //
      // 原来的写法是「不在自己目录里、也不是学生池开头」才进守卫，且守卫里只拦公开条目 ——
      // 对自己目录那段恒为假，于是**整个守卫是死代码**，任何本机进程都能给
      // 已公开条目或别人学号目录下的条目追加内容。见 ownPathScope 的注释。
      const scope0 = ownPathScope(p, core, STUDENT)
      if (scope0 === 'public') throw new Error('这是已公开的提问，不能改动；请新建你自己的提问')
      if (scope0 === 'other-student') throw new Error('这条提问不属于你')
      if (!question) throw new Error('缺少追问内容')

      const it = core.readItem(p)
      const turns = it.turns
      if (turns.length >= MAX_THREAD_TURNS) throw new Error('追问轮次已达上限 ' + MAX_THREAD_TURNS + ' 轮（防误触烧额度）')
      const sections = core.sectionsOf(it.body)
      const ev = normalizeEvidence(input)
      // 追问也服从面板上选的模型：否则「首答用 A 模型、追问变回默认」，
      // 学生会看到同一个线程里两段风格不一致的答案，而且账单也对不上。
      const mchoice = resolveChoice(readModelChoice(), await listModelCatalog(ctx))

      let answer = ''
      let aiFailed = false
      let aiNote = ''
      let usage = { inputTokens: 0, outputTokens: 0 }
      try {
        const r = await runTurn(ctx, {
          question, anchorText: typeof input.text === 'string' ? input.text : '',
          evidence: ev.list, images: ev.images, history: turns, trace, choice: mchoice,
        })
        answer = r.answer; usage = acc(usage, r.usage)
      } catch (error) { aiFailed = true; aiNote = oneLine(error && error.message); answer = '（AI 暂未作答：' + aiNote + '）' }
      turns.push({ q: question, a: answer, at: new Date().toISOString() })

      // 追加 AI 答复小节：让它和首答一起成为「完整问答」。
      // 追问时新框的内容也要留在条目里 —— 否则「他第二轮到底给我看了哪一块」
      // 事后完全查不到，而老师复盘时最需要的恰恰是这一条。
      sections['AI 答复'] = (sections['AI 答复'] || '') + '\n\n---\n\n**追问：** ' + question
        + formatEvidence(ev.list) + '\n\n' + answer
      // 轮次变多后重做一次问题总结，让它反映全部讨论（而不是只有第一轮）
      const s = await makeSummary(ctx, { question: sections['原始提问'] || it.fields.title, answer: sections['AI 答复'], thread: turns, trace, choice: mchoice })
      if (s.summary) { it.fields.summary = s.summary; usage = acc(usage, s.usage) }

      const prev = it.fields.tokens || ''
      const prevIn = Number((/in (\d+)/.exec(prev) || [])[1] || 0)
      const prevOut = Number((/out (\d+)/.exec(prev) || [])[1] || 0)
      it.fields.tokens = 'in ' + (prevIn + usage.inputTokens) + ' / out ' + (prevOut + usage.outputTokens)
      it.fields.updated = today()
      core.writeItem(p, it.fields, sections, turns)
      return { ok: true, turns: turns.length, answer, summary: it.fields.summary, aiFailed, aiNote, usage, trace }
    },

    /** 我的额度消耗：把条目里记的 token 累加起来，让学生看得见 */
    async usage() {
      const all = await core.listItems()
      const mine = all.filter((i) => i.scope === 'legacy' || (i.scope === 'student' && i.student === STUDENT))
      let tin = 0; let tout = 0
      const per = mine.map((i) => {
        const a = Number((/in (\d+)/.exec(i.tokens || '') || [])[1] || 0)
        const b = Number((/out (\d+)/.exec(i.tokens || '') || [])[1] || 0)
        tin += a; tout += b
        return { id: i.id, title: i.title, lesson: i.lesson, tokens: i.tokens, turns: i.turns }
      })
      return { student: STUDENT, inputTokens: tin, outputTokens: tout, items: per.length, per }
    },

    // ── 作业批改（模型费用由学生承担）──────────────────────────
    /**
     * 某课时的完整视图：教案 + 我的提交历史。
     *
     * 为什么学生端必须能看到教案：批改是「以教案为对齐基准」的，而基准对学生不可见 ——
     * 他只能看到一堆「与教案不符」，无从判断是教案要求手写、还是要求某个维度。
     * 老师端本来就能读教案，学生端读不到只是历史遗留。
     *
     * ⚠️ 这里**只读不写**：教案是老师的东西，学生端任何操作都不该改动它。
     */
    async 'lesson.open'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson) || 0
      if (!lessonNo) throw new Error('缺少课时号')
      const tree = await core.getTree()
      let found = null
      for (const m of (tree && tree.modules) || []) {
        for (const l of m.lessons || []) if (Number(l.no) === lessonNo) found = { mod: m, lesson: l }
      }
      if (!found) throw new Error('课程索引里没有课时 ' + lessonNo)
      const planRel = await core.planPathFor(lessonNo)
      let plan = ''
      let planNote = ''
      if (planRel && core.exists(planRel)) {
        try { plan = core.readText(planRel) } catch (e) { planNote = '教案读取失败：' + oneLine(e && e.message) }
      } else {
        planNote = '这一课时还没有教案，批改只能按通用工程规范初筛'
      }
      return {
        ok: true, lesson: lessonNo,
        title: found.lesson.title || ('课时' + lessonNo),
        module: found.mod.name, theme: found.mod.theme || '', range: found.mod.range || '',
        planRel: planRel || '', plan: plan, planNote: planNote, planBytes: Buffer.byteLength(plan, 'utf8'),
        dimensions: (tree && tree.gradingDimensions) || [],
        versions: versionsOf(lessonNo),
        submitDir: core.submitDirOf(STUDENT),
        maxFiles: MAX_SUBMIT_FILES, maxBlobBytes: MAX_BLOB_BYTES, maxTextBytes: MAX_SUB_BYTES,
        allowExt: SUBMIT_EXT,
      }
    },
    /** 一个课时的提交历史（不解教案正文，供刷新用） */
    async 'submission.history'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson) || 0
      if (!lessonNo) throw new Error('缺少课时号')
      return { ok: true, lesson: lessonNo, versions: versionsOf(lessonNo), student: STUDENT }
    },
    /**
     * **全部**提交，按时间倒序。
     *
     * 为什么要它：作业提交不该挂在课时上。学生想看的往往是「我最近交了什么、
     * 哪一版还没批改」，而不是「先选一个课时再看它下面有什么」。
     * 课时脉络是**定位手段之一**（点课时进去看那一课的教案与提交），
     * 不是进入作业区的必经入口。
     *
     * 每一版都带上 lesson/title/module，这样列表里能标出「这是哪一课的」，
     * 也能一键跳到那一课的教案。
     */
    async 'submission.all'() {
      const traces = []
      const tree = await core.getTree(traces)
      const dir = core.submitDirOf(STUDENT)
      // 指纹：提交目录本身 + 每个课时的版本清单。任一变化（新提交、重新批改）
      // 都会让缓存整体失效。刻意不做「逐课时增量」—— 30 个课时的重算远比
      // 一套增量逻辑写错的代价便宜。
      const parts = [statOf(core.abs(dir))]
      for (const e of core.listDir(dir)) {
        if (e.isFile() && /^课时(\d+)\.versions\.json$/.test(e.name)) parts.push(statOf(core.abs(dir + '\\' + e.name)))
      }
      const ok = parts.filter(Boolean)
      const stamp = ok.length
        ? { file: 'suball:' + ok.length, mtime: ok.reduce((a, x) => a + x.mtime, 0), size: ok.reduce((a, x) => a + x.size, 0) }
        : null
      const titleOf = {}
      const moduleOf = {}
      for (const m of (tree && tree.modules) || []) {
        for (const l of m.lessons || []) {
          titleOf[Number(l.no)] = l.title || ('课时' + l.no)
          moduleOf[Number(l.no)] = m.name || ''
        }
      }
      // 课时号从文件名扫：作业提交/<学号>/课时<N>.versions.json。
      // 不额外维护总索引 —— 单一事实来源是磁盘，索引一旦漂移就会「有提交但列表里看不到」。
      const build = async () => {
      const items = []
      for (const e of core.listDir(dir)) {
        if (!e.isFile()) continue
        const m = /^课时(\d+)\.versions\.json$/.exec(e.name)
        if (!m) continue
        const no = Number(m[1])
        for (const v of versionsOf(no)) {
          items.push(Object.assign({}, v, {
            lesson: no, lessonTitle: titleOf[no] || ('课时' + no), module: moduleOf[no] || '',
          }))
        }
      }
      const key = (x) => String(x.at || '') + '#' + String(1000 + (Number(x.v) || 0))
      items.sort((a, b) => key(b).localeCompare(key(a)))
      const ungraded = items.filter((x) => !x.graded).length
      return {
        ok: true, items: items, student: STUDENT,
        counts: {
          versions: items.length, ungraded: ungraded,
          lessons: Object.keys(items.reduce((a, x) => { a[x.lesson] = 1; return a }, {})).length,
        },
        submitDir: dir,
      }
      }
      const out = await cached(core.WORKSPACE, 'submissions-' + safeId(STUDENT), stamp, build, traces)
      // ok/items 等是缓存下来的**纯数据**；traces 不进缓存（它描述的是这一次调用）。
      return Object.assign({}, out, { trace: traces })
    },
    /** 缓存诊断：面板上「为什么数据是旧的 / 缓存有没有生效」看这里 */
    async 'cache.info'() {
      return { ok: true, entries: cacheInfo(), dir: cacheDir(core.WORKSPACE) }
    },
    /** 清掉缓存。加完教案、改完索引之后想立刻生效时用。 */
    async 'cache.clear'() {
      clearCache(core.WORKSPACE)
      return { ok: true, cleared: true }
    },
    async 'submission.list'(args) {
      const lesson = oneLine(args && args.lesson)
      const all = core.listSubmissions()
      const mine = all.filter((s) => s.student === STUDENT)
      return { student: STUDENT, files: mine, lesson, dir: core.submitDirOf(STUDENT) }
    },
    /**
     * 保存一次提交，成为**一个新版本**。
     *
     * 三类内容可以任选组合（这就是「支持文件、文本、图像」的落点）：
     *   text   直接打在输入框里的作答（手推公式的推导、实验结论…）
     *   files  选上来的文件，逐个读成 data URL 原样存盘（.py/.ipynb/.pdf/图片…）
     *   images 拍照/粘贴的图片，同样是 data URL
     * 每次提交都新建 课时<N>/v<版本>/，正文写 <课时>__v<N>.md，附件进 v<N>/_附件/。
     * 旧版本一个字都不动 —— 「改完再传」不该抹掉上一版与上一版的批改。
     */
    async 'submission.save'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson) || 0
      if (!lessonNo) throw new Error('缺少课时号')
      const text = String(input.text || '')
      const textBytes = Buffer.byteLength(text, 'utf8')
      if (textBytes > MAX_SUB_BYTES) throw new Error('文字太长：' + textBytes + ' 字节（上限 ' + MAX_SUB_BYTES + '）')
      const incoming = []
      for (const f of (Array.isArray(input.files) ? input.files : [])) {
        if (!f || typeof f.dataUrl !== 'string') continue
        incoming.push({ name: String(f.name || 'file'), dataUrl: f.dataUrl })
      }
      for (const f of (Array.isArray(input.images) ? input.images : [])) {
        if (!f || typeof f.dataUrl !== 'string') continue
        incoming.push({ name: String(f.name || ('照片-' + (incoming.length + 1) + '.png')), dataUrl: f.dataUrl })
      }
      if (!text.trim() && !incoming.length) throw new Error('这次提交是空的：写点文字，或者选/拍一个文件')
      if (incoming.length > MAX_SUBMIT_FILES) throw new Error('附件太多：' + incoming.length + ' 个（上限 ' + MAX_SUBMIT_FILES + '）')
      for (const f of incoming) {
        if (!submitExtAllowed(f.name)) throw new Error('不允许的文件类型：' + f.name + '（允许 ' + SUBMIT_EXT.join(' ') + '）')
      }

      const versions = core.readVersions(STUDENT, lessonNo)
      const v = versions.reduce((mx, x) => Math.max(mx, Number(x.v) || 0), 0) + 1
      const blobDir = core.submissionBlobDir(STUDENT, lessonNo, v)
      const saved = []
      const zipNotes = []
      for (const f of incoming) {
        const r = core.saveBlobDataUrl(blobDir, f.name, f.dataUrl)
        saved.push({ name: f.name, stored: r.rel.split('\\').pop(), bytes: r.bytes, mediaType: r.mediaType })
        // ── zip：解开，把里面的文本条目**各自存成附件** ──────────────────
        // 为什么必须解：批改是模型逐行读代码，而一个只以二进制存在的 zip
        // 在提示词里就是「一个 3.2 MB 的未知文件」，模型只能给出满篇「无法核验」。
        // 解开之后它们就是普通文本附件，批改那条路（TEXT_EXT）自动认得，
        // 不需要在提示词那一侧加任何特例。
        if (/\.zip$/i.test(f.name)) {
          try {
            const bytes = Buffer.from(String(f.dataUrl).slice(String(f.dataUrl).indexOf(',') + 1), 'base64')
            if (looksLikeZip(bytes)) {
              const ex = extractTextEntries(bytes, { maxFiles: 40, maxOne: 200 * 1024, maxTotal: 600 * 1024 })
              for (const e of ex.files) {
                // 子目录拍平成 `src__model.py`：磁盘上只要「唯一且安全」，
                // 原始路径记在 name 里，面板与批改都按 name 显示。
                const flat = String(e.name).replace(/\//g, '__')
                const r2 = core.saveBlobDataUrl(blobDir, flat, 'data:text/plain;charset=utf-8;base64,'
                  + Buffer.from(e.text, 'utf8').toString('base64'))
                saved.push({
                  name: flat, stored: r2.rel.split('\\').pop(), bytes: r2.bytes,
                  mediaType: 'text/plain', fromZip: f.name, originalPath: e.name,
                })
              }
              zipNotes.push({
                zip: f.name, extracted: ex.files.length, skipped: ex.skipped.length,
                truncated: ex.truncated, skippedWhy: ex.skipped.slice(0, 8),
              })
            } else {
              zipNotes.push({ zip: f.name, extracted: 0, skipped: 0, error: '这个文件不是 zip（开头不是 PK）' })
            }
          } catch (err) {
            // 解不开**不能**让整次提交失败：作业本身已经存下来了，
            // 只是里面的代码这次批改读不到 —— 如实说，让学生知道要换成不压缩的。
            zipNotes.push({ zip: f.name, extracted: 0, skipped: 0, error: oneLine(err && err.message) })
          }
        }
      }
      const rel = core.submitDirOf(STUDENT) + '\\课时' + lessonNo + '__v' + v + '.md'
      core.writeText(rel, text)
      const entry = {
        v: v, at: new Date().toISOString(), kind: '提交',
        textRel: rel, textBytes: textBytes,
        textPreview: text.replace(/\s+/g, ' ').slice(0, 160),
        files: saved, note: oneLine(input.note) || '',
        graded: false,
      }
      if (zipNotes.length) entry.zipNotes = zipNotes
      versions.push(entry)
      core.writeVersions(STUDENT, lessonNo, versions)
      return {
        ok: true, lesson: lessonNo, v: v, rel: rel, files: saved, textBytes: textBytes,
        dir: core.submitDirOf(STUDENT), zipNotes,
      }
    },
    async 'submission.read'(args) {
      const input = args && typeof args === 'object' ? args : {}
      const p = typeof input.path === 'string' ? input.path : ''
      if (!p || !core.exists(p)) throw new Error('提交不存在')
      const text = core.readText(p)
      return { path: p, name: p.split('\\').pop(), text, bytes: Buffer.byteLength(text, 'utf8') }
    },
    /**
     * 按教案批改**指定版本**。教案是**对齐基准**：教案要求手写实现，学生调库绕过，
     * 就必须指出来 —— 这正是老师说的「避免训练的侧重点偏移」。
     * 判出来的问题同时写进学生自己的私有条目，供之后汇总。
     */
    async 'submission.grade'(args) {
      const trace = []
      const input = args && typeof args === 'object' ? args : {}
      const lessonNo = Number(input.lesson) || 0
      if (!lessonNo) throw new Error('缺少课时号')
      let p = typeof input.path === 'string' ? input.path : ''
      let versions = core.readVersions(STUDENT, lessonNo)
      let entry = null
      const wantV = Number(input.v) || 0
      if (wantV) entry = versions.find((x) => Number(x.v) === wantV) || null
      // 不指定版本就批最新一版。「批改」是按版本进行的 —— 否则改完再传之后
      // 分不清这次的结论对应哪一份作业，「历史回溯」也就无从谈起。
      if (!entry && versions.length) entry = versions.reduce((a, b) => (Number(a.v) >= Number(b.v) ? a : b))
      if (entry && entry.textRel) p = entry.textRel
      if (!p || !core.exists(p)) throw new Error('还没有可批改的提交，请先提交一次')
      const text = core.readText(p)
      // ⚠️ 版本清单里只记了附件的名字与字节数，**没有 rel**（那是 listVersionFiles
      //    现算的）。而下面要给模型读图片，读的是 rel —— 不在这里补上，
      //    照片会被静默跳过，症状是「模型说看不到图」，而日志显示一切正常。
      const onDisk = core.listVersionFiles(STUDENT, lessonNo, entry ? entry.v : 0)
      const byName = {}
      onDisk.forEach((f) => { byName[f.name] = f })
      const files = ((entry && entry.files) || []).map((f) => {
        const hit = byName[f.stored || f.name] || byName[f.name]
        return Object.assign({}, f, hit ? { rel: hit.rel, bytes: hit.bytes } : {})
      })
      /**
       * ── 把**文本附件的内容**读出来 ────────────────────────────────────
       *
       * 这是「按理说应该去批改代码啊」那条反馈的根因：
       *   原来只把附件的**元信息**（名字 + 类型 + 字节数）发给模型，
       *   于是它明确说「这一行代码我都看不到」，然后给出一串「无法核验」。
       *   而 .py / .md / .ipynb / .json / .csv 都是**纯文本**，读出来就是代码本身。
       *
       * 容量上限是必要的（一次提交可能带好几个大文件），但**不静默截断**：
       * 截了就在提示词里说清「已截断到前 N 字符」，否则模型会以为看到的是全文，
       * 然后基于不完整的证据说「缺少 XXX」。
       */
      const TEXT_EXT = /\.(py|pyw|ipynb|md|markdown|txt|log|json|ya?ml|csv|tsv|tex|r|m|c|h|cpp|cc|js|mjs|ts|tsx|jsx|java|go|rs|sql|sh|ps1|bat|ini|cfg|toml|htm|html|xml)$/i
      const PER_FILE = 30 * 1024
      const TOTAL_TEXT = 80 * 1024
      const textFiles = []
      const skipped = []
      let used = 0
      for (const f of files) {
        const nm = String(f.stored || f.name || '')
        if (!TEXT_EXT.test(nm)) {
          skipped.push({ name: f.name, why: /\.(png|jpe?g|webp|gif)$/i.test(nm) ? '图片（已作为图片发给模型）' : '二进制（内容读不出来）' })
          continue
        }
        if (!f.rel || !core.exists(f.rel)) { skipped.push({ name: f.name, why: '文件不在磁盘上' }); continue }
        if (used >= TOTAL_TEXT) { skipped.push({ name: f.name, why: '累计文本已达上限 ' + Math.round(TOTAL_TEXT / 1024) + ' KB' }); continue }
        try {
          const raw = core.readText(f.rel)
          const room = Math.min(PER_FILE, TOTAL_TEXT - used)
          const cut = raw.length > room
          const body = cut ? raw.slice(0, room) : raw
          used += body.length
          textFiles.push({ name: f.name, chars: raw.length, truncated: cut, text: body })
        } catch (e) { skipped.push({ name: f.name, why: '读取失败：' + oneLine(e && e.message) }) }
      }
      trace.push('随批改发送的文本附件: ' + textFiles.length + ' 个（共 ' + used + ' 字符）'
        + (skipped.length ? (' · 未读: ' + skipped.map((x) => x.name + '(' + x.why + ')').join('、')) : ''))
      const planRel = await core.planPathFor(lessonNo)
      const plan = planRel && core.exists(planRel) ? core.readText(planRel) : ''
      trace.push(planRel ? ('教案: ' + planRel) : '未找到该课时教案（只能做通用初筛）')
      trace.push('版本: v' + (entry ? entry.v : '?') + ' · 文字 ' + Buffer.byteLength(text, 'utf8') + ' 字节 · 附件 ' + files.length + ' 个')
      const tree = await core.getTree()
      const dims = (tree && tree.gradingDimensions) || []
      const mchoice = resolveChoice(readModelChoice(), await listModelCatalog(ctx))
      // 把照片**真的**读出来发给模型：学生拍的手推公式往往就是这次提交的主体，
      // 只把文件名告诉模型等于让他对着空气批改。
      const images = []
      const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i
      const mimeOf = (nm) => (/\.png$/i.test(nm) ? 'image/png' : (/\.jpe?g$/i.test(nm) ? 'image/jpeg'
        : (/\.webp$/i.test(nm) ? 'image/webp' : (/\.gif$/i.test(nm) ? 'image/gif' : 'application/octet-stream'))))
      for (const f of files) {
        if (images.length >= 4) break
        const isImg = /^image\//i.test(String(f.mediaType || '')) || IMG_EXT.test(String(f.name || f.stored || ''))
        if (!isImg || !f.rel || !core.exists(f.rel)) continue
        try {
          images.push('data:' + mimeOf(f.stored || f.name || '') + ';base64,' + core.readText(f.rel, 'base64'))
        } catch (e) { trace.push('读取照片失败 ' + f.name + '：' + oneLine(e && e.message)) }
      }
      trace.push('随批改发送的图片: ' + images.length + ' 张')
      const r = await runGrade(ctx, {
        plan: plan, code: text, dimensions: dims, lesson: '课时' + lessonNo,
        files: files, textFiles: textFiles, skippedFiles: skipped,
        images: images, trace, choice: mchoice,
      })
      const issues = parseIssueList(r.text)

      // 把问题清单逐条落成私有条目。**默认不公开**，由学生自己决定公开哪几条。
      const saved = []
      if (issues.length) {
        const base = await core.nextId()
        for (let i = 0; i < issues.length; i += 1) {
          const f = {
            id: pad4(Number(base) + i), title: issues[i].text.slice(0, 60),
            summary: '来自课时 ' + lessonNo + ' 的作业批改（v' + (entry ? entry.v : 1) + '）：' + issues[i].text,
            source: '作业', module: pickEnum(input.module, MODULES, '模块一'),
            lesson: '课时' + lessonNo, type: '作业疑问', severity: issues[i].severity,
            status: '待处理', created: today(), updated: today(),
            reporter: '学生（' + STUDENT + '）', student: STUDENT,
            related_files: [p].concat(files.map((x) => x.name)), ai: '已作答', tokens: usageField(r.usage),
            /**
             * ⚠️ 默认 **not_shared**。
             *
             * 一次批改会判出十几条问题（实测 9~11 条），原来把它们全部按「已作答」
             * 直接落进教师看得见的地方 —— 老师那边会瞬间堆到 76 条，根本看不过来，
             * 而且大部分是同一份代码的细枝末节。
             *
             * 现在决定权归学生：这些问题先只留在他自己这里，他在「我的提问」里
             * 逐条或批量选择公开哪些。教师端默认只看学生公开过的
             * （见教师端 threads 的 onlyShared）。
             */
            audit: 'not_shared',
          }
          const rel = await createItem(f, {
            '原始提问': '课时 ' + lessonNo + ' 作业（v' + (entry ? entry.v : 1) + '）：' + issues[i].text
              + '\n\n提交正文：' + p
              + (files.length ? ('\n附件：' + files.map((x) => x.name).join('、')) : ''),
            '现象': '该问题由 AI 按教案初筛得出，证据见批改正文。',
            '初步判断': issues[i].text,
            'AI 答复': '（见批改正文）',
          }, [])
          saved.push({ path: rel, severity: issues[i].severity, text: issues[i].text, shared: false })
        }
      }
      // 把结论写回版本清单：历史回溯靠它，不靠重新解析 markdown
      if (entry) {
        entry.graded = true
        entry.gradedAt = new Date().toISOString()
        entry.planRel = planRel || ''
        entry.model = (mchoice ? (mchoice.provider + '/' + mchoice.model) : '')
        entry.tokens = usageField(r.usage)
        entry.issues = saved.map((x) => ({ severity: x.severity, text: x.text, path: x.path, shared: false }))
        versions = versions.map((x) => (Number(x.v) === Number(entry.v) ? entry : x))
        core.writeVersions(STUDENT, lessonNo, versions)
        // 批改正文也留一份，供历史里回看（正文很长，不适合塞进清单 JSON）
        core.writeText(core.submissionVersionDir(STUDENT, lessonNo, entry.v) + '\\批改.md',
          '# 课时 ' + lessonNo + ' · v' + entry.v + ' 批改\n\n'
          + '- 教案基准：' + (planRel || '未找到') + '\n'
          + '- 模型：' + (mchoice ? (mchoice.provider + '/' + mchoice.model) : '会话默认') + '\n'
          + '- ' + usageField(r.usage) + '\n\n' + r.text + '\n')
      }
      return { ok: true, path: p, lesson: lessonNo, v: entry ? entry.v : 0, planRel, text: r.text, issues: saved, usage: r.usage, trace, model: entry ? entry.model : '' }
    },
  }

  core.registerApi(handlers)
  core.mount()
  console.log('[' + LABEL + '] 就绪 v0.1.0 · 学生=' + STUDENT + ' · 工作区=' + core.WORKSPACE + '（' + core.WS.how + '）· 前缀 ' + PREFIX)
}

export default { name, inject, apply }

/**
 * 一条条目的路径**归谁** —— 全端唯一的判定。
 *
 * 为什么要收成一个函数（端侧实测 + 静态审查共同发现的）：
 *   原来三处各写各的字符串比较，口径互不一致，而且**都有真漏洞**：
 *
 *   | 位置 | 原来的判据 | 问题 |
 *   | --- | --- | --- |
 *   | `isMine`（提问列表） | `p.indexOf('\\' + STUDENT + '\\') >= 0` | `S001` 会命中 `S0011\` —— 别人的条目被算成自己的 |
 *   | `thread` | `p.indexOf('\\' + STUDENT + '\\') < 0` | 同上；`path` 里的 `..` 也没拦 |
 *   | `followup` | `p.indexOf(STUDENT_ITEMS_REL) !== 0` 才进守卫 | **对自己目录永远为假 → 整个守卫是死代码**，任何本机进程都能给已公开条目追加内容 |
 *
 * 现在一律走「解析成绝对路径 → `path.relative` 看是否逃出根目录」，
 * 与 `core` 里 `serveFileUnder` 已经写对的那套一致（注释里明确写了
 * `startsWith` 会把 `C:\a\bc` 当成 `C:\a\b` 的子路径，所以不能用前缀比较）。
 *
 * ⚠️ `课程问题池\公共` 在 `课程问题池\学生` 的**兄弟**位置，但两者都以
 *    `课程问题池\` 开头 —— 判断顺序必须是**先公共、后学生**，否则公开条目会被判成自己的。
 *
 * @param {string} p 条目相对路径（来自客户端）
 * @param {{abs:Function, PUBLIC_ITEMS_REL:string, STUDENT_ITEMS_REL:string}} core
 * @param {string} student 当前学生标识
 * @returns {'public'|'mine'|'other-student'|'legacy'|'outside'}
 */
export function ownPathScope(p, core, student) {
  if (typeof p !== 'string' || !p) return 'outside'
  // ⚠️ **先拦 `..`**，再论归属。
  //
  // 为什么必须先拦：`path.join` 会把 `..` 吃掉，于是
  //     `课程问题池\学生\..\..\..\Windows\win.ini`
  // 解析后落到工作区**外面**，而它仍然以「课程问题池\」开头 —— 归属判断会继续往下走，
  // 最后掉进 `legacy` 分支，而 `legacy` 在 `thread` / `followup` 里是**放行**的。
  // 实测就是这么漏的（写这条用例时断言只写了「不是 mine」，太松，没抓住）。
  //
  // 判据：把 `\` 归一成 `/` 后，任何一段是 `..` 就拒绝。这样也顺带挡住 URL 编码
  // （`..%2f`）在解码后变成 `../` 的形态。
  if (String(p).replace(/\\/g, '/').split('/').indexOf('..') >= 0) return 'outside'
  // 解析后仍必须落在工作区里；`..` 之外再兜一层（防符号链接之类的意外）
  const full = path.resolve(core.abs(p))
  const under = (rel) => {
    const root = path.resolve(core.abs(rel))
    const r = path.relative(root, full)
    // '' = 就是根本身；不以 .. 开头且不是绝对路径 = 在根目录内
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
  }
  if (p === core.PUBLIC_ITEMS_REL || under(core.PUBLIC_ITEMS_REL)) return 'public'
  if (under(core.STUDENT_ITEMS_REL)) {
    const mine = path.resolve(core.abs(core.STUDENT_ITEMS_REL + '\\' + student))
    const r = path.relative(mine, full)
    return (r === '' || (!r.startsWith('..') && !path.isAbsolute(r))) ? 'mine' : 'other-student'
  }
  return 'legacy'
}

/**
 * 把一次失败的 `git pull` 归类成「学生能照做」的提示。**必须放在模块级**：
 * `apply()` 建了一个很大的 handlers 对象，在里面插一个 40 行的纯函数会把它切碎。
 *
 * 为什么要归类（端侧实测踩到）：原来无论什么原因，返回的都是同一句
 *     「拉取失败（可能是本地有未提交的改动，或历史分叉）」
 * 而实测那次真实原因是**连不上 github**（`Recv failure: Connection was reset`）。
 * 学生照提示去 `git status`，会发现工作区很干净，然后彻底卡住 —— 归因错了等于没提示。
 *
 * ⚠️ 更要紧的是原句 hint 建议 `git checkout -- .`。这条**有破坏性**：它会丢弃工作区改动。
 *    而当时 `.gitignore` 正好漏了学生的提问目录，那些提问是未跟踪状态，
 *    照这条建议操作存在**真丢数据**的风险。
 *    凡「让用户丢弃本地内容」的建议，都必须说清会丢什么、并要求先备份。
 *
 * @param {string} detail git 的原始输出
 * @returns {{error:string, hint:string}}
 */
export function classifySyncFailure(detail) {
  const d = String(detail || '')
  // 顺序有讲究：**先判「根本没连上」，再判「连上了但合不了」**。
  // 反过来的话，`unable to access` 这类会被后面更具体的规则抢先匹配掉。
  if (/Could not resolve host|Connection was reset|Could not connect|Connection timed out|Failed to connect|SSL|TLS|schannel|SEC_E_|proxy|unable to access/i.test(d)) {
    return {
      error: '拉取失败：连不上 GitHub（不是你操作错了）',
      hint: '这台机器访问不到 github.com。常见两因：'
        + '① git 配了代理但代理软件没开（查 `git config --get http.proxy`，再看那个端口有没有在监听）；'
        + '② 网络本身不通。'
        + '网络恢复后再点一次即可 —— **不需要动你的任何文件，也不要删东西**。',
    }
  }
  if (/not a git repository/i.test(d)) {
    return {
      error: '拉取失败：工作区不是 git 仓库',
      hint: '这个目录里没有 .git。如果你是把课程资料拷过来的、而不是 clone 的，就没有「拉取更新」这条路；重新 clone 一份即可。',
    }
  }
  if (/no such remote|No remote repository specified|does not appear to be a git repository/i.test(d)) {
    return {
      error: '拉取失败：仓库没有配远端地址',
      hint: '在这个工作区里执行 `git remote -v` 看看。没有 origin 的话把课程仓地址加回去：`git remote add origin <课程仓地址>`。',
    }
  }
  if (/Your local changes|local changes to the following files would be overwritten|Please commit your changes|unstaged changes/i.test(d)) {
    return {
      error: '拉取失败：你有本地改动，会和远端新内容冲突',
      hint: '⚠️ **不要**用 `git checkout -- .` —— 那会丢弃你的改动。先看清楚改了什么：'
        + '在这个工作区里跑 `git status` 与 `git diff`；'
        + '确认那些改动不需要的话，**先备份**（复制到仓库外面），再决定是否丢弃。'
        + '你自己的提问与作业本该被 .gitignore 忽略、不出现在这个列表里；'
        + '**如果它们出现在列表里，先别动** —— 那是忽略规则没生效，先联系老师。',
    }
  }
  if (/divergent branches|have diverged|Not possible to fast-forward|non-fast-forward/i.test(d)) {
    return {
      error: '拉取失败：本地与远端历史分叉',
      hint: '说明这个仓库被本地改过并提交过。把 `git status` 与 `git log --oneline -5` 的输出发给老师，**不要自行 merge 或 reset**。',
    }
  }
  return {
    error: '拉取失败（原因未能自动识别）',
    hint: '把下面 detail 里的原文发给老师。**在做任何 git 操作前先备份**，不要按笼统建议直接丢弃改动。',
  }
}

