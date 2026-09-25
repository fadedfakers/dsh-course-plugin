/**
 * dsh-course-teacher —— 教师端客户端半区
 *
 * 教师端的职责是「整理与判断」，不是「花钱」：
 *   · 看全部学生的提问与提交（学生端只看得到自己的 + 已公开的）
 *   · 审计：值得共享 → 进公共池；只答本人 → 留在该学生私有目录
 *   · 共性问题汇总：判据是**几个不同学生**踩到，不是一个人问了几次
 *   · 归档与待发布：公共面里有什么，publish 会带进公开仓
 *
 * 这一侧不调用模型 —— 所以界面上没有「AI 作答中」这类状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-course-teacher',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const PANEL_ID = 'course-teacher'
    const API = '/cip-tea-api'
    const MEDIA = '/cip-tea-media'
    /**
     * 教案的五节。**与宿主 core/plan.js 的 PLAN_SECTIONS 同名同序** ——
     * 客户端也留一份是为了在编辑时**即时**标出「这一节还空着」，
     * 不必每敲一个字就回一次服务器。顺序错了会让下面的解析失配，改的时候一起改。
     */
    const PLAN_SECTION_NAMES = ['目标', '推导', '实操', '验收标准', '当堂交付物']

    /**
     * 压成一行。宿主侧有同名工具（core 的 oneLine），客户端没有 ——
     * 在客户端用它会直接 ReferenceError，而这个错只在**渲染到那一处时**才炸
     * （本次就是这么发现的：课件窗口一展开就白，别处全好）。
     * 所以客户端自带一个，别去借宿主的。
     */
    function oneLine(v) {
      return String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
    }

    /** 本地判空：某一节是否存在**有内容的**正文。空节 = 只有编号或只有空白。 */
    function missingSectionsOf(md) {
      const text = String(md || '')
      const out = []
      for (let i = 0; i < PLAN_SECTION_NAMES.length; i += 1) {
        const nm = PLAN_SECTION_NAMES[i]
        const re = new RegExp('^##\\s*' + nm + '\\s*$', 'm')
        const m = re.exec(text)
        if (!m) { out.push(nm); continue }
        const rest = text.slice(m.index + m[0].length)
        const next = /^##\s+\S/m.exec(rest)
        const body = (next ? rest.slice(0, next.index) : rest).trim()
        // 去掉开头的编号/项目符号后还有没有字 —— 「## 验收标准\n\n1. 」算空
        if (!body.replace(/^[\s\d.、)（(]+/, '').trim()) out.push(nm)
      }
      return out
    }

    /** 打开草稿时把它滚进视野。生成完视线还在课时卡片上，不滚就等于没预览。 */
    function scrollToDraft() {
      if (typeof document === 'undefined' || !document.getElementById) return
      // 等一下再滚：这一刻元素还没挂上去（setState 是异步的）
      setTimeout(() => {
        const el = document.getElementById('cip-plan-draft')
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }, 60)
    }

    // 见学生端的同段注释：本面板自己的路径**不能**写进共享内核，
    // 那是个全页唯一的模块，谁先加载就把谁的前缀固化 —— 教师面板会因此
    // 去请求 /cip-stu-api，满屏「未知动作」。
    const CFG = {
      css: '/cip-tea.css', cssId: 'cip-tea-css',
      katex: '/cip-tea-katex', media: MEDIA,
    }

    const ui = require('dsh-course-client-core')
    const {
      ensureCss, css, h, bdg, Markdown, loadKatex, Fishbone, MediaImage,
      STATUS_COLOR, SEVERITY_COLOR, ZOOM_MIN, ZOOM_MAX,
      // 文件提交 / 预览共用组件 —— 与学生端 require 到的是**同一份代码**。
      // 「两端风格统一」落在这里：同一件事用同一个组件，而不是把样式调得像。
      // cropToPng：框选成图。老师圈 PPT 内容当改稿依据时用它 ——
      // ⚠️ 它必须在这里**显式解构**出来。漏了不会报错、构建也全绿，
      //    只在老师真的拖完一个框时才炸（`cropToPng is not defined`），
      //    而那时他已经对着 PPT 划了一下、以为成功了。踩过一次。
      FileDrop, FileList, PreviewBox, cropToPng,
    } = ui

    async function api(action, args) {
      const res = await fetch(API + '/' + encodeURIComponent(action), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      })
      let data = null
      try { data = await res.json() } catch (e) { data = null }
      // 「未知动作」只有一个成因：**宿主半区没重启**。改成一句能照着做的话。
      if (data && typeof data.error === 'string' && data.error.indexOf('未知动作') === 0) {
        throw new Error(data.error + ' —— 宿主半区没重启。改完宿主代码要重启 DSH（只刷新浏览器不够）。')
      }
      if (data && data.error) throw new Error(data.error)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return data
    }

    // 教师端图标：文件夹 + 勾，和学生的对话气泡区分开
    function TeaIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4l1.6 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M8.5 13.2l2.2 2.2 4.4-4.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    // ── 审计：改状态、改标题/总结、写归档说明 ──
    function AuditBox({ st, set, onAudit, onAnswer }) {
      const t = st.thread
      if (!t) return null
      const isPublic = t.fields.audit === 'shared'
      const turns = t.turns || []
      const teacherTurns = turns.filter((x) => x.by === 'teacher')
      return h('div', { className: 'kc9' },
        // 答复与去向分开两段：答复是内容，审计是去向。
        // 混在一起会出现「为了答复学生而不得不先决定是否公开」这种别扭流程。
        h('div', { className: 'k64' }, '答复这个学生'),
        teacherTurns.length
          ? h('div', { className: 'k57' }, '你已经答过 ' + teacherTurns.length + ' 次；学生端会在最前面单独显示教师答复。')
          : h('div', { className: 'k57' }, '还没有教师答复。学生端会把教师答复与 AI 答复**分开显示** —— 两者的可信度不是一个级别，界面上不能混为一谈。'),
        h('textarea', { className: 'k59', rows: 3, value: st.answerText, placeholder: '写给学生看的回答（可以只答复、暂不决定是否公开）', onChange: (e) => set({ answerText: e.target.value }) }),
        h('div', { className: 'kca' },
          h('button', { className: 'k42 k11', disabled: st.busy || !(st.answerText || '').trim(), onClick: () => onAnswer(t.path, st.answerText) },
            st.busy ? '提交中…' : '答复（只发给该学生）'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k57' }, '答复会追加进这条提问的对话线程；如果它已经公开，公共面那份会同步更新，否则两边内容会不一致。')),

        h('div', { className: 'k64' }, '审计去向'),
        h('div', { className: 'k57' }, isPublic
          ? '当前：已公开给全班（公共面里有副本）'
          : '当前：仅该学生可见'),
        h('div', { className: 'kca' },
          h('input', { className: 'k61', style: { flex: '1 1 auto' }, value: st.auditTitle, placeholder: '标题（留空则不改；这是统一风格的最后一关，你可以覆盖模型凝练的结果）', onChange: (e) => set({ auditTitle: e.target.value }) }),
          ),
        h('textarea', { className: 'k59', rows: 2, value: st.auditSummary, placeholder: '问题总结（留空则不改）', onChange: (e) => set({ auditSummary: e.target.value }) }),
        h('textarea', { className: 'k59', rows: 2, value: st.auditNote, placeholder: '归档说明（例如：讲课时补一句「负特征值是鞍点的充分判据」）', onChange: (e) => set({ auditNote: e.target.value }) }),
        h('div', { className: 'kca' },
          h('button', { className: 'k42 k11', onClick: () => onAudit(t.path, 'shared') }, '值得共享（进公共池）'),
          h('button', { className: 'k42', onClick: () => onAudit(t.path, 'private') }, isPublic ? '撤下（只答本人）' : '只答本人'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k57' }, '「值得共享」会写一份副本到 课程问题池\\公共\\，下次 publish 带给全班；原条仍留在该学生的私有目录里，他的历史不会消失。')))
    }

    function ThreadDetail({ st, set, onAudit, onAnswer }) {
      const t = st.thread
      if (!t) return h('div', { className: 'k21' }, '从左边选一条提问。')
      return h('div', { className: 'k46' },
        h('div', { className: 'k10' }, t.fields.title || '(无标题)'),
        h('div', { className: 'k70' },
          bdg((t.fields.who && t.fields.who.label) || t.fields.student || '未标注学生', 'var(--dsw-alias-brand-primary)'),
          bdg(t.fields.lesson || '未标注', 'var(--dsw-alias-bg-layer-1)'),
          bdg(t.fields.severity || '中', SEVERITY_COLOR[t.fields.severity] || 'gray'),
          bdg(t.fields.status || '', STATUS_COLOR[t.fields.status] || 'gray'),
          t.fields.audit === 'shared' ? bdg('已公开', 'var(--dsw-alias-state-success-primary)') : bdg('私有', 'var(--dsw-alias-label-secondary)'),
          t.fields.tokens ? h('span', { className: 'k57' }, '该生消耗 tokens ' + t.fields.tokens) : null),
        t.fields.summary ? h('div', { className: 'k58' }, '总结：' + t.fields.summary) : null,
        h('div', { className: 'k57' }, '路径：' + t.path),
        h('div', { className: 'k64' }, '完整问答（' + ((t.turns || []).length + 1) + ' 轮，全班可见的是这一份）'),
        h(Markdown, { text: t.body || '' }),
        h(AuditBox, { st, set, onAudit, onAnswer }))
    }

    // ── 提问列表（可筛：学生 / 去向 / 知识领域）──
    function QuestionList({ st, set, onOpen, onToggleAll }) {
      const items = st.items || []
      // 领域词表从宿主下发（受控词表），不在这里硬编码，避免两边漂移
      const topics = (st.info && st.info.defaults && st.info.defaults.topics) || []
      const filtered = items.filter((it) => {
        if (st.filterStudent && it.student !== st.filterStudent) return false
        if (st.filterScope === 'private' && it.audit === 'shared') return false
        if (st.filterScope === 'shared' && it.audit !== 'shared') return false
        if (st.filterTopic && (it.topic || '其他') !== st.filterTopic) return false
        return true
      })
      // 各领域的条数：让老师一眼看出「问题集中在哪」——这是分类最主要的用处
      const counts = {}
      for (const it of items) { const k = it.topic || '未分类'; counts[k] = (counts[k] || 0) + 1 }
      const countLabel = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
        .map((k) => k + '(' + counts[k] + ')').join(' · ')
      return h('div', { className: 'k67' },
        h('div', { className: 'kca' },
          h('select', { className: 'kcc', value: st.filterStudent, onChange: (e) => set({ filterStudent: e.target.value }) },
            [h('option', { key: '', value: '' }, '全部学生')].concat((st.students || []).map((s) => h('option', { key: s, value: s }, s)))),
          h('select', { className: 'kcc', value: st.filterScope, onChange: (e) => set({ filterScope: e.target.value }) },
            h('option', { key: 'all', value: 'all' }, '全部'),
            h('option', { key: 'private', value: 'private' }, '仅私有（待审计）'),
            h('option', { key: 'shared', value: 'shared' }, '已公开')),
          h('select', { className: 'kcc', value: st.filterTopic, onChange: (e) => set({ filterTopic: e.target.value }) },
            [h('option', { key: '', value: '' }, '全部领域')].concat(
              topics.map((t) => h('option', { key: t, value: t }, t + (counts[t] ? (' (' + counts[t] + ')') : ''))))),
          // 默认只看**学生主动公开过**的条目：批改一次出十几条，全量涌进来老师看不过来。
          // 这个开关是给「排查某个学生是不是卡住了」用的审计视图，默认关闭。
          h('span', {
            className: 'k43', 'data-on': st.showAll === true ? '1' : '0',
            title: '学生未公开的条目默认不显示（批改会自动生成很多，全量会淹没你）。打开这里可以审计全部。',
            onClick: () => onToggleAll(),
          }, st.showAll === true ? '全部条目（含未公开）' : '只看已公开'),
          h('span', { className: 'k57' }, filtered.length + ' / ' + items.length + ' 条'
            + (st.hiddenCount ? ('（另有 ' + st.hiddenCount + ' 条学生未公开）') : ''))),
        h('div', { className: 'k57', style: { padding: '0 4px 4px' } }, '领域分布：' + (countLabel || '（暂无分类）')),
        filtered.length ? filtered.map((it) => h('div', {
          key: it.path, className: 'kd9', 'data-sel': st.selPath === it.path ? '1' : '0',
          onClick: () => onOpen(it.path),
        },
          h('div', { className: 'k64', style: { margin: 0 } }, it.title),
          h('div', { className: 'k70' },
            bdg((it.who && it.who.label) || it.student || '?', 'var(--dsw-alias-brand-primary)'),
            it.topic ? bdg(it.topic, 'var(--dsw-alias-bg-layer-1)') : null,
            bdg(it.lesson || '未标注', 'var(--dsw-alias-bg-layer-1)'),
            bdg(it.severity || '中', SEVERITY_COLOR[it.severity] || 'gray'),
            it.audit === 'shared' ? bdg('已公开', 'var(--dsw-alias-state-success-primary)') : null,
            it.turns ? bdg(it.turns + ' 轮', 'var(--dsw-alias-bg-layer-1)') : null),
          it.concept ? h('div', { className: 'k57' }, '概念：' + it.concept) : null)) : h('div', { className: 'k21' }, '没有符合条件的提问'))
    }

    // ── 共性问题：判据是「几个不同学生」 ──
    function Common({ st, set, onBatch }) {
      const groups = st.common || []
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '共性问题汇总'),
        h('div', { className: 'k57' }, '判据是**几个不同学生**踩到，不是一个学生问了几次：一个人反复问同一件事，那是他自己的困惑；三个人各问一次，那才是教案或讲法的问题。'),
        h('div', { className: 'kca' },
          h('span', { className: 'k57' }, '门槛：'),
          h('select', { className: 'kcc', value: String(st.minStudents), onChange: (e) => set({ minStudents: e.target.value }) },
            h('option', { key: '1', value: '1' }, '≥1 个学生'),
            h('option', { key: '2', value: '2' }, '≥2 个学生'),
            h('option', { key: '3', value: '3' }, '≥3 个学生'))),
        groups.length ? groups.map((g, i) => h('div', { key: i, className: 'kc7' },
          h('div', { className: 'k70' },
            bdg(g.studentCount + ' 人踩到', g.studentCount >= 2 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'),
            bdg(g.lesson, 'var(--dsw-alias-bg-layer-1)'),
            g.maxSeverity ? bdg('最高 ' + g.maxSeverity, SEVERITY_COLOR[g.maxSeverity] || 'gray') : null,
            bdg(g.count + ' 条', 'var(--dsw-alias-bg-layer-1)'),
            g.alreadyShared ? bdg('已有公开副本', 'var(--dsw-alias-state-success-primary)') : null),
          h('div', { className: 'k64', style: { margin: '4px 0' } }, g.sample || '(无标题)'),
          h('div', { className: 'k57' }, '涉及学生：' + (g.students || []).join('、')),
          h('div', { className: 'kca' },
            h('button', { className: 'k42 k11', disabled: g.alreadyShared, onClick: () => onBatch(g.paths, 'shared') }, '这一组都标为值得共享'),
            h('button', { className: 'k42', onClick: () => onBatch(g.paths, 'private') }, '这一组都标为只答本人'),
            h('span', { className: 'k54' }),
            h('span', { className: 'k57' }, '沉淀去向建议：' + (g.studentCount >= 3 ? '写进 FAQ，并考虑改教案' : '先只答本人，观察是否扩散')))))
          : h('div', { className: 'k21' }, '还没有足够数据形成共性问题'))
    }

    // ── 学生提交 ──
    function Submissions({ st, set, onRead }) {
      const files = st.subs || []
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '学生提交（' + files.length + '）'),
        h('div', { className: 'kca' },
          h('select', { className: 'kcc', value: st.subStudent, onChange: (e) => set({ subStudent: e.target.value }) },
            [h('option', { key: '', value: '' }, '全部学生')].concat((st.subStudents || []).map((s, i) => h('option', { key: s, value: s }, (st.subLabels && st.subLabels[i]) || s))))),
        files.length ? files.map((f) => h('div', { key: f.path, className: 'kd9', onClick: () => onRead(f.path) },
          h('span', { className: 'k64', style: { margin: 0 } }, f.name),
          h('span', { className: 'k57' }, ' ' + ((f.who && f.who.label) || f.student || '') + ' · ' + Math.round((f.bytes || 0) / 1024) + ' KB'))) : h('div', { className: 'k21' }, '还没有提交'),
        st.subText ? h('div', { className: 'k46' },
          h('div', { className: 'k64' }, st.subName),
          h('pre', { className: 'k63', style: { maxHeight: '360px', overflow: 'auto' } }, st.subText)) : null)
    }

    // ── 课堂记录汇总（归档用）──
    function Digest({ st }) {
      const d = st.digest
      if (!d) return h('div', { className: 'k21' }, '汇总加载中…')
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '课堂记录汇总'),
        h('div', { className: 'k57' }, '生成于 ' + (d.generatedAt || '') + '。按课时统计提问，可用于课后改教案或写答疑课提纲。'),
        (d.lessons || []).map((l) => h('div', { key: l.lesson, className: 'kc7' },
          h('div', { className: 'k70' },
            bdg(l.lesson, 'var(--dsw-alias-brand-primary)'),
            bdg(l.total + ' 条', 'var(--dsw-alias-bg-layer-1)'),
            bdg(l.students + ' 名学生', 'var(--dsw-alias-bg-layer-1)'),
            l.shared ? bdg(l.shared + ' 条已公开', 'var(--dsw-alias-state-success-primary)') : null),
          h('div', { className: 'k57' }, '类型：' + Object.keys(l.byType).map((k) => k + '(' + l.byType[k] + ')').join(' · ')),
          h('div', { className: 'k57' }, '严重度：' + Object.keys(l.bySeverity).map((k) => k + '(' + l.bySeverity[k] + ')').join(' · ')),
          (l.titles || []).slice(0, 12).map((t, i) => h('div', { key: i, className: 'k57' }, '· #' + t.id + ' ' + t.title + (t.student ? ('（' + t.student + '）') : ''))))))
    }

    // ── 发布：仓库状态 ──
    /**
     * ① 仓库状态卡。
     *
     * 老师打开「归档发布」时，第一个问题是「我发出去的东西，学生拿到了吗」。
     * 回答它只需要一句人话 —— 而那句人话是**宿主算好的**（repoSummary().text），
     * 不是这一层拿原始状态拼的。
     *
     * ⚠️ 这里**不显示** `ahead 3` / `hasRepo: true` / `remoteSafe` 这类术语。
     *    这一页是给不懂 git 的老师看的：界面上出现术语，等于把「现在能不能发出去」
     *    这个判断又推回给他。原始字段仍然下发（按钮要依据它），但不上屏。
     */
    function RepoStatusCard({ st, onRefreshStatus }) {
      const rs = st.repoStatus
      const pub = (rs && rs.publicRepo) || null
      const priv = (rs && rs.privateRepo) || null
      const sum = (pub && pub.summary) || null
      return h('div', { className: 'kcb' },
        h('div', { className: 'k64' }, '① 仓库状态'),
        sum ? h('div', { className: 'kd1' }, sum.text)
          : h('div', { className: 'k21' }, rs ? '仓库状态读不出来（多半是宿主半区没重启）' : '正在读仓库状态…'),
        pub ? h('div', { className: 'kce' },
          bdg(pub.hasRepo ? '本机已有仓库' : '本机还没有仓库',
            pub.hasRepo ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'),
          bdg(pub.remote ? '已连到 GitHub' : '还没连到 GitHub',
            pub.remote ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'),
          bdg(rs && rs.manifestReady ? '发布清单已生成' : '还没有发布清单',
            rs && rs.manifestReady ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-state-warn-primary)')) : null,
        priv && priv.summary ? h('div', { className: 'k57' }, '课程工作区（私有仓）：' + priv.summary.text) : null,
        h('div', { className: 'k57' }, '公开仓工作区：' + ((rs && rs.publicDir) || '课程发布\\public')),
        h('div', { className: 'kca' },
          h('button', { className: 'k42', disabled: st.busy, onClick: () => onRefreshStatus() }, '重新读一次')))
    }

    // ── 发布：建仓 ──
    /**
     * ② 建仓卡。这一块刻意把「谁做哪一步」写在脸上：
     *   · 本机这两步（git init / git remote add）—— 插件替他做，命令与输出都摊开给他看
     *   · GitHub 上那两个空仓 —— 他自己建（建仓要走 GitHub 的接口，接口要凭据，
     *     而插件里不放任何人的密钥；这条口径整门课都不破）
     *
     * Token 框是 password，而且**只在本机内存里过一趟**：它唯一的作用是现拼一条
     * 带凭据的 push 命令给他照抄。**绝不写进 .git/config** —— 那个文件会跟着仓库
     * 被复制走（拷目录、打包发人、被发布工具扫进公开仓），写进去等于把钥匙一起发出去。
     */
    function RepoCreateCard({ st, set, onInit }) {
      const f = st.repoForm || {}
      const patch = (o) => set({ repoForm: Object.assign({}, f, o) })
      const init = st.repoInit
      const manual = (st.repoStatus && st.repoStatus.manual) || ''
      return h('div', { className: 'kcb' },
        h('div', { className: 'k64' }, '② 建仓（先在本机准备好）'),
        h('div', { className: 'kd1' }, '点下面的按钮，插件会在这台机器上把公开仓工作区变成 git 仓库、'
          + '把 origin 连到 GitHub —— **不动网络、不推送**。GitHub 上的空仓要你自己建'
          + '（建仓要走它的接口，接口要凭据，而插件里不放任何人的密钥），建完回来照抄下面的命令推一次。'),
        h('div', { className: 'kce' },
          h('span', { className: 'k57' }, '仓库名'),
          h('input', {
            className: 'k61', style: { flex: '1 1 200px', maxWidth: '260px' },
            value: f.name || '', placeholder: '英文小写（学生 clone 的就是它）',
            onChange: (e) => patch({ name: e.target.value }),
          })),
        h('div', { className: 'kce' },
          h('span', { className: 'k57' }, 'owner'),
          h('input', {
            className: 'k61', style: { flex: '1 1 200px', maxWidth: '260px' },
            value: f.owner || '', placeholder: 'GitHub 用户名或组织名（只能英文）',
            onChange: (e) => patch({ owner: e.target.value }),
          })),
        h('div', { className: 'kce' },
          h('span', { className: 'k57' }, 'Token'),
          h('input', {
            className: 'k61', style: { flex: '1 1 200px', maxWidth: '260px' }, type: 'password',
            value: f.token || '', placeholder: 'ghp_…（可以留空）',
            onChange: (e) => patch({ token: e.target.value }),
          }),
          h('span', { className: 'k57' }, 'Token 只存在这台机器上，不进仓库、不下发学生。')),
        h('div', { className: 'kce' },
          h('span', { className: 'k57' }, '仓库简介'),
          h('input', {
            className: 'k61', style: { flex: '1 1 200px', maxWidth: '360px' },
            value: f.description || '', placeholder: '课程名写在这里（仓名只能是 ASCII）',
            onChange: (e) => patch({ description: e.target.value }),
          })),
        // 折叠块：没有 Token 时那两条命令（照抄即可）。
        // 收进 <details> 是因为它是**少数情况**才要读的长文本；
        // 但内容必须完整、能直接抄 —— 带占位符的命令等于没给。
        h('details', { className: 'kcd' },
          h('summary', null, '看两条手动步骤'),
          manual
            ? h('pre', { className: 'k39', style: { maxHeight: '300px', overflow: 'auto' } }, manual)
            : h('div', { className: 'kd1' }, '（步骤还没读到：改一下上面的 owner / 仓库名，或者点「重新读一次」——'
              + '这几条命令要按你填的 owner 现拼，不能写死。）')),
        h('div', { className: 'kca' },
          h('button', { className: 'k42 k11', disabled: st.busy, onClick: () => onInit() },
            st.busy ? '处理中…' : '在本机把仓库准备好')),
        init && init.hint ? h('div', { className: 'k57' }, init.hint) : null,
        // 刚才做了什么：命令原文 + 输出一起摊开。老师看得见，也学得到 ——
        // 「点了按钮，然后就好了」这种黑箱在出问题时最难排查。
        init && init.steps && init.steps.length
          ? h('div', null,
            h('div', { className: 'k57' }, '刚才在本机做了什么：'),
            init.steps.map((s, i) => h('div', { key: i, className: 'kc7' },
              h('div', { className: 'kc8' },
                bdg(s.skipped ? '跳过' : (s.code === 0 ? '成功' : ('失败 ' + s.code)),
                  s.skipped ? 'var(--dsw-alias-bg-layer-1)'
                    : (s.code === 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)')),
                h('span', { className: 'k57' }, s.cmd)),
              s.out ? h('pre', { className: 'k39', style: { maxHeight: '160px', overflow: 'auto' } }, s.out) : null)))
          : null,
        init && init.warnings && init.warnings.length
          ? h('div', null, init.warnings.map((w, i) => h('div', { key: i, className: 'k57' }, '⚠ ' + w)))
          : null)
    }

    // ── 发布：发布与推送 ──
    /**
     * ③ 发布 / 推送。
     *
     * 「发布」和「推送」必须分开显示，因为它们是**两种失败**：
     *   · 发布失败 = 插件的问题（找不到清单、文件被占用）→ 看下面的输出，找插件
     *   · 推送失败 = 凭据/网络的问题（Token 过期、没权限、没网）→ 只能老师自己动手
     * 混成一句「发布失败」，老师不知道该找谁，也不知道该不该重试。
     *
     * 推送命令**常驻**在这里（不是跑完发布才出现）：老师应该能先看清要敲什么，
     * 再决定发不发。带 Token 的那条形如 `git push https://x-access-token:…@github.com/…`
     * ——它只在内存里拼、只显示给人照抄，**不进 .git/config**，所以这页要明说别外传。
     */
    function RepoPushCard({ st, onPublish, onRefreshList }) {
      const r = st.publishResult
      const init = st.repoInit
      const rs = st.repoStatus
      // 优先用建仓时现拼的那组（里面有带 Token 的命令），否则用状态里那组不带凭据的。
      // hasToken 必须跟着**实际显示的那一组**走：否则一旦回落到状态里那组，
      // 「最后一条里有你的 Token」这句提醒就挂在一组不带 Token 的命令上，白吓人。
      const useInit = !!(init && init.next && init.next.length)
      const next = useInit ? init.next : ((rs && rs.next) || [])
      const hasToken = useInit && !!init.hasToken
      return h('div', { className: 'kcb' },
        h('div', { className: 'k64' }, '③ 发布，然后推送'),
        h('div', { className: 'kd1' }, '第一步「发布」插件替你跑：把公共面与教案写进公开仓工作区、'
          + '生成 课程.json 与 公开问答.json。这一步不联网、不花额度。'
          + '第二步「推送」要用你的凭据，插件里不放任何人的密钥，所以命令给你照抄。'),
        h('div', { className: 'kca' },
          h('button', { className: 'k42', disabled: st.busy, onClick: () => onPublish('check') }, '先检查会发哪些文件'),
          h('button', { className: 'k42 k11', disabled: st.busy, onClick: () => onPublish('publish') },
            st.busy ? '执行中…' : '发布（写公开仓工作区）'),
          h('span', { className: 'k54' }),
          h('button', { className: 'k42', onClick: onRefreshList }, '刷新清单')),
        r ? h('div', null,
          h('div', { className: 'k64' }, r.ok ? ('发布工具执行成功（' + r.mode + '）')
            : ('发布工具失败：' + (r.error || ('exit ' + r.exit)))),
          r.output ? h('pre', { className: 'k63', style: { maxHeight: '260px', overflow: 'auto' } }, r.output) : null) : null,
        next.length ? h('div', null,
          h('div', { className: 'k64' }, '推送（照抄这几条）'),
          hasToken ? h('div', { className: 'k57' }, '⚠ 最后一条里有你的 Token：只在这台机器上敲，'
            + '别复制到聊天、文档或截图里。它没有被写进 .git/config（写进去会跟着仓库被复制走）。') : null,
          h('pre', { className: 'k39', style: { maxHeight: '220px', overflow: 'auto' } }, next.join('\n')),
          h('div', { className: 'k57' }, '推送失败多半是凭据或网络的问题，不是插件的问题：'
            + 'Token 过期、没有这个仓的权限、或者没有网。')) : null,
        h('div', { className: 'k57' }, '学生在面板「公开问答」里能看到新增的问题与总结；'
          + '他们的客户端下次拉取仓库时同步。'))
    }

    // ── 发布 ──
    /**
     * 「归档与发布」这一页的顺序是**照老师的问题顺序**排的：
     *   ① 现在能不能发出去 → ② 不能的话差哪一步（建仓 / 连 remote）→ ③ 发布并推送
     *   → ④ 上传材料归位 → ⑤ 待发布清单（发之前到底会带哪些东西）
     *
     * ⚠️ 上传归位原来在最前面（「老师打开这一页多半是想把材料放进来」）。
     *    现在往前挪了三块，是因为仓库那三件事是**前置条件**：材料放好了、发布也跑了，
     *    但只要没推到 GitHub，学生那边什么都没有 —— 而这一页过去不回答这个问题。
     *
     * 每一块各自套一个错误边界：一块崩了不该让整页红屏（学生端踩过这个坑）。
     */
    function Publish({ st, set, onRefresh, onPublish, onPlan, onRepoStatus, onRepoInit }) {
      const s = st.staged
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '归档与发布'),
        h(PanelBoundary, { label: '仓库状态' }, h(RepoStatusCard, { st, onRefreshStatus: onRepoStatus })),
        h(PanelBoundary, { label: '建仓' }, h(RepoCreateCard, { st, set, onInit: onRepoInit })),
        // ⚠️ 两个刷新 callback 名字必须分开：一个是「重读仓库状态」（只读），
        //    另一个是「重拉待发布清单」。同名的话以后串一次就是——
        //    点「刷新清单」却去读了 git 状态，界面看起来正常，只是清单永远不变。
        h(PanelBoundary, { label: '发布与推送' }, h(RepoPushCard, { st, onPublish, onRefreshList: onRefresh })),
        h('div', { className: 'k64' }, '④ 材料归位'),
        h(PanelBoundary, { label: '材料归位' }, h(MaterialsTable, { st, set, onPlan })),
        h('div', { className: 'k64' }, '⑤ 待发布清单'),
        s ? h('div', null,
          h('div', { className: 'k57' }, '工作区：' + s.workspace),
          h('div', { className: 'k57' }, '公共面：' + s.publicDir + '（' + (s.files || []).length + ' 份）'),
          (s.files || []).length ? (s.files || []).map((f, i) => h('div', { key: i, className: 'kd9' }, f))
            : h('div', { className: 'k21' }, '公共面还是空的 —— 先在「提问与审计」里把值得共享的标出来'),
          h('div', { className: 'k64' }, '学生提交（' + ((s.submissions || []).length) + '）'),
          (s.submissions || []).slice(0, 30).map((f, i) => h('div', { key: i, className: 'k57' },
            '· ' + f.student + ' / ' + f.name)))
          : h('div', { className: 'k21' }, '待发布清单加载中…'))
    }

    // ── 教案补全 ──
    /**
     * 老师的原话：「一般会准备 PPT，但不一定会写教案」。
     * 这一页就是把「写教案」变成「审教案」：
     *   上面是体检结论，下面是逐课时卡片（确认页码 / 生成 / 读草稿 / 采纳）。
     *
     * ⚠️ 图上有一条界必须说清：**草稿不是教案**。只有点「采纳」才会写进
     *    `详细教案/` 并更新索引 —— 教案是批改的对齐基准，不能由代码自动背书。
     *
     * ⚠️ 排版上踩过的坑（症状：整页像个填不完的表单，标题被挤到换行）：
     *    这里原来拿 .k60 当「一行 flex 布局」用，而 .k60 实际是**文本域**的类
     *    （width:100% + 边框 + min-height:64px）。于是每一行课时、每一行按钮
     *    都被画成了 64px 高的输入框：不报错、不崩，只是整页看起来很怪。
     *    教训：短名字的类必须先看定义再用；布局类与控件类不能混。
     *    现在用 kc7/kc8/kc9/kca 这套专门的卡片类，标题独占一行，
     *    长段解释也从「铺在页面上」改成「点开才看」的 .kcd 折叠块。
     */

    /**
     * 课件预览（PPT 窗口）—— 照学生端课件模块的样子渲染。
     *
     * 为什么必须有它：确认课件页码原来是**盲填数字**：老师得先开 PPT 翻到那一页，
     * 再回来输「第 10 到第 58 页」。而这一步的全部意义就是让批改拿到**对的**课件 ——
     * 盲填等于把这个前提交给运气。现在就地看、就地圈，还能直接拿当前页定起止。
     *
     * 「和学生端大体相似」不是照着画：形状与图片的布局走的是**同一套类**
     * （k0/k17/k47/k55），渲染方式也一致（绝对定位 + transform:scale）。
     * 改一处两边一起变。
     */
    function SlidePeek(props) {
      const st = props.st
      const set = props.set
      const chapter = props.chapter
      const data = st.peekSlides
      const chapters = (st.info && st.info.chapters) || ['第一章', '第二章', '第三章']
      const W = (data && data.slideWidth) || 1280
      const H = (data && data.slideHeight) || 720
      // 舞台宽度按可用宽度取（够大但不撑破）：缩放比 = 舞台宽 / 原始宽
      const stageW = props.stageW || 720
      const zoom = stageW / W
      const idx = data && data.slides ? Math.min(Math.max(0, st.peekIndex || 0), data.slides.length - 1) : 0
      const slide = data && data.slides ? data.slides[idx] : null
      const lo = Number(props.from) || 0
      const hi = Number(props.to) || 0
      const inRange = (n) => lo > 0 && n >= lo && n <= (hi || lo)
      const base = (st.info && st.info.prefixes ? st.info.prefixes.media : MEDIA) + '/'

      return h('div', { className: 'kdb' },
        h('div', { className: 'kce' },
          h('span', { className: 'k57' }, props.title || '看课件（学生端的课件页就长这样）'),
          h('span', { className: 'k54' }),
          chapters.map((c) => h('span', {
            key: c, className: 'k43', 'data-on': chapter === c ? '1' : '0',
            onClick: () => props.onChapter && props.onChapter(c),
          }, c))),
        st.peekBusy ? h('div', { className: 'k21' }, '课件加载中…') : null,
        !st.peekBusy && !data ? h('div', { className: 'k21' }, '这一章还没有课件数据') : null,
        slide ? h('div', null,
          // 页条：范围内的页码高亮。老师一眼能看出「我圈的这一段对不对」——
          // 分隔页往往覆盖两三个课时，光看数字看不出圈歪了没有。
          h('div', { className: 'kdc' }, data.slides.map((s) => h('button', {
            key: 'p' + s.index, className: 'kdd',
            'data-in': inRange(s.index) ? '1' : '0',
            'data-cur': s.index === slide.index ? '1' : '0',
            'data-hasimg': (s.media || []).some((m) => m.file) ? '1' : '0',
            title: oneLine(s.text || '').slice(0, 80) || ('第 ' + s.index + ' 页'),
            onClick: () => set({ peekIndex: s.index - 1 }),
          }, s.index))),
          h('div', { className: 'kce' },
            h('button', { className: 'k42', onClick: () => set({ peekIndex: Math.max(0, idx - 1) }) }, '← 上一页'),
            h('span', { className: 'k57' }, chapter + ' 第 ' + slide.index + ' / ' + data.slides.length + ' 页'),
            h('button', { className: 'k42', onClick: () => set({ peekIndex: Math.min(data.slides.length - 1, idx + 1) }) }, '下一页 →'),
            h('button', { className: 'k42', title: '缩小', onClick: () => set({ peekZoom: Math.max(0.6, (st.peekZoom || 1) / 1.2) }) }, '－'),
            h('button', { className: 'k42', title: '放大（公式的角标也能看清）', onClick: () => set({ peekZoom: Math.min(2.6, (st.peekZoom || 1) * 1.2) }) }, '＋'),
            h('span', { className: 'k57' }, Math.round((st.peekZoom || 1) * 100) + '%'),
            props.onSetFrom ? h('button', { className: 'k42 k11', onClick: () => props.onSetFrom(slide.index) }, '这一页作起始') : null,
            props.onSetTo ? h('button', { className: 'k42 k11', onClick: () => props.onSetTo(slide.index) }, '这一页作结束') : null),
          h('div', { className: 'kdg' },
          h('div', { className: 'kde', style: { width: (W * zoom) + 'px', height: (H * zoom) + 'px' } },
            h('div', {
              className: 'k17',
              style: { width: W + 'px', height: H + 'px', transform: 'scale(' + zoom + ')', transformOrigin: '0 0' },
            },
              (slide.shapes || []).map((sh, i) => h('div', {
                key: 's' + i, className: 'k47',
                style: css('left:' + sh.x + 'px;top:' + sh.y + 'px;width:' + sh.w + 'px;height:' + sh.h + 'px;'
                  + 'font-size:' + (sh.maxPt ? Math.max(9, Math.min(30, sh.maxPt * 0.92)) : 13) + 'px;'
                  + 'font-weight:' + (sh.bold ? 600 : 400) + ';'),
              }, sh.text)),
              (slide.media || []).map((m, i) => {
                const bs = css('left:' + m.x + 'px;top:' + m.y + 'px;width:' + m.w + 'px;height:' + m.h + 'px;')
                if (!m.file) return h('div', { key: 'm' + i, className: 'k55', style: bs }, h('b', null, '图片不可用'), h('span', null, m.name))
                // 前缀由宿主 info 下发，绝不在这里写死 '/cip-tea-media' ——
                // 写死就会让教师端去请求学生端的路由（这个坑客户端那侧踩过一次）
                return h(MediaImage, {
                  key: 'm' + i, src: base + encodeURIComponent(chapter) + '/' + encodeURIComponent(m.file),
                  name: m.name, boxStyle: bs, st: st, set: set,
                })
              })))),
          h('div', { className: 'kd1' }, oneLine(slide.text || '').slice(0, 400) || '（这一页没有文字）'),
          lo > 0 ? h('div', { className: 'k57' }, '当前圈定：第 ' + lo + ' – ' + (hi || lo) + ' 页'
            + (hi && hi < lo ? '（起止反了）' : '')) : null) : null)
    }

    /**
     * 继续改（对话式）—— 像学生追问那样一轮一轮改教案。
     *
     * 为什么不是「重新生成」：老师看出来的问题几乎都是**局部的**（这节推导跳步、
     * 验收标准太虚、第 12 页那张图要讲进去）。重生成会把已经满意的部分一起洗掉；
     * 逐轮改只动该动的，而且每轮都能看见「改了什么」。
     *
     * 证据这块刻意做成**和学生提问同一套**：
     *   · 拖选文字 → 「用选中的文字」（原生 selection，学生在课件页也是这么干的）
     *   · 框选图区 → 「圈一块图」（走共享内核的 cropToPng，和学生框选截图同一份代码）
     * 老师圈一块 PPT 内容再说「把这块讲进推导」，比让他打字描述那张图准确得多 ——
     * 这门课的课件大量用截图代替公式，只发坐标等于什么都没给。
     */
    /**
     * 鼠标位置 → 课件页坐标（纯函数，便于单测）。
     *
     * ⚠️ 这个函数是被老师的一次反馈逼出来的：「框选的光标和实际选择框之间有偏移」。
     *    原因是我拿**外层容器**的左上角当课件页的左上角 —— 而容器里除了课件页，
     *    上面还有页条和翻页按钮，课件页本身还是居中的。于是横向差一个居中偏移、
     *    纵向差页条加控件那一截，而且越往右下偏得越多。
     *
     *    抽成纯函数是为了能真的测它：几何错在界面上只是「有点歪」，
     *    靠渲染断言看不出来，但拿一组写死的矩形一算就一目了然。
     *    基准必须来自**量出来的课件页**（stageBox），不要在容器上做几何推断。
     */
    function slidePointFrom(clientX, clientY, wrapRect, stageBox, W, H) {
      if (!stageBox || !stageBox.width || !wrapRect) return null
      const zoom = stageBox.width / W
      if (!zoom) return null
      return {
        x: Math.max(0, Math.min(W, (clientX - wrapRect.left - stageBox.left) / zoom)),
        y: Math.max(0, Math.min(H, (clientY - wrapRect.top - stageBox.top) / zoom)),
      }
    }
    if (typeof window !== 'undefined') window.__cipSlidePointFrom = slidePointFrom

    /**
     * 选框样式（像素）。基准是覆盖层 = 课件页本身，所以这里所有量都来自同一处。
     *
     * ⚠️ 产出的是**样式对象**，不经过 `css()`。踩过一次：写成
     *    `Object.assign({边框…}, css(boxStyle))`，而 boxStyle 已经是 `css(...)`
     *    的结果对象 —— 等于把对象又喂回解析器一遍。`css()` 里是
     *    `String(text || '')`，对象被转成 `"[object Object]"`，没有冒号 → 解析出空对象，
     *    left/top/width/height 全丢，只剩一个 2px 边框、宽高为 0 ——
     *    表现就是「圈选框不显示了」。不报错、不崩，只是一个看不见的框。
     *    教训：几何数值直接算成样式对象，别在解析器之间来回倒手。
     */
    function boxStyleFrom(b, zoom) {
      if (!b || !zoom) return null
      return {
        left: (Math.min(b.x0, b.x1) * zoom) + 'px',
        top: (Math.min(b.y0, b.y1) * zoom) + 'px',
        width: (Math.abs(b.x1 - b.x0) * zoom) + 'px',
        height: (Math.abs(b.y1 - b.y0) * zoom) + 'px',
      }
    }

    function RevisePanel({ st, set, lesson, onRevise, onRevert, onPeekChapter }) {
      const stageRef = React.useRef(null)
      const [dragBox, setDragBox] = React.useState(null)
      const [hint, setHint] = React.useState('')
      // 课件页**在容器里的实际位置**（相对容器左上角，像素）。
      /**
       * ⚠️ 为什么必须单独量它：这个容器里除了课件页，上面还有页条和翻页按钮，
       *    而课件页本身在 .kdg 里是**居中的**。我第一版直接拿容器的
       *    getBoundingClientRect() 当课件页的左上角，于是横向差了一个居中偏移、
       *    纵向差了页条加控件那一截 —— 表现就是「光标和选择框对不上」，
       *    而且偏得越靠右下越明显。老师反馈的就是这个。
       *    判据要落在**真正的那个元素**上（.k17，和学生端同一套布局类），
       *    不要在容器上做几何推断。
       */
      const [stageBox, setStageBox] = React.useState(null)
      const slides = st.peekSlides
      const slide = slides && slides.slides ? slides.slides[Math.min(st.peekIndex || 0, slides.slides.length - 1)] : null
      const W = (slides && slides.slideWidth) || 1280
      const H = (slides && slides.slideHeight) || 720
      const picks = st.revisePicks || []
      const picking = st.revisePick === true

      const measure = React.useCallback(() => {
        const wrap = stageRef.current
        if (!wrap || !wrap.getBoundingClientRect) return
        const el = wrap.querySelector ? (wrap.querySelector('.k17') || wrap.querySelector('.kde')) : null
        if (!el) return
        const w = wrap.getBoundingClientRect()
        const s = el.getBoundingClientRect()
        const next = {
          left: s.left - w.left, top: s.top - w.top,
          width: s.width, height: s.height,
        }
        // 值没变就不 set：假 React 每次都跑 effect，无脑 set 会一直重渲染
        setStageBox((prev) => {
          if (prev && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5
            && Math.abs(prev.width - next.width) < 0.5 && Math.abs(prev.height - next.height) < 0.5) return prev
          return next
        })
      }, [])
      // 换页、缩放、窗口大小变化都要重新量 —— 这三件事都会让课件页挪位置
      React.useEffect(() => { measure() })
      React.useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return undefined
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [measure])

      /**
       * 鼠标位置 → 课件页坐标。
       * 基准是**量出来的课件页**（stageBox），不是外层容器。
       */
      const toSlidePoint = (e) => {
        const wrap = stageRef.current
        if (!wrap || !stageBox || !stageBox.width) return null
        const w = wrap.getBoundingClientRect()
        const zoom = stageBox.width / W
        if (!zoom) return null
        return {
          x: Math.max(0, Math.min(W, (e.clientX - w.left - stageBox.left) / zoom)),
          y: Math.max(0, Math.min(H, (e.clientY - w.top - stageBox.top) / zoom)),
        }
      }

      const onDown = (e) => {
        if (!picking || !slide) return
        const p = toSlidePoint(e)
        if (p) setDragBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }
      const onMove = (e) => {
        if (!dragBox) return
        const p = toSlidePoint(e)
        if (p) setDragBox(Object.assign({}, dragBox, { x1: p.x, y1: p.y }))
      }
      /** 拖完就把框里的内容**真的截成一张 PNG**，和学生的框选走同一条路 */
      const onUp = async () => {
        const b = dragBox
        setDragBox(null)
        if (!b || !slide) return
        const box = {
          x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1),
          w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0),
        }
        if (box.w < 8 || box.h < 8) { setHint('框太小了 —— 拖一个明显大一点的区域'); return }
        // 框内的文字也一起取：纯文字的页只有文字，只发截图会得到一张白纸
        const inText = (slide.shapes || []).filter((s) => {
          const ox = Math.max(0, Math.min(s.x + s.w, box.x + box.w) - Math.max(s.x, box.x))
          const oy = Math.max(0, Math.min(s.y + s.h, box.y + box.h) - Math.max(s.y, box.y))
          return ox > 0 && oy > 0 && String(s.text || '').trim()
        }).map((s) => s.text).join('\n')
        let dataUrl = null
        try {
          const r = await cropToPng(stageRef.current, slide, box, 2)
          dataUrl = r && r.dataUrl
          if (!dataUrl) setHint('这张截图没成功：' + ((r && r.diag && r.diag.reason) || '未知原因'))
        } catch (err) { setHint('截图失败：' + ((err && err.message) || err)) }
        if (picks.length >= 4) { setHint('一轮最多带 4 块证据 —— 多了模型反而抓不住重点'); return }
        set({
          revisePicks: picks.concat([{
            chapter: (slides && slides.chapter) || st.peekChapter || '', page: slide.index,
            kind: 'region', text: inText.slice(0, 900), dataUrl: dataUrl, note: '',
          }]),
          revisePick: false,
        })
        if (dataUrl) setHint('已圈入第 ' + slide.index + ' 页的一块内容（截图 + 文字都带上了）')
      }
      /** 拖选文字：用浏览器原生的 selection，不比自定义选区差，而且更稳 */
      const addTextPick = () => {
        let text = ''
        try {
          const sel = typeof window !== 'undefined' ? window.getSelection() : null
          text = sel ? String(sel.toString() || '') : ''
        } catch (e) { text = '' }
        if (!text.trim()) { setHint('先在下面的课件页上用鼠标拖选一段文字，再点这个按钮'); return }
        if (picks.length >= 4) { setHint('一轮最多带 4 块证据'); return }
        set({
          revisePicks: picks.concat([{
            chapter: (slides && slides.chapter) || st.peekChapter || '',
            page: slide ? slide.index : 0, kind: 'text', text: text.slice(0, 900), dataUrl: null, note: '',
          }]),
        })
        setHint('已加入一段拖选的文字')
      }
      const removePick = (i) => set({ revisePicks: picks.filter((x, j) => j !== i) })
      /**
       * 选框的样式（像素，基准是覆盖层 = 课件页本身）。
       *
       * ⚠️ 这里**不经过 css()**，直接产出 React 能用的样式对象。原因是踩了一次：
       *    原来写成 `Object.assign({边框…}, css(boxStyle))`，而 boxStyle 已经是
       *    `css('left:…px;…')` 的**结果对象**了 —— 等于把对象又喂回 css() 解析一遍。
       *    而 `css()` 里是 `String(text || '')`，对象被转成 `"[object Object]"`，
       *    里面没有冒号，于是解析出**空对象**：left/top/width/height 全丢，
       *    只剩一个 2px 边框，宽高为 0 —— 表现就是「圈选框不显示了」。
       *    不报错、不崩，只是一个看不见的框。
       *
       *    所以：几何数值直接算成样式对象，别在解析器之间来回倒手。
       */
      // 用模块层那个 boxStyleFrom（校验脚本也要拿到它），这里不再留一份同名的
      const zoomNow = (stageBox && stageBox.width) ? stageBox.width / W : 0
      const boxPx = boxStyleFrom(dragBox, zoomNow)

      return h('div', null,
        // ── 课件（可圈）──
        h('div', { style: { position: 'relative' } },
          h('div', { ref: stageRef },
            h(SlidePeek, {
              st, set, chapter: st.peekChapter || (st.anchorEdit && st.anchorEdit.chapter) || '', from: 0, to: 0,
              title: '在课件上圈重点（拖选文字，或按「圈一块图」后拖一个框）',
              stageW: st.peekZoom ? Math.round(720 * st.peekZoom) : 720,
              onChapter: onPeekChapter,
            })),
          // 圈选覆盖层：**只盖在课件页上**，不是盖住整个容器。
          // 盖整个容器的话有两个毛病：一是坐标基准错（就是老师报的偏移），
          // 二是页条和翻页按钮被挡住 —— 圈到一半想翻页还得先退出圈选。
          // 位置由量出来的 stageBox 决定，所以画在哪里、就算在哪里。
          (picking && stageBox) ? h('div', {
            style: {
              position: 'absolute', cursor: 'crosshair', zIndex: 5,
              left: stageBox.left + 'px', top: stageBox.top + 'px',
              width: stageBox.width + 'px', height: stageBox.height + 'px',
              background: 'rgba(47,111,235,.06)',
            },
            onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp, onMouseLeave: () => setDragBox(null),
          }, (dragBox && boxPx) ? h('div', {
            style: Object.assign({
              position: 'absolute', border: '2px solid #2f6feb',
              background: 'rgba(47,111,235,.18)', pointerEvents: 'none',
            }, boxPx),
          }) : null) : null),
        h('div', { className: 'kca' },
          h('button', {
            className: 'k42', disabled: st.busy,
            onClick: () => set({ revisePick: !picking }),
          }, picking ? '退出圈选' : '圈一块图'),
          h('button', { className: 'k42', disabled: st.busy, onClick: addTextPick }, '用选中的文字'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k57' }, '已圈 ' + picks.length + ' / 4 块')),
        hint ? h('div', { className: 'kd1' }, hint) : null,

        // ── 圈到的证据 ──
        // 已圈到的证据：每条都能单独去掉（圈错一块不必全部重来）
        picks.length ? h('div', { className: 'kce' }, picks.map((p, i) => h('span', {
          key: i, className: 'k57',
        },
          (p.kind === 'region' ? '框选 ' : '文字 ') + (p.chapter || '') + ' 第' + p.page + ' 页'
          + (p.text ? ('（' + p.text.slice(0, 18) + '…）') : ''),
          h('button', { className: 'k42', onClick: () => removePick(i) }, '×')))) : null,

        // ── 这一轮要改什么 ──
        h('textarea', {
          className: 'k59', rows: 3, value: st.reviseText || '',
          placeholder: '这一轮要改什么？例如：把「推导」第二节的矩阵求导补上逐步说明；'
            + '或者圈住第 12 页那段，说「把这块讲进推导」。',
          style: {
            width: '100%', boxSizing: 'border-box', border: '1px solid var(--line-2)',
            borderRadius: 'var(--r2)', background: 'var(--dsw-alias-bg-base)',
          },
          onChange: (e) => set({ reviseText: e.target.value }),
        }),
        h('div', { className: 'kca' },
          h('button', {
            className: 'k42 k11',
            disabled: st.busy || (!oneLine(st.reviseText || '') && !picks.length),
            onClick: () => onRevise(lesson),
          }, st.busy ? '改写中…' : '让模型改这一轮'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k57' }, '每轮都会先把当前版本存一份快照，改坏了能退回来。'
            + '只改你要求的地方，其余部分要求模型逐字保持不变。')),

        // ── 改过几轮 ──
        (st.turns || []).length ? h('div', null,
          h('div', { className: 'k64' }, '已经改了 ' + st.turns.length + ' 轮'),
          st.turns.map((t, i) => h('div', { key: i, className: 'kdh' },
            h('div', { className: 'k70' },
              bdg('第 ' + (i + 1) + ' 轮', 'var(--dsw-alias-brand-primary)'),
              bdg(t.a || '', 'var(--dsw-alias-bg-layer-1)'),
              t.charsAfter ? bdg(t.charsBefore + ' → ' + t.charsAfter + ' 字', 'var(--dsw-alias-bg-layer-1)') : null,
              (t.evidence || []).length ? bdg('带证据 ' + t.evidence.length + ' 块', 'var(--dsw-alias-bg-layer-1)') : null,
              t.images ? bdg('截图 ' + t.images + ' 张', 'var(--dsw-alias-bg-layer-1)') : null),
            h('div', { className: 'kdi' }, t.q),
            (t.keptFromOld || []).length
              ? h('div', { className: 'k57' }, '⚠ 新稿把 ' + t.keptFromOld.join('、') + ' 写空了，已保留原来的内容')
              : null,
            h('div', { className: 'kca' },
              h('button', {
                className: 'k42', disabled: st.busy,
                title: '退回这一轮开始之前的样子（之后几轮的要求会丢弃）',
                onClick: () => onRevert(lesson, i),
              }, '退回这一轮之前'))))) : null)
    }

    /** 页码锚点编辑器：老师点「改页码」就地展开，不再是一个没有反应的空动作。 */
    function AnchorEditor({ row, st, set, onSaveAnchor, onClearAnchor, onPeekChapter, onSetRange }) {
      const cur = st.anchorEdit || {}
      const chapters = (st.info && st.info.chapters) || ['第一章', '第二章', '第三章']
      // 把课件里切出来的分隔页标题摆出来：老师就是拿它对照着找页码的
      const mine = ((st.outline && st.outline.dividers) || []).filter((d) => d.module === row.module)
      const patch = (p) => set({ anchorEdit: Object.assign({}, cur, p) })
      return h('div', { className: 'kcb' },
        h('div', { className: 'k78' }, '课时' + row.no + ' 的课件页码范围'),
        h('div', { className: 'kd1' }, '在下面的课件窗口里翻到这一课时的第一页和最后一页，点「作起始 / 作结束」就填好了。'
          + '确认后写进 教案草稿/_锚点.json，之后生成教案、按课时汇总都用它，不再猜。'),
        h('div', { className: 'k70' },
          h('span', { className: 'k57' }, '课件'),
          h('select', {
            className: 'kcc', value: cur.chapter || '',
            onChange: (e) => { patch({ chapter: e.target.value }); onPeekChapter(e.target.value) },
          }, chapters.map((c) => h('option', { key: c, value: c }, c))),
          h('span', { className: 'k57' }, '第'),
          h('input', {
            className: 'kcc', type: 'number', min: 1, value: cur.from === undefined ? '' : cur.from,
            onChange: (e) => patch({ from: e.target.value }),
          }),
          h('span', { className: 'k57' }, '页 ～ 第'),
          h('input', {
            className: 'kcc', type: 'number', min: 1, value: cur.to === undefined ? '' : cur.to,
            onChange: (e) => patch({ to: e.target.value }),
          }),
          h('span', { className: 'k57' }, '页')),
        // ── 课件窗口：就地看 PPT，就地圈范围 ──
        // 放在页码输入框**下面**，因为它就是给上面那两个框用的。
        h(SlidePeek, {
          st, set,
          chapter: cur.chapter || chapters[0],
          from: cur.from, to: cur.to,
          onChapter: onPeekChapter,
          onSetFrom: (n) => onSetRange(row.no, { from: n }),
          onSetTo: (n) => onSetRange(row.no, { to: n }),
        }),
        mine.length ? h('div', { className: 'kd1' },
          '本模块在课件里的分隔页（照着它核对你圈的范围）：'
          + mine.map((d) => (d.spans || []).map((s) => s.chapter + ' ' + s.from + '–' + s.to
            + '「' + (s.title || '') + '」').join('；')).join('　|　'))
          : h('div', { className: 'k57' }, '这一模块在课件里没有分隔页 —— 页码只能你自己看 PPT 定。'),
        h('div', { className: 'kca' },
          h('button', { className: 'k42 k11', disabled: st.busy, onClick: () => onSaveAnchor(row.no) }, '保存页码'),
          h('button', { className: 'k42', disabled: st.busy, onClick: () => onClearAnchor(row.no) }, '清除（回到自动推断）'),
          h('span', { className: 'k54' }),
          h('button', { className: 'k42', onClick: () => set({ anchorEdit: null, peekSlides: null }) }, '取消')))
    }

    function PlanPage({ st, set, onGen, onOpenDraft, onAccept, onReject, onDel, onSaveDraft, onRebuild, onOpenAnchor, onSaveAnchor, onClearAnchor, onModel, onPeekChapter, onSetRange, onRevise, onRevert }) {
      const o = st.outline
      const catalog = st.planCatalog
      const cur = catalog && catalog.effective
      const drafts = st.drafts || []
      const draftOf = {}
      for (const d of drafts) draftOf[Number(d.lesson)] = d
      if (!o) return h('div', { className: 'k21' }, '大纲体检加载中…（要读三个章节的课件数据，第一次会慢几秒）')
      const rowOf = (no) => ((o.lessons || []).find((r) => Number(r.no) === Number(no))) || null
      const modelValue = cur ? (cur.provider + '/' + cur.model) : ''

      return h('div', { className: 'k46' },

        // ── 体检结论 ──
        h('div', { className: 'k64' }, '大纲体检'),
        h('div', { className: 'kce' },
          bdg('课时 ' + o.totalLessons, 'var(--dsw-alias-brand-primary)'),
          bdg('有教案 ' + o.withPlan, 'var(--dsw-alias-state-success-primary)'),
          bdg('缺教案 ' + o.missingPlan, o.missingPlan ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'),
          bdg('有课件页 ' + o.withSlides, 'var(--dsw-alias-bg-layer-1)'),
          bdg('可自动补 ' + o.autoFillable, 'var(--dsw-alias-bg-layer-1)'),
          o.noMaterial ? bdg('材料不足 ' + o.noMaterial, 'var(--dsw-alias-state-warn-primary)') : null,
          o.withDraft ? bdg('待审草稿 ' + o.withDraft, 'var(--dsw-alias-state-warn-primary)') : null),
        h('details', { className: 'kcd' },
          h('summary', null, '「缺教案」和「缺课件」为什么要分开报'),
          h('div', { className: 'kd1' },
            '它们是两种补救：教案可以让模型补，课件要去录课。合成一个「完成度 60%」对老师没有任何用。'),
          h('div', { className: 'kd1' },
            '另外，「有教案」还会继续查**缺哪一节** —— 一份没有「验收标准」的教案看起来是有的，'
            + '但批改拿它当基准时等于没有基准。这种「看起来有」最需要被指出来。')),
        h('div', { className: 'kca' },
          h('button', { className: 'k42', disabled: st.busy, onClick: onRebuild }, '重建索引'),
          h('span', { className: 'k57' }, '索引是手工维护的派生文件；漏改的症状是学生端说「这一课时没有教案」，'
            + '批改随即退化成通用初筛，而且**不报错**。')),
        st.rebuildResult ? h('div', { className: 'kcb' },
          h('div', { className: 'k78' }, st.rebuildResult.note),
          (st.rebuildResult.changes || []).slice(0, 30).map((c, i) => h('div', { className: 'k57' },
            '· ' + c.module + (c.lesson ? (' 课时' + c.lesson) : '') + '：' + (c.from || '(空)') + ' → ' + (c.to || '(空)')
            + (c.why ? ('（' + c.why + '）') : ''))),
          (st.rebuildResult.orphans || []).map((x, i) => h('div', { className: 'k57' },
            '⚠ ' + x.module + ' / ' + x.name + ' —— ' + x.why))) : null,

        // ── 模型选择：这一页唯一会花钱的地方，必须显示出来 ──
        h('div', { className: 'k64' }, '用于生成教案的模型'),
        h('div', { className: 'k70' },
          h('select', {
            className: 'kcc', value: modelValue, style: { maxWidth: '320px' },
            onChange: (e) => {
              const v = e.target.value
              if (!v) { onModel('', ''); return }
              const i = v.indexOf('/')
              onModel(v.slice(0, i), v.slice(i + 1))
            },
          },
            [h('option', { key: '__def', value: '' }, '跟随会话默认' + (catalog && catalog.sessionDefault
              ? ('（' + catalog.sessionDefault.provider + '/' + catalog.sessionDefault.model + '）') : ''))]
              .concat((catalog && catalog.models || []).map((m) => h('option', {
                key: m.provider + '/' + m.model, value: m.provider + '/' + m.model,
              }, m.provider + ' / ' + m.name + (m.image ? '（可看图）' : ''))))),
          h('span', { className: 'kd1', style: { flex: '1 1 220px' } },
            '生成一课花一次调用，用**你自己的**额度。审计、汇总、发布这些动作不调用模型，一分钱不花。')),
        (catalog && catalog.warnings || []).map((w, i) => h('div', { className: 'k57' }, '⚠ ' + w)),

        // ── 逐课时卡片 ──
        h('div', { className: 'k64' }, '逐课时状态'),
        (o.modules || []).map((m) => h('div', { key: m.name },
          h('div', { className: 'kc9' }, m.name + '　' + (m.theme || '')),
          h('div', { className: 'kce' },
            bdg('教案 ' + m.hasPlan + '/' + m.total,
              m.hasPlan === m.total ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'),
            bdg(m.codeFiles + ' 份示例代码', 'var(--dsw-alias-bg-layer-1)'),
            m.hasSlides ? bdg('课件覆盖 ' + m.hasSlides + ' 课时', 'var(--dsw-alias-bg-layer-1)')
              : bdg('无课件', 'var(--dsw-alias-state-warn-primary)')),
          (m.lessons || []).map((r) => {
            const d = draftOf[Number(r.no)]
            const editing = !!(st.anchorEdit && Number(st.anchorEdit.lesson) === Number(r.no))
            const missing = r.plan && r.planMissingSections && r.planMissingSections.length
            return h('div', { key: r.no, className: 'kc7', 'data-on': editing ? '1' : '0' },
              h('div', { className: 'kc8' },
                bdg('课时' + r.no, 'var(--dsw-alias-brand-primary)'),
                r.plan ? bdg('有教案', 'var(--dsw-alias-state-success-primary)')
                  : bdg('缺教案', 'var(--dsw-alias-state-error-primary)'),
                missing ? bdg('缺 ' + r.planMissingSections.join('、'), 'var(--dsw-alias-state-warn-primary)') : null,
                d ? bdg(d.status === 'accepted' ? '已采纳' : (d.status === 'rejected' ? '已弃' : '待审草稿'),
                  d.status === 'accepted' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)') : null),
              // 标题独占一行，不再和按钮抢宽度
              h('div', { className: 'kc9' }, r.title),
              h('div', { className: 'kce' },
                r.slides
                  ? bdg('课件 ' + r.slides.chapter + ' ' + r.slides.from + '–' + r.slides.to
                    + (r.slides.approx ? '（推断）' : '（已确认）'),
                    r.slides.approx ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-state-success-primary)')
                  : bdg('无课件页', 'var(--dsw-alias-label-secondary)'),
                !r.autoFillable ? bdg('材料不足，无法自动补', 'var(--dsw-alias-state-warn-primary)') : null,
                r.planPath ? h('span', { className: 'k57' }, r.planPath.split('\\').pop()) : null),
              h('div', { className: 'kca' },
                h('button', {
                  className: 'k42', disabled: st.busy,
                  onClick: () => onOpenAnchor(r, editing),
                }, editing ? '收起页码' : (r.slides ? (r.slides.approx ? '确认 / 改页码' : '改页码') : '设置页码')),
                h('button', {
                  className: 'k42 k11', disabled: st.busy || !r.autoFillable,
                  title: r.autoFillable ? '用课件 + 示例代码生成这一课的教案草稿'
                    : '这一课时既没有课件页也没有示例代码 —— 先生成只会得到常识拼凑的教案',
                  onClick: () => onGen(r.no),
                }, st.genLesson === r.no ? '生成中…' : (r.plan ? '重新生成' : '生成教案')),
                d && d.status !== 'accepted' ? h('button', { className: 'k42', disabled: st.busy, onClick: () => onOpenDraft(r.no) }, '读草稿') : null),
              editing ? h(AnchorEditor, {
                row: r, st, set, onSaveAnchor, onClearAnchor,
                onPeekChapter: onPeekChapter, onSetRange: onSetRange,
              }) : null)
          }))),

        // ── 草稿审批 ──
        h('div', { className: 'k64' }, '草稿（' + drafts.filter((d) => d.status !== 'accepted').length + ' 待审）'),
        h('details', { className: 'kcd' },
          h('summary', null, '为什么「草稿」不算教案'),
          h('div', { className: 'kd1' },
            '教案是批改逐条对标的基准。一份没人看过的自动文本一旦成了基准，'
            + '错误会被放大到每个学生身上。所以生成出来的一律叫草稿，只有你点「采纳」才进 详细教案/。'),
          h('div', { className: 'kd1' },
            '同名教案已存在时会先备份到 教案草稿/_历史/ 再覆盖 —— 旧版是你事后对比的唯一依据，不能直接冲掉。')),
        drafts.length ? drafts.map((d) => h('div', { key: d.lesson, className: 'kc7' },
          h('div', { className: 'kc8' },
            bdg('课时' + d.lesson, 'var(--dsw-alias-brand-primary)'),
            bdg(d.status === 'accepted' ? '已采纳' : (d.status === 'rejected' ? '已弃' : '待审'),
              d.status === 'accepted' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'),
            bdg((d.chars || 0) + ' 字符', 'var(--dsw-alias-bg-layer-1)'),
            d.model ? bdg(d.model, 'var(--dsw-alias-bg-layer-1)') : null,
            d.missingSections && d.missingSections.length
              ? bdg('缺 ' + d.missingSections.join('、'), 'var(--dsw-alias-state-error-primary)')
              : bdg('五节齐全', 'var(--dsw-alias-state-success-primary)')),
          h('div', { className: 'kc9' }, d.title || ''),
          d.saw ? h('div', { className: 'kd1' }, '生成时看到：课件 ' + d.saw.slides + ' · 代码 ' + d.saw.code
            + ' · 风格样例 ' + d.saw.style
            + ((d.saw.missing || []).length ? ('　缺失：' + d.saw.missing.join('；')) : '')) : null,
          d.anchor ? h('div', { className: 'k57' }, '课件范围：' + d.anchor.chapter + ' ' + d.anchor.from + '–' + d.anchor.to
            + (d.anchor.approx ? '（推断，未确认）' : '（已确认）')) : null,
          h('div', { className: 'kca' },
            h('button', { className: 'k42 k11', disabled: st.busy, onClick: () => onOpenDraft(d.lesson) }, '读草稿'),
            h('button', {
              className: 'k42 k11', disabled: st.busy || d.status === 'accepted',
              title: '写进 详细教案/ 并更新索引；同名教案已存在时会先备份再覆盖',
              onClick: () => onAccept(d.lesson),
            }, '采纳'),
            h('button', { className: 'k42', disabled: st.busy, onClick: () => onReject(d.lesson) }, '不采纳'),
            h('button', { className: 'k42', disabled: st.busy, onClick: () => onDel(d.lesson) }, '删掉草稿'),
            d.usage ? h('span', { className: 'k57' }, 'tokens ' + ((d.usage && d.usage.inputTokens) || 0)
              + '/' + ((d.usage && d.usage.outputTokens) || 0)) : null))) : h('div', { className: 'k21' }, '还没有草稿 —— 在上面点「生成教案」'),

        // ── 草稿：预览 / 编辑 / 采纳 ──
        //
        // 「预览」页签是**必须**的，不是锦上添花：老师反馈「生成完没有预览窗口」。
        // 根因有两层 —— 一是渲染出来没有框（直接用 Markdown 得到的是一个无边界
        // div，看起来只是页面上多了段文字），二是它压在整页最底下，生成完
        // 视线还停在课时卡片那里。现在：给它明确的框（kd5）+「预览 / 编辑」两页签，
        // 并且预览用**学生端课时页同一个 Markdown 组件** ——
        // 这才叫「我看到的和学生看到的一样」。
        st.draftOpen ? h('div', { className: 'kc7', 'data-on': '1', id: 'cip-plan-draft' },
          h('div', { className: 'kc8' },
            bdg('课时' + st.draftOpen.lesson, 'var(--dsw-alias-brand-primary)'),
            st.draftOpen.file ? bdg(st.draftOpen.file, 'var(--dsw-alias-bg-layer-1)') : null,
            (st.draftMissing || []).length === 0 && (st.draftText || '').length
              ? bdg('五节齐全', 'var(--dsw-alias-state-success-primary)') : null),
          h('h3', { className: 'kc9' }, st.draftTitle || (rowOf(st.draftOpen.lesson) || {}).title || ''),
          h('div', { className: 'kce' },
            // 逐节检查：老师一眼看出哪一节还空着 ——「有教案」不等于「能用」
            PLAN_SECTION_NAMES.map((nm) => {
              const miss = (st.draftMissing || []).indexOf(nm) >= 0
              return bdg((miss ? '缺 ' : '✓ ') + nm,
                miss ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)')
            }),
            bdg((st.draftText || '').length + ' 字符', 'var(--dsw-alias-bg-layer-1)'),
            rowOf(st.draftOpen.lesson) && rowOf(st.draftOpen.lesson).slides
              ? bdg('课件 ' + rowOf(st.draftOpen.lesson).slides.chapter + ' '
                + rowOf(st.draftOpen.lesson).slides.from + '–' + rowOf(st.draftOpen.lesson).slides.to,
                'var(--dsw-alias-bg-layer-1)') : null),
          h('div', { className: 'k24', style: { marginBottom: '8px' } },
            h('span', {
              className: 'k43', 'data-on': st.draftTab === 'edit' ? '0' : '1',
              onClick: () => set({ draftTab: 'preview' }),
            }, '预览（学生看到的样子）'),
            h('span', {
              className: 'k43', 'data-on': st.draftTab === 'edit' ? '1' : '0',
              onClick: () => set({ draftTab: 'edit' }),
            }, '编辑 Markdown'),
            // 「继续改」是第三个页签：像学生追问那样一轮一轮改，可以圈课件内容当依据
            h('span', {
              className: 'k43', 'data-on': st.draftTab === 'revise' ? '1' : '0',
              onClick: () => { set({ draftTab: 'revise' }); if (!stRef.current.peekSlides) loadPeek(stRef.current.peekChapter || (stRef.current.anchorEdit && stRef.current.anchorEdit.chapter) || ((stRef.current.info && stRef.current.info.chapters) || ['第一章'])[0]) },
            }, '继续改（对话）')),

          st.draftTab === 'revise'
            ? h(RevisePanel, {
              st, set, lesson: st.draftOpen.lesson,
              onRevise: onRevise, onRevert: onRevert, onPeekChapter: onPeekChapter,
            })
            : st.draftTab === 'edit'
            ? h('textarea', {
              className: 'k59', rows: 20, value: st.draftText,
              style: {
                width: '100%', boxSizing: 'border-box', fontFamily: 'Consolas,monospace',
                fontSize: '12.5px', lineHeight: 1.6, border: '1px solid var(--line-2)',
                borderRadius: 'var(--r2)', background: 'var(--dsw-alias-bg-base)',
              },
              onChange: (e) => set({ draftText: e.target.value, draftMissing: missingSectionsOf(e.target.value) }),
            })
            // ⚠️ 必须是**共享内核的 Markdown 组件**，不能自己再写一个渲染器：
            //    两端各写一个，公式/表格/代码块的显示就会开始漂移，
            //    而「预览」的全部意义就是它与学生的画面逐字一致。
            : h('div', { className: 'kd5' }, h(Markdown, { text: st.draftText || '' })),

          h('div', { className: 'kca' },
            st.draftTab === 'edit'
              ? h('button', { className: 'k42', disabled: st.busy, onClick: () => onSaveDraft(st.draftOpen.lesson, st.draftText) }, '保存修改')
              : null,
            h('button', {
              className: 'k42 k11', disabled: st.busy,
              onClick: () => onAccept(st.draftOpen.lesson),
            }, '采纳（写进正式教案）'),
            h('button', { className: 'k42', disabled: st.busy, onClick: () => onReject(st.draftOpen.lesson) }, '不采纳'),
            h('span', { className: 'k54' }),
            h('span', { className: 'k57' }, '采纳目标：' + (st.draftOpen.target || '详细教案/')),
            h('button', { className: 'k42', onClick: () => set({ draftOpen: null, draftText: '' }) }, '收起')),
          h('div', { className: 'kd1' }, '预览用的是**学生端课时页同一个渲染组件** —— 你在这里看到的排版与公式，'
            + '就是学生打开这一课时看到的。采纳后它写进 详细教案/ 并同步索引，学生下次拉取即可看到。')) : null)
    }

    // ── 学生 ──
    /**
     * 「谁提问的」。
     *
     * 这一栏原来写的是 **Administrator** —— 那不是学生，是这台 Windows
     * 机器的用户名（身份 = CIP_STUDENT || USERNAME）。老师要看的是
     * 「这一班谁需要我管」，所以这里做两件事：
     *   1. 名册：老师可以直接把学号改成真名（学生自己填的可能写错或写昵称，
     *      而老师手里的名册来自教务）。显示名优先级：名册 > 自报 > 学号。
     *   2. 每行带可比较的计数（提问 / 未批改 / 严重度 / 最后活跃），
     *      点进去是该生的全部情况 + 「这个人需要我做什么」的结论。
     */
    function RosterEditor({ row, st, set, onSaveRoster }) {
      const f = st.rosterEdit || {}
      const setF = (p) => set({ rosterEdit: Object.assign({}, f, p) })
      return h('div', { className: 'kcb' },
        h('div', { className: 'k78' }, '给 ' + row.sid + ' 补一个真名'),
        h('div', { className: 'kd1' }, '学生自己填的名字可能写错、写昵称或重名。'
          + '这里填的**优先于**他自报的 —— 你手里的名册是这门课唯一的事实来源。'),
        h('div', { className: 'k70' },
          h('span', { className: 'k57' }, '姓名'),
          h('input', { className: 'kcc', value: f.name || '', placeholder: '例如 张三', onChange: (e) => setF({ name: e.target.value }) }),
          h('span', { className: 'k57' }, '班级'),
          h('input', { className: 'kcc', value: f.klass || '', placeholder: '选填，例如 土木2101', onChange: (e) => setF({ klass: e.target.value }) })),
        h('input', {
          className: 'kcc', style: { maxWidth: '100%', width: '100%' }, value: f.note || '',
          placeholder: '备注（只有你能看到，例如：基础较弱、问得多、在准备考研）',
          onChange: (e) => setF({ note: e.target.value }),
        }),
        row.selfName && row.selfName !== f.name
          ? h('div', { className: 'k57' }, '他自己填的名字是「' + row.selfName + '」') : null,
        h('div', { className: 'kca' },
          h('button', { className: 'k42 k11', disabled: st.busy, onClick: () => onSaveRoster(row.sid, f) }, '保存'),
          h('button', { className: 'k42', disabled: st.busy, onClick: () => onSaveRoster(row.sid, { remove: true }) }, '从名册移除'),
          h('button', { className: 'k42', onClick: () => set({ rosterEdit: null }) }, '取消')))
    }

    function Students({ st, set, onOpenStudent, onEditRoster, onSaveRoster }) {
      const list = st.roster || []
      if (!st.rosterLoaded) return h('div', { className: 'k21' }, '学生总表加载中…')
      const d = st.studentDetail
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '学生（' + list.length + ' 人）'),
        h('div', { className: 'kce' },
          bdg('有姓名 ' + list.filter((s) => s.name).length + ' / ' + list.length,
            list.length && list.every((s) => s.name) ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)'),
          bdg('未批改 ' + list.reduce((a, s) => a + (s.ungraded || 0), 0),
            list.some((s) => s.ungraded) ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-bg-layer-1)'),
          bdg('阻塞级 ' + list.reduce((a, s) => a + ((s.severity && s.severity['阻塞']) || 0), 0), 'var(--dsw-alias-state-error-primary)')),
        h('details', { className: 'kcd' },
          h('summary', null, '名字是从哪来的'),
          h('div', { className: 'kd1' }, '显示名优先级：**你的名册 > 学生自报 > 学号**。'
            + '学生端第一次打开面板时会请他填一次学号与姓名（写在他自己那台机器上，不进任何仓库），'
            + '但学生填错、重名、写昵称都很常见，所以名册是最后一关。'),
          h('div', { className: 'kd1' }, '名册文件：' + (st.rosterFile || '学生名册.json')
            + (st.rosterSource ? ('　当前来源：' + st.rosterSource) : ''))),
        h('div', { className: 'kd2' },
          // 左：名册
          h('div', { className: 'kd3' },
            list.length ? list.map((s) => h('div', {
              key: s.sid, className: 'kc7',
              'data-on': d && d.sid === s.sid ? '1' : '0',
            },
              h('div', { className: 'kc8' },
                bdg(s.name || s.sid, s.name ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-warn-primary)'),
                s.name ? h('span', { className: 'k57' }, s.sid) : null,
                s.klass ? bdg(s.klass, 'var(--dsw-alias-bg-layer-1)') : null,
                s.fromRoster ? bdg('名册', 'var(--dsw-alias-state-success-primary)') : bdg('学生自报', 'var(--dsw-alias-bg-layer-1)')),
              h('div', { className: 'kce' },
                bdg('提问 ' + s.asked, 'var(--dsw-alias-bg-layer-1)'),
                s.shared ? bdg('已公开 ' + s.shared, 'var(--dsw-alias-state-success-primary)') : null,
                (s.submissions || []).length ? bdg('提交 ' + s.submissions.length, 'var(--dsw-alias-bg-layer-1)') : null,
                s.ungraded ? bdg('未批改 ' + s.ungraded, 'var(--dsw-alias-state-warn-primary)') : null,
                (s.severity && s.severity['阻塞']) ? bdg('阻塞 ' + s.severity['阻塞'], 'var(--dsw-alias-state-error-primary)') : null,
                s.tokens ? bdg('tokens ' + s.tokens, 'var(--dsw-alias-bg-layer-1)') : null),
              s.note ? h('div', { className: 'kd1' }, s.note) : null,
              h('div', { className: 'kca' },
                h('button', { className: 'k42 k11', onClick: () => onOpenStudent(s.sid) }, '看他的情况'),
                h('button', { className: 'k42', onClick: () => onEditRoster(s) }, s.name ? '改名/备注' : '补姓名'))))
              : h('div', { className: 'k21' }, '还没有学生数据 —— 学生提问或交作业后会自动出现在这里')),
          // 右：某一个人的情况
          h('div', { className: 'kd4' },
            !d ? h('div', { className: 'k21' }, '点左边的「看他的情况」')
              : h('div', null,
                h('div', { className: 'k78' }, d.label || d.sid),
                (d.todo || []).length
                  ? h('div', { className: 'kcb' },
                    h('div', { className: 'k78' }, '这个人需要你做什么'),
                    d.todo.map((t, i) => h('div', { key: i, className: 'kd1' }, '· ' + t)))
                  : h('div', { className: 'kd1' }, '这个人目前没有待你处理的事。'),
                h('div', { className: 'kce' },
                  bdg('提问 ' + (d.items || []).length, 'var(--dsw-alias-bg-layer-1)'),
                  bdg('提交 ' + (d.submissions || []).length, 'var(--dsw-alias-bg-layer-1)'),
                  d.ungraded ? bdg('未批改 ' + d.ungraded, 'var(--dsw-alias-state-warn-primary)') : null,
                  d.tokens ? bdg('tokens ' + d.tokens, 'var(--dsw-alias-bg-layer-1)') : null),
                (d.lessons || []).length ? h('div', null,
                  h('div', { className: 'k64' }, '卡在哪几课'),
                  d.lessons.map((l, i) => h('div', { key: i, className: 'kce' },
                    bdg(l.lesson, 'var(--dsw-alias-brand-primary)'),
                    bdg(l.asked + ' 条', 'var(--dsw-alias-bg-layer-1)'),
                    l.worst ? bdg('最重 ' + l.worst, SEVERITY_COLOR[l.worst] || 'gray') : null,
                    h('span', { className: 'k57' }, Object.keys(l.topics).map((k) => k + '(' + l.topics[k] + ')').join(' · '))))) : null,
                (d.items || []).length ? h('div', null,
                  h('div', { className: 'k64' }, '他的提问'),
                  d.items.slice(0, 40).map((it) => h('div', {
                    key: it.path, className: 'kd9',
                    // 点一条 → 直接跳到那条问答的详情（并把它读出来）。
                    // 这里不要传 s.sid：那是下面 map 的提交项，名字撞了。
                    onClick: () => onOpenStudent(d.sid, it.path),
                  },
                    bdg(it.severity || '中', SEVERITY_COLOR[it.severity] || 'gray'),
                    ' ' + (it.title || '') + (it.lesson ? ('　' + it.lesson) : '')))) : null,
                (d.submissions || []).length ? h('div', null,
                  h('div', { className: 'k64' }, '他的提交'),
                  d.submissions.map((sm, i) => h('div', { key: i, className: 'kd1' },
                    '· ' + sm.name + (sm.graded ? '（已批改）' : '（未批改）')))) : null))),
        st.rosterEdit ? h(RosterEditor, {
          row: list.find((x) => x.sid === st.rosterEdit.sid) || st.rosterEdit,
          st, set, onSaveRoster,
        }) : null)
    }

    /**
     * 教师端的就绪清单 + 「今天要做什么」。
     *
     * 学生端那张卡片解决的是「装完不知道哪里不对」；教师端多一层：
     * **他打开面板时最想知道的不是数字，是先干哪件事。**
     * 所以这里把五个标签页里的计数压成一句话，并给出有序的待办。
     *
     * 三件事刻意分开报，因为它们对应三种完全不同的动作：
     *   · 学生未批改   → 去批改
     *   · 已公开未答复 → 去答复（学生已经在等了）
     *   · 课时缺教案   → 去「教案补全」生成
     * 合成一个「完成度 60%」对老师没有任何用。
     */
    function TeacherReadiness({ st, set }) {
      const r = st.readiness
      if (!r) return null
      const mark = (x) => bdg(x.ok ? '✓' : '缺',
        x.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)')
      const todo = r.todo || []
      const line = todo.length
        ? ('今天：' + todo.join(' · '))
        : '今天没有待处理的事 —— 提问、提交、教案都在此前的状态上'

      // 全部就绪：只留一行待办，不占地方
      if (!r.missing) {
        return h('div', { className: 'kce', style: { margin: '8px 14px 0' } },
          h('span', { className: 'k57' }, '✓ 就绪　'),
          h('span', { className: 'kd1', style: { flex: '1 1 auto' } }, line))
      }
      return h('div', { className: 'kcb', style: { margin: '8px 14px 0' } },
        h('div', { className: 'kc8' },
          bdg('还差 ' + r.missing + ' 件事', 'var(--dsw-alias-state-warn-primary)'),
          h('span', { className: 'k54' }),
          h('button', {
            className: 'k42', onClick: () => set({ readyOpen: !st.readyOpen }),
          }, st.readyOpen ? '收起' : '看要补什么')),
        h('div', { className: 'kd1', style: { marginTop: '4px' } }, line),
        st.readyOpen ? h('div', null,
          (r.items || []).map((x) => h('div', { key: x.key, className: 'kce' },
            mark(x),
            h('span', { className: 'k57' }, x.title + '：' + x.detail),
            x.fix ? h('span', { className: 'k57' }, '　→ ' + x.fix) : null)),
          h('div', { className: 'kd1' }, '这份清单只报**插件真的查过**的东西（文件在不在、字段空不空），'
            + '不做推测 —— 报一条假问题，后面每一条你都会怀疑。')) : null)
    }

    /**
     * 材料归位的**逐条确认表**。
     *
     * 老师拖进来一批文件，这里给出「建议放哪、为什么」，他逐条能改。
     * 为什么不做成「一键自动归位」：判错的后果很具体 —— 文件进了别人家，
     * 而面板照常显示、批改照常跑，**不报错**。这和「页码锚点不能猜」同一个道理。
     *
     * 三条界面规则：
     *   1. 待定的**默认不勾选**。若默认勾上，老师一路点确认就会把认不出的
     *      文件也塞进某个目录 —— 那正是要避免的静默错位。
     *   2. 低置信度的**排在最前面**。老师的时间该花在需要他判断的那些上。
     *   3. 「为什么这么建议」必须显示出来。老师看得到理由，才改得动。
     */
    function MaterialsTable({ st, set, onPlan }) {
      const p = st.matPlan
      const files = st.matFiles || []
      const rows = (p && p.files) || []
      const targets = (p && p.targets) || []
      const modules = (p && p.modules) || []
      const patch = (i, patchObj) => set({
        matPlan: Object.assign({}, p, {
          files: rows.map((x, j) => (j === i ? Object.assign({}, x, patchObj) : x)),
        }),
      })
      const picked = rows.filter((x) => x.selected !== false)

      return h('div', { className: 'kcb' },
        h('div', { className: 'k78' }, '把课程文件放进来'),
        h('div', { className: 'kd1' }, '拖文件夹或 zip 进来，或点下面的按钮选。'
          + '插件会先给一份**建议清单**，你逐条确认后才落盘 —— 它不会自己决定文件去哪。'),
        h(FileDrop, {
          title: '把课程文件夹拖到这里（或选文件夹 / zip）',
          hint: '支持整个课程目录；也支持 zip（服务端会解开）。识别只看文件名与相对路径，不读内容。',
          disabled: st.busy,
          dropKey: 'mat',
          onFiles: (filesIn, rejected) => {
            if (rejected && rejected.length) set({ notice: '这些没读进来：' + rejected.slice(0, 3).join('；') })
            const list = (st.matFiles || []).concat(filesIn.map((f) => ({ relPath: f.relPath, bytes: f.bytes })))
            set({ matFiles: list })
            onPlan(list)
          },
        }),
        st.matFiles && st.matFiles.length
          ? h('div', { className: 'kce' },
            h('span', { className: 'k57' }, '待归位 ' + st.matFiles.length + ' 个文件'),
            h('button', { className: 'k42', onClick: () => set({ matFiles: [], matPlan: null }) }, '清空'))
          : null,

        p ? h('div', null,
          h('div', { className: 'kce' },
            bdg('共 ' + p.total + ' 个', 'var(--dsw-alias-brand-primary)'),
            p.uncertain ? bdg('认不出 ' + p.uncertain + ' 个（默认不勾）', 'var(--dsw-alias-state-warn-primary)') : null,
            h('span', { className: 'k57' }, p.summary)),
          h('div', { className: 'kd1' }, p.note),
          h('div', null, rows.map((x, i) => h('div', { key: x.relPath + i, className: 'kc7', 'data-on': x.selected === false ? '0' : '1' },
            h('div', { className: 'kc8' },
              h('input', {
                type: 'checkbox', checked: x.selected !== false,
                style: { width: 'auto', margin: 0 },
                onChange: (e) => patch(i, { selected: e.target.checked }),
              }),
              bdg(x.confidence >= 1 ? '有把握' : (x.confidence > 0 ? '推测' : '待定'),
                x.confidence >= 1 ? 'var(--dsw-alias-state-success-primary)'
                  : (x.confidence > 0 ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-state-warn-primary)')),
              h('span', { className: 'k57' }, x.relPath)),
            h('div', { className: 'kce' },
              h('span', { className: 'k57' }, '放到'),
              h('select', {
                className: 'kcc', value: x.target,
                onChange: (e) => patch(i, { target: e.target.value, selected: true }),
              }, targets.map((t) => h('option', { key: t.key, value: t.key }, t.title))),
              // 教案 / 代码 / 资源这三类要选模块 —— 不选就没法落盘，
              // 而且插件**不会**替你挑一个（挑错就是文件进了别人家）
              (x.target === 'plans' || x.target === 'code' || x.target === 'res')
                ? h('select', {
                  className: 'kcc', value: x.module || '',
                  onChange: (e) => patch(i, { module: e.target.value }),
                }, [h('option', { key: '__none', value: '' }, '（选模块）')]
                  .concat(modules.map((m) => h('option', { key: m, value: m }, m))))
                : null,
              h('span', { className: 'k57' }, '· ' + x.why)))))) : null)
    }

    // ── 面板 ──
    function Panel() {
      const init = {
        view: 'questions', mode: 'region', chapter: '第一章', slideIndex: 0, zoom: 1,
        // 课时脉络侧栏是否展开（与学生端同一个键、同一种行为）
        rail: true,
        items: [], students: [], filterStudent: '', filterScope: 'all', filterTopic: '',
        // 教师默认只看学生主动公开过的条目（见教师端 host threads 的注释）；
        // showAll 是审计视图开关，hiddenCount 让界面能说清「还有多少条没公开」。
        showAll: false, hiddenCount: 0,
        minStudents: '2', common: [], subs: [], subStudents: [], subStudent: '',
        auditTitle: '', auditSummary: '', auditNote: '', answerText: '', subText: '', subName: '', busy: false,
        // 教案补全
        outline: null, planCatalog: null, drafts: [], draftOpen: null, draftText: '',
        genLesson: 0, rebuildResult: null,
        // 页码编辑器：null = 收起；否则 {lesson, chapter, from, to}
        anchorEdit: null,
        // 学生页
        roster: [], rosterLoaded: false, rosterFile: '', rosterSource: '',
        studentDetail: null, rosterEdit: null,
        // 新动作在旧宿主上不存在时的「软失败」：不挂红条，只记原因。
        // 红条会出现在**每一页**上（包括完全正常的提问页），看起来像整个面板坏了。
        rosterMissing: '', planMissing: '',
        // 就绪清单与「今天要做什么」：readyOpen 是详细清单的展开状态
        readiness: null, readyOpen: false,
        // 材料归位：待归位的文件清单 + 建议结果
        matFiles: [], matPlan: null,
        // 发布页：仓库状态（repo.status 的返回）、建仓表单、建仓结果。
        // repoStatus 初值是 null（还没读），三个视图块都要能吃 null —— 一块崩了
        // 不能让整页红屏，而「刚打开、数据还没到」正是最常见的 null 场景。
        repoStatus: null, repoInit: null,
        repoForm: { owner: '', name: '', token: '', description: '' },
      }
      const pair = React.useState(init)
      const st = pair[0] || init
      const setSt = pair[1]
      /**
       * ⚠️ 合并式 setter，理由同学生端：
       * React 的 setState 是**替换**语义 —— setSt({ items }) 会把上面 16 个
       * 字段全冲掉（包括 view:'questions'），表现为请求成功但界面永远停在
       * 初始值、按钮点不动。包一层之后，下面的 set({...}) 调用点不用改。
       */
      const set = function (patch) {
        setSt(function (prev) {
          const base = (prev && typeof prev === 'object') ? prev : init
          if (typeof patch === 'function') return Object.assign({}, base, patch(base))
          return Object.assign({}, base, patch)
        })
      }
      // 见学生端同处注释：供校验脚本驱动合并语义的回归测试。
      if (typeof globalThis !== 'undefined') globalThis.__cip_lastSet = set
      // 最新状态的引用。异步回调（loadThreads / toggleShowAll）要从它读当前值，
      // 不能闭包捕获 st —— 那会拿到渲染那一刻的旧值。
      const stRef = React.useRef(st); stRef.current = st
      const loadThreads = React.useCallback(async (showAll) => {
        const all = showAll === undefined ? !!(stRef.current && stRef.current.showAll) : !!showAll
        const r = await api('threads', { onlyShared: !all })
        set({ items: r.items || [], students: r.students || [], hiddenCount: r.hidden || 0 })
      }, [])
      // 切换「只看已公开 / 全部条目」：立刻重新拉一次，否则要等下次刷新才变
      const toggleShowAll = React.useCallback(async () => {
        const cur = stRef.current || {}
        const next = !cur.showAll
        set({ showAll: next })
        await loadThreads(next)
      }, [loadThreads])
      const loadCommon = React.useCallback(async (min) => {
        const r = await api('common', { minStudents: Number(min || 2) })
        set({ common: r.groups || [] })
      }, [])
      const loadSubs = React.useCallback(async () => {
        const r = await api('submissions', {})
        set({ subs: r.files || [], subStudents: r.students || [] })
      }, [])
      // ── 教案补全：体检 + 草稿清单一起拉（体检要读课件，慢一点；草稿很快）──
      const loadPlans = React.useCallback(async () => {
        try {
          set({ planCatalog: await api('plan.catalog', {}) })
          set({ outline: await api('outline.status', {}) })
          const d = await api('plan.drafts', {})
          set({ drafts: d.drafts || [] })
        } catch (err) {
          // ⚠️ 走 notice 而不是 error：教案体检是**新增**动作，旧宿主上没有它。
          //    用 error 的话，红条会挂在每一页上（包括完全正常的提问页），
          //    看起来像整个面板坏了 —— 而其实只是没重启。踩过一次。
          set({ planMissing: (err && err.message) || String(err), notice: '「教案补全」暂时不可用（多半是宿主半区没重启），其余功能不受影响。' })
        }
      }, [])
      const onGen = React.useCallback(async (lesson) => {
        set({ busy: true, genLesson: lesson, error: '', notice: '' })
        try {
          const r = await api('plan.draft', { lesson })
          set({
            busy: false, genLesson: 0,
            notice: '已生成课时' + lesson + ' 的草稿' + ((r.missing || []).length ? ('；模型自报缺 ' + r.missing.join('、')) : '')
              + ' · tokens in/out ' + ((r.usage && r.usage.inputTokens) || 0) + '/' + ((r.usage && r.usage.outputTokens) || 0),
          })
          await loadPlans()
          if (r.draft) {
            const full = await api('plan.read', { lesson })
            const row = ((stRef.current.outline || { lessons: [] }).lessons || []).find((x) => Number(x.no) === Number(lesson))
            set({
              draftOpen: Object.assign({ lesson, target: row ? (row.module + '\\详细教案\\') : '' }, full.meta || {}),
              draftText: full.text,
              // 生成完先给**预览**，不是先给一个 Markdown 输入框 ——
              // 老师要判断的是「这份能不能用」，不是「这段源码写得好不好」。
              draftTab: 'preview',
              draftMissing: missingSectionsOf(full.text),
              draftTitle: (row && row.title) || '',
            })
            scrollToDraft()
          }
        } catch (err) { set({ busy: false, genLesson: 0, error: '生成失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onOpenDraft = React.useCallback(async (lesson) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('plan.read', { lesson })
          const row = ((stRef.current.outline || { lessons: [] }).lessons || []).find((x) => Number(x.no) === Number(lesson))
          set({
            busy: false,
            draftOpen: Object.assign({ lesson, target: row ? (row.module + '\\详细教案\\') : '' }, r.meta || {}),
            draftText: r.text,
            draftTab: 'preview',
            draftMissing: missingSectionsOf(r.text),
            draftTitle: (r.meta && r.meta.title) || (row && row.title) || '',
          })
          scrollToDraft()
        } catch (err) { set({ busy: false, error: '读草稿失败：' + ((err && err.message) || String(err)) }) }
      }, [])
      const onSaveDraft = React.useCallback(async (lesson, text) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('plan.save', { lesson, text })
          set({
            busy: false,
            notice: '草稿已保存（' + r.chars + ' 字符）' + ((r.missingSections || []).length ? ('；仍缺 ' + r.missingSections.join('、')) : '；五节齐全'),
            draftMissing: r.missingSections || [],
          })
          await loadPlans()
        } catch (err) { set({ busy: false, error: '保存失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onAccept = React.useCallback(async (lesson) => {
        set({ busy: true, error: '', notice: '' })
        try {
          let r
          try {
            r = await api('plan.accept', { lesson })
          } catch (e) {
            // 「正式教案已存在」要走覆盖确认。用一次显式确认，而不是默默覆盖 ——
            // 教案是批改的基准，冲掉旧版必须由人按一下。
            const msg = (e && e.message) || ''
            if (msg.indexOf('已存在') < 0) throw e
            const gRoot = (typeof globalThis !== 'undefined') ? globalThis : null
            const ok = gRoot && typeof gRoot.confirm === 'function'
              ? gRoot.confirm(msg + '\n\n覆盖前会把旧教案备份到 教案草稿\\_历史\\ 里，确认覆盖？') : true
            if (!ok) { set({ busy: false, notice: '已取消（没有覆盖正式教案）' }); return }
            r = await api('plan.accept', { lesson, overwrite: true })
          }
          set({
            busy: false,
            notice: '课时' + lesson + ' 已采纳 → ' + r.path
              + (r.backedUp ? ('（旧教案备份到 ' + r.backedUp + '）') : '')
              + (r.missingCleared ? '；该模块教案已补齐，索引里的 missingPlans 已清除' : ''),
          })
          await loadPlans()
          set({ tree: (await api('tree', {})).tree })
        } catch (err) { set({ busy: false, error: '采纳失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onReject = React.useCallback(async (lesson) => {
        set({ busy: true, error: '' })
        try {
          await api('plan.reject', { lesson })
          set({ busy: false, notice: '课时' + lesson + ' 的草稿标为「不采纳」（没有删，过两天想捡回来还在）' })
          await loadPlans()
        } catch (err) { set({ busy: false, error: '操作失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onDel = React.useCallback(async (lesson) => {
        set({ busy: true, error: '' })
        try {
          await api('plan.delete', { lesson })
          set({ busy: false, notice: '已删掉课时' + lesson + ' 的草稿', draftOpen: null, draftText: '' })
          await loadPlans()
        } catch (err) { set({ busy: false, error: '删除失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onRebuild = React.useCallback(async () => {
        set({ busy: true, error: '' })
        try {
          const r = await api('index.rebuild', {})
          set({ busy: false, rebuildResult: r, notice: r.note })
          await loadPlans()
          set({ tree: (await api('tree', {})).tree })
        } catch (err) { set({ busy: false, error: '重建索引失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onSetAnchor = React.useCallback(async (lesson, chapter, from, to) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('anchor.set', { lesson, chapter, from, to })
          set({ busy: false, notice: '课时' + lesson + ' 的课件页码已确认为 ' + chapter + ' ' + from + '–' + to + '（写进锚点文件，之后不再推断）' })
          await loadPlans()
          return r
        } catch (err) { set({ busy: false, error: '保存锚点失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onModel = React.useCallback(async (provider, model) => {
        set({ busy: true, error: '' })
        try {
          await api('plan.model', { provider, model })
          set({ busy: false, planCatalog: await api('plan.catalog', {}), notice: provider ? ('教案生成改用 ' + provider + '/' + model) : '教案生成改回跟随会话默认' })
        } catch (err) { set({ busy: false, error: '保存模型选择失败：' + ((err && err.message) || String(err)) }) }
      }, [])

      // ── 继续改：一轮一轮改教案，像学生追问那样 ──
      const onRevise = React.useCallback(async (lesson) => {
        const cur = stRef.current || {}
        const picks = cur.revisePicks || []
        const instruction = oneLine(cur.reviseText || '')
        if (!instruction && !picks.length) { set({ error: '这一轮是空的：写一句要改什么，或者在课件上圈一块内容' }); return }
        set({ busy: true, error: '', notice: '' })
        try {
          const r = await api('plan.revise', {
            lesson, instruction,
            evidence: picks.map((p) => ({
              chapter: p.chapter, page: p.page, kind: p.kind, text: p.text, note: p.note || '',
            })),
            images: picks.map((p) => p.dataUrl).filter(Boolean),
          })
          set({
            busy: false, draftText: r.text, reviseText: '', revisePicks: [], turns: r.turn ? undefined : undefined,
            draftMissing: r.missing || [], notice: r.note,
          })
          // 轮次单独拉一次：它与草稿元数据一起存在宿主的 sidecar 里
          const tt = await api('plan.turns', { lesson })
          set({ turns: tt.turns || [] })
          await loadPlans()
        } catch (err) { set({ busy: false, error: '改稿失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])
      const onRevert = React.useCallback(async (lesson, keepTurns) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('plan.revert', { lesson, keepTurns })
          set({ busy: false, draftText: r.text, notice: r.note, revisePicks: [] })
          const tt = await api('plan.turns', { lesson })
          set({ turns: tt.turns || [] })
          await loadPlans()
        } catch (err) { set({ busy: false, error: '退回失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])

      // ── 材料归位：只出建议，不落盘 ──
      const onPlan = React.useCallback(async (list) => {
        const files = list || (stRef.current.matFiles || [])
        if (!files.length) return
        set({ busy: true, error: '' })
        try {
          const r = await api('materials.plan', { files: files })
          set({ busy: false, matPlan: r })
        } catch (err) { set({ busy: false, error: '识别文件失败：' + ((err && err.message) || String(err)) }) }
      }, [])

      // ── 课件窗口：按需拉某一章的课件数据 ──
      // 只在打开页码编辑器/课件预览时才拉 —— 三个章节的 JSON 合计 250 KB+，
      // 不该让「每天都要看的提问页」为它买单。
      const loadPeek = React.useCallback(async (chapter) => {
        if (!chapter) return
        set({ peekBusy: true, peekChapter: chapter, peekSlides: null, peekIndex: 0 })
        try {
          const d = await api('slides', { chapter })
          // 打开时先跳到这一课时范围的起始页，而不是永远停在第 1 页 ——
          // 「我在哪一页」本身就是老师要确认的东西。
          const a = stRef.current.anchorEdit || {}
          const want = (a.chapter === chapter && Number(a.from) > 0) ? Number(a.from) - 1 : 0
          set({ peekBusy: false, peekSlides: d, peekIndex: Math.max(0, want) })
        } catch (err) {
          set({ peekBusy: false, peekSlides: null, error: '课件加载失败：' + ((err && err.message) || String(err)) })
        }
      }, [])
      // 「这一页作起始 / 作结束」：点页面就填好页码，不必手输数字
      const onSetRange = React.useCallback((lesson, patchObj) => {
        const cur = stRef.current.anchorEdit || {}
        set({ anchorEdit: Object.assign({}, cur, { lesson: lesson }, patchObj) })
      }, [])

      // ── 页码编辑：点「改页码」就地展开一个能填的表单 ──
      // 原来这里只是把推断出来的值原样再提交一次 —— 按钮点了有反应，但没法改，
      // 等于没有这个功能。老师要的是「我自己看 PPT 定页码」。
      const onOpenAnchor = React.useCallback((row, editing) => {
        if (editing) { set({ anchorEdit: null }); return }
        const s = row.slides || {}
        const chapters = (stRef.current.info && stRef.current.info.chapters) || ['第一章']
        set({
          anchorEdit: {
            lesson: row.no,
            chapter: s.chapter || chapters[0],
            from: s.from || '',
            to: s.to || '',
          },
        })
      }, [])
      const onSaveAnchor = React.useCallback(async (lesson) => {
        const cur = stRef.current.anchorEdit || {}
        const chapter = String(cur.chapter || '')
        const from = Number(cur.from)
        const to = Number(cur.to) || from
        if (!chapter || !(from > 0)) {
          set({ error: '页码要填「第几章、第几页起」——两个都不能空' })
          return
        }
        if (to < from) { set({ error: '结束页比起始页小：' + from + ' → ' + to }); return }
        const r = await onSetAnchor(lesson, chapter, from, to)
        if (r && r.ok) set({ anchorEdit: null })
      }, [onSetAnchor])
      const onClearAnchor = React.useCallback(async (lesson) => {
        set({ busy: true, error: '' })
        try {
          await api('anchor.set', { lesson, clear: true })
          set({ busy: false, anchorEdit: null, notice: '课时' + lesson + ' 的页码锚点已清除，回到自动推断' })
          await loadPlans()
        } catch (err) { set({ busy: false, error: '清除锚点失败：' + ((err && err.message) || String(err)) }) }
      }, [loadPlans])

      // ── 学生：名册 + 个人详情 ──
      // 收/展课时脉络。**与学生端逐字同一种行为** —— 同一个 state 键名、
      // 同一个箭头方向、同一个提示文案，这样老师在两边看到的是一致的。
      const toggleRail = React.useCallback(() => {
        const cur = stRef.current || {}
        set({ rail: cur.rail === false })
      }, [])

      const loadStudents = React.useCallback(async (sid) => {
        try {
          const r = await api('roster', {})
          set({
            roster: r.students || [], rosterLoaded: true,
            rosterFile: r.rosterFile || '学生名册.json', rosterSource: r.rosterSource || '',
          })
          const want = sid || (stRef.current.studentDetail && stRef.current.studentDetail.sid)
          if (want) set({ studentDetail: await api('student.detail', { sid: want }) })
        } catch (err) {
          set({ rosterLoaded: true, rosterMissing: (err && err.message) || String(err), roster: [] })
        }
      }, [])
      const openStudent = React.useCallback(async (sid, threadPath) => {
        set({ busy: true, error: '' })
        try {
          if (threadPath) {
            const t = await api('thread', { path: threadPath })
            set({ busy: false, studentDetail: await api('student.detail', { sid }), thread: t, selPath: threadPath, view: 'detail' })
            return
          }
          set({ busy: false, studentDetail: await api('student.detail', { sid }) })
        } catch (err) { set({ busy: false, error: '读取学生详情失败：' + ((err && err.message) || String(err)) }) }
      }, [])
      const onEditRoster = React.useCallback((row) => {
        set({
          rosterEdit: {
            sid: row.sid,
            name: (row.fromRoster ? row.name : '') || row.name || '',
            klass: row.klass || '',
            note: row.note || '',
          },
        })
      }, [])
      const onSaveRoster = React.useCallback(async (sid, form) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('roster.save', Object.assign({ sid }, form))
          set({ busy: false, rosterEdit: null, notice: r.removed ? ('已把 ' + sid + ' 移出名册') : ('已记住：' + r.label) })
          await loadStudents(sid)
          await loadThreads()
          await loadSubs()
        } catch (err) { set({ busy: false, error: '保存名册失败：' + ((err && err.message) || String(err)) }) }
      }, [loadStudents, loadThreads, loadSubs])

      // ── 换课（热切换，不重启）──
      const onUseCourse = React.useCallback(async (code) => {
        set({ busy: true, error: '', notice: '' })
        try {
          const r = await api('course.use', { code })
          // 换课等于换了整个数据面：所有列表都要重拉，缓存也要丢
          set({ busy: false, notice: r.note, studentDetail: null, rosterEdit: null, thread: null, selPath: '', anchorEdit: null })
          await loadAll()
        } catch (err) { set({ busy: false, error: '切课失败：' + ((err && err.message) || String(err)) }) }
      }, [])
      const loadAll = React.useCallback(async () => {
        try {
          const info = await api('info', {})
          set({ info })
          set({ tree: (await api('tree', {})).tree })
          const ch = (info.chapters && info.chapters[0]) || '第一章'
          set({ chapter: ch, slides: await api('slides', { chapter: ch }) })
          await loadThreads()
          await loadCommon('2')
          await loadSubs()
          await loadPlans()
          await loadStudents()
          // 就绪清单：**新动作**，旧宿主上没有。单独 try —— 新加的动作不该有能力
          // 把已经能用的面板弄坏（红条会挂在每一页上，看起来像整个面板坏了）。
          try { set({ readiness: await api('readiness', {}) }) } catch (e) { /* 没它也照常用 */ }
          set({ digest: await api('digest', {}) })
          set({ staged: await api('staged', {}) })
        } catch (err) { set({ error: '加载失败：' + ((err && err.message) || String(err)) }) }
      }, [loadThreads, loadCommon, loadSubs, loadPlans, loadStudents])
      const openThread = React.useCallback(async (path) => {
        try {
          const t = await api('thread', { path })
          set({ thread: t, selPath: path, view: 'detail', auditTitle: '', auditSummary: '', auditNote: '', answerText: '' })
        } catch (err) { set({ error: '读取失败：' + ((err && err.message) || String(err)) }) }
      }, [])
      const onAudit = React.useCallback(async (path, decision) => {
        const cur = st
        set({ busy: true, error: '' })
        try {
          const r = await api('audit', {
            path, decision,
            title: cur.auditTitle || undefined,
            summary: cur.auditSummary || undefined,
            note: cur.auditNote || undefined,
          })
          set({ busy: false, notice: decision === 'shared' ? ('已公开：' + r.publicPath) : '已标为只答本人' })
          await openThread(path)
          await loadThreads(); await loadCommon(cur.minStudents); set({ staged: await api('staged', {}) })
        } catch (err) { set({ busy: false, error: '审计失败：' + ((err && err.message) || String(err)) }) }
      }, [st, openThread, loadThreads, loadCommon])
      const onAnswer = React.useCallback(async (path, text) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('answer', { path, text })
          set({ busy: false, answerText: '', notice: '已答复' + (r.syncedPublic ? '（公共面那份也同步了）' : '') + '，该学生在「我的提问」里会看到' })
          await openThread(path)
          await loadThreads()
        } catch (err) { set({ busy: false, error: '答复失败：' + ((err && err.message) || String(err)) }) }
      }, [openThread, loadThreads])
      const onPublish = React.useCallback(async (mode) => {
        set({ busy: true, error: '', publishResult: null })
        try {
          const r = await api('publish', { mode })
          set({ busy: false, publishResult: r, notice: r.ok ? ('发布工具执行成功（' + mode + '）') : '发布工具返回失败，看下面的输出' })
          if (r.ok && mode === 'publish') set({ staged: await api('staged', {}) })
        } catch (err) { set({ busy: false, error: '发布失败：' + ((err && err.message) || String(err)) }) }
      }, [])

      // ── 发布页：仓库状态（只读动作）──
      /**
       * 拉一次仓库状态。
       *
       * 为什么要带上表单里的 owner / name：宿主要用它们**现拼**那几条「照抄即可」
       * 的命令。老师改完 owner 之后，折叠块里必须能跟着变 —— 否则他照抄下来推的是
       * 别人家的仓库，而且不报错（git 只会回一个 403/404，看起来像网络问题）。
       *
       * 什么时候重读：① 第一次切到这一页 ② 状态卡上点「重新读一次」
       * ③ 建仓成功之后自动重读。**不是每敲一个字就发一次请求** ——
       * 那种「边打字边刷新」在有网络动作的页面上很容易变成难以复现的竞态
       * （返回顺序不保证，后到的旧响应会把新状态覆盖回去）。
       *
       * 顺带填表单默认值：仓名用宿主折好的 slug（英文小写），owner 用仓库里
       * 已经连着的那个，简介用课程名 —— 「仓名 ASCII、人话放简介」这条规则
       * 由界面替老师执行，而不是指望他记得。
       */
      const loadRepo = React.useCallback(async (override) => {
        const cur = stRef.current || {}
        const f = cur.repoForm || {}
        const o = override || {}
        try {
          const rs = await api('repo.status', {
            owner: o.owner !== undefined ? o.owner : f.owner,
            name: o.name !== undefined ? o.name : f.name,
            privateName: o.privateName !== undefined ? o.privateName : f.privateName,
          })
          const patch = { repoStatus: rs }
          // 只在**第一次**读到状态时填默认值：老师自己清空某个框之后，
          // 再刷新不能把它又填回去（那样他会以为框清不掉）。
          if (!cur.repoStatus) {
            patch.repoForm = Object.assign({}, f, {
              name: f.name || rs.slug || '',
              owner: f.owner || ((rs.publicRepo && rs.publicRepo.owner) || ''),
              description: f.description || rs.courseName || '',
            })
          }
          set(patch)
        } catch (err) {
          // ⚠️ 走 notice 而不是 error：repo.status 是**新增**动作，旧宿主上没有它。
          //    用 error 的话红条会挂在每一页上（包括完全正常的提问页），
          //    看起来像整个面板坏了 —— 而其实只是宿主半区没重启。踩过一次（教案页）。
          set({ repoStatus: null, notice: '「归档发布」里的仓库状态暂时读不到（多半是宿主半区没重启），其余功能不受影响。' })
        }
      }, [])
      /**
       * 建仓（本机准备，不推送）。
       *
       * ⚠️ 失败时**不清 Token 框**：清掉的话老师得回 GitHub 重新生成一个，
       *    而失败多半只是 owner 写错这种小事。Token 只在这台机器的内存里过一趟。
       */
      const onRepoInit = React.useCallback(async () => {
        const f = (stRef.current && stRef.current.repoForm) || {}
        set({ busy: true, error: '', notice: '' })
        try {
          const r = await api('repo.init', {
            owner: f.owner, name: f.name, token: f.token, description: f.description,
          })
          set({ busy: false, repoInit: r, notice: (r && r.note) || '本机已经准备好了（没有替你推送）' })
          // 立刻重读状态：磁盘上到底变成了什么样，由**重新读一遍**说了算，
          // 不能拿刚才那几条命令的返回值当结论。
          await loadRepo()
        } catch (err) {
          set({ busy: false, error: '建仓失败：' + ((err && err.message) || String(err)) })
        }
      }, [loadRepo])
      const onBatch = React.useCallback(async (paths, decision) => {
        set({ busy: true, error: '' })
        try {
          const r = await api('audit.batch', { paths, decision })
          set({ busy: false, notice: '批量完成 ' + r.done + ' / ' + paths.length })
          await loadThreads(); await loadCommon(String(st.minStudents)); set({ staged: await api('staged', {}) })
        } catch (err) { set({ busy: false, error: '批量审计失败：' + ((err && err.message) || String(err)) }) }
      }, [st.minStudents, loadThreads, loadCommon])
      const onReadSub = React.useCallback(async (path) => {
        try {
          const r = await api('submission.read', { path })
          set({ subText: r.text, subName: r.name })
        } catch (err) { set({ error: '读取失败：' + ((err && err.message) || String(err)) }) }
      }, [])

      React.useEffect(() => { loadAll() }, [loadAll])
      React.useEffect(() => { loadKatex(CFG.katex, { onDone: (ok, err) => set(ok ? { katexReady: true } : { katexError: err || '未知' }) }) }, [])
      React.useEffect(() => { if (st.view === 'common') loadCommon(st.minStudents) }, [st.minStudents, st.view, loadCommon])
      // 首次切到「教案补全」时才去读课件做体检 —— 那一趟要解三个章节的
      // JSON（合计 250 KB+），不该拖慢每天都要看的提问页。
      React.useEffect(() => { if (st.view === 'plan' && !stRef.current.outline) loadPlans() }, [st.view, loadPlans])
      // 仓库状态同理：切到「归档发布」时才读（读的是 .git/config，不 spawn git，
      // 所以它很便宜；但仍然没必要让每天都要看的提问页为它买单）。
      React.useEffect(() => { if (st.view === 'publish' && !stRef.current.repoStatus) loadRepo() }, [st.view, loadRepo])

      const views = [
        { id: 'questions', label: '提问与审计' },
        { id: 'common', label: '共性问题' },
        // 「学生」放在最前：老师最先想知道的是「这一班谁需要我管」，
        // 而「谁提问的」原来那一栏写的是 Administrator（机器用户名）。
        { id: 'students', label: '学生' },
        { id: 'submissions', label: '学生提交' },
        { id: 'digest', label: '课堂汇总' },
        // 教案补全单独一页，不并进「学生提交」：
        // 它是批量的、一次性的写作动作（生成 → 审 → 采纳），
        // 和日常答疑/批改不是同一种操作，混在一起会让那一页越来越重。
        { id: 'plan', label: '教案补全' },
        { id: 'publish', label: '归档发布' },
      ]
      const c = st.info && st.info.counts ? st.info.counts : {}
      const course = (st.info && st.info.course) || null
      const avail = (course && course.available) || []
      return h('div', { className: 'k22' },
        h('div', { className: 'k23' },
          h('div', null,
            h('div', { className: 'k9a' },
              h('div', { className: 'k10' }, '至圣先师鼹鼠精 · 教师端'),
              h('span', { className: 'k9b', 'data-role': 'teacher', title: '教师端：审计、归档、发布不花额度；只有「教案补全」里的生成会调用模型' }, '教师'),
              st.info && st.info.teacher ? h('span', { className: 'k9c' }, st.info.teacher) : null,
              // ── 当前课程 ──────────────────────────────────────
              // 老师同时教几门课时，「我在看哪一门」必须一眼可见 ——
              // 否则很容易把 A 班的问题池当成 B 班的，而这种错自己发现不了。
              // 多于一门课时它还是个下拉框：切换是**热切换**，不用重启
              // （换的是私有数据那一半，课件与教案是共享内容，不动）。
              avail.length > 1
                ? h('select', {
                  className: 'kcc', style: { maxWidth: '200px' },
                  value: (course && course.code) || '',
                  title: '切换课程：换的是提问、作业、名册这些私有数据；课件与教案是共享内容，不受影响。',
                  onChange: (e) => onUseCourse(e.target.value),
                }, [h('option', { key: '__root', value: '' }, '（根目录即课程）')]
                  .concat(avail.map((a) => h('option', { key: a.code, value: a.code },
                    a.code + (a.title ? ('　' + a.title) : '')))))
                : h('span', { className: 'k9c', title: course ? ('课程目录：' + course.dir) : '' },
                  course ? ('课程：' + (course.title || course.code || '未命名') + (course.code ? ('（' + course.code + '）') : '')) : '')),
            h('div', { className: 'k41' }, st.info
              ? ('提问 ' + (c.items || 0) + ' 条 · 学生 ' + (c.students || 0) + ' 人'
                + (c.named !== undefined ? ('（有姓名 ' + c.named + '）') : '')
                + ' · 提交 ' + (c.submissions || 0) + ' 份 · 已公开 ' + ((c.byScope && c.byScope.public) || 0) + ' 条')
              : '加载中…')),
          h('div', { className: 'k54' }),
          h('div', { className: 'k24' }, views.map((v) => h('span', {
            key: v.id, className: 'k43', 'data-on': (st.view === v.id || (v.id === 'questions' && st.view === 'detail')) ? '1' : '0',
            onClick: () => set({ view: v.id }),
          }, v.label))),
          h('button', { className: 'k42', disabled: st.busy, onClick: loadAll }, st.busy ? '处理中…' : '刷新')),
        // 就绪清单 + 今天要做什么。放在最上面 —— 老师打开面板最想知道的是
        // 「现在先干哪件事」，而不是先去五个标签页里自己拼数字。
        h(TeacherReadiness, { st, set }),
        st.error ? h('div', { className: 'k52 k53', style: { margin: '8px 14px 0' } }, st.error) : null,
        st.notice ? h('div', { className: 'k52 k62', style: { margin: '8px 14px 0' } }, st.notice) : null,
        h('div', { className: 'k25' },
          // 课时脉络侧栏：**与学生端同一个类、同一种交互**（点标题栏收起成一条竖标签）。
          // 不收起的话它会一直占着 200 多像素，而「教案补全」那一页的内容
          // （课件窗口、草稿预览）恰恰是最需要横向空间的。
          h('div', { className: 'k86 k44', 'data-open': st.rail === false ? '0' : '1' },
            h('div', {
              className: 'k87', onClick: toggleRail,
              title: st.rail === false ? '展开课时脉络' : '收起课时脉络（折叠成一条竖标签）',
            },
              h('span', { className: 'k89' }, st.rail === false ? '»' : '«'),
              h('span', { className: 'k88' }, '课时脉络')),
            st.rail === false ? null : h('div', { className: 'k8a' },
              h('div', { className: 'k64' }, '章节'),
              h('div', { className: 'k70' }, ((st.info && st.info.chapters) || ['第一章']).map((ch) => h('span', {
                key: ch, className: 'k71', 'data-on': st.chapter === ch ? '1' : '0',
                onClick: async () => set({ chapter: ch, slides: await api('slides', { chapter: ch }) }),
              }, ch))),
              h('div', { className: 'k64' }, '课时脉络'),
              h('div', { className: 'k1' }, st.tree ? h(Fishbone, { tree: st.tree, selected: 0, onPick: () => {} })
                : h('div', { className: 'k21' }, '索引加载中…')))),
          h('div', { className: 'k27' },
            st.view === 'questions' ? h(QuestionList, { st, set, onOpen: openThread, onToggleAll: toggleShowAll }) : null,
            st.view === 'detail' ? h(ThreadDetail, { st, set, onAudit, onAnswer }) : null,
            st.view === 'common' ? h(Common, { st, set, onBatch }) : null,
            st.view === 'students' ? h(PanelBoundary, { label: '学生' },
              h(Students, { st, set, onOpenStudent: openStudent, onEditRoster, onSaveRoster })) : null,
            st.view === 'submissions' ? h(Submissions, { st, set, onRead: onReadSub }) : null,
            st.view === 'digest' ? h(Digest, { st }) : null,
            st.view === 'publish' ? h(PanelBoundary, { label: '归档发布' },
              h(Publish, {
                st, set,
                onRefresh: async () => set({ staged: await api('staged', {}) }),
                onPublish, onPlan,
                // 仓库那三块的两个动作：读状态（只读）、本机建仓（不推送）
                onRepoStatus: loadRepo, onRepoInit,
              })) : null,
            // 每个视图各自一个错误边界：一个视图崩了不该把整页变成红屏
            // （学生端踩过：一个视图调错函数，整块面板全红）。
            st.view === 'plan' ? h(PanelBoundary, { label: '教案补全' },
              h(PlanPage, {
                st, set, onGen, onOpenDraft, onAccept, onReject, onDel, onSaveDraft,
                onRebuild, onOpenAnchor, onSaveAnchor, onClearAnchor, onModel,
                // 课件窗口：翻页看 PPT、点页定范围
                onPeekChapter: loadPeek, onSetRange: onSetRange,
                // 继续改（对话）：这两个**漏过一次**，症状是「点『让模型改这一轮』
                // 没反应」。原因有两层，两层都要记着：
                //   一是 RevisePanel 的 onClick 里 `onRevise(lesson)` 抛 TypeError；
                //   二是**事件处理器里的异常不被 React 错误边界捕获** ——
                //      所以既不弹红条也不白屏，只是按钮点了像没点。
                // 构建全绿、渲染断言也全过，因为两者都不点按钮。
                onRevise: onRevise, onRevert: onRevert,
              })) : null)))
    }

    /**
     * 面板错误边界：把**渲染期异常**画在面板位置上，而不是只丢进控制台。
     * 必须用 class + getDerivedStateFromError —— try/catch 包住 h(Panel) 是
     * 无效的，那只是创建元素，React 之后才在自己的渲染阶段调用 Panel。
     */
    const PanelBoundary = (function () {
      const Base = (React && React.Component) || function () { }
      function Boundary(props) { Base.call(this, props); this.state = { err: null } }
      Boundary.prototype = Object.create(Base.prototype || Object.prototype)
      Boundary.prototype.constructor = Boundary
      Boundary.getDerivedStateFromError = function (err) { return { err: err } }
      Boundary.prototype.componentDidCatch = function (err, info) {
        console.error('[cip-tea] 面板渲染异常', err, info)
      }
      Boundary.prototype.render = function () {
        if (!this.state || !this.state.err) return this.props.children
        const e = this.state.err
        const where = (this.props && this.props.label) ? ('（' + this.props.label + '）') : ''
        return h('div', { style: { padding: '14px', color: '#ef5350', fontFamily: 'Consolas,monospace', fontSize: '12.5px', lineHeight: '1.6' } },
          h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '至圣先师鼹鼠精（教师端）渲染失败' + where),
          h('div', { style: { color: '#ffcc80' } }, String((e && e.message) || e)),
          h('pre', { style: { whiteSpace: 'pre-wrap', color: '#b0bec5', marginTop: '8px' } },
            String((e && e.stack) || '').split('\n').slice(0, 14).join('\n')),
          h('div', { style: { color: '#888', marginTop: '10px' } }, '把上面这段截图发给老师即可定位。'))
      }
      return Boundary
    })()

    const inject = ['slots', 'timer']
    function apply(ctx) {
      const disposers = []
      ensureCss(CFG.css, CFG.cssId)
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 42, label: '至圣先师鼹鼠精（教师）',
        }, (props) => h(TeaIcon, props))))
      } catch (error) { console.error('[cip-tea] 侧栏注册抛错', error) }
      try {
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        },
        // ⚠️ 契约：渲染回调必须**返回 React 元素**。
        //   正确 h(PanelBoundary, null, h(Panel)) —— h(Panel) 只创建元素；
        //   错误 h(PanelBoundary, null, h(Panel, {})) —— 把 Panel 当普通函数调用，
        //        hook 不绑定渲染上下文，useState 拿不到状态：请求全成功、
        //        界面停在初始值、按钮点不动。对照官方 @dsh-market/plugin：
        //        () => createElement(Boundary, ..., createElement(MarketPanel, ...))
        () => h(PanelBoundary, null, h(Panel)))))
      } catch (error) { console.error('[cip-tea] 主面板注册抛错', error) }
      ctx.effect(() => () => {
        for (const d of disposers) { try { d() } catch (error) { console.error('[cip-tea] dispose failed', error) } }
      }, 'course-teacher cleanup')
      console.log('[cip-tea] client apply 完毕（v1）')
    }

    exports.name = 'course-panel-teacher'
    exports.inject = inject
    exports.apply = apply
    // 见学生端同处注释：供校验脚本驱动组件、验证 set 的合并语义。
    exports.__components = {
      Panel: Panel,
      // 两个纯函数给校验脚本用：框选几何（曾把容器当课件页 → 偏移）、
      // 选框尺寸（曾把 css() 的结果又喂回 css() → 框看不见）
      slidePointFrom: slidePointFrom, boxStyleFrom: boxStyleFrom,
    }
    return module.exports
  },
})
