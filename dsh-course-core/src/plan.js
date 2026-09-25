/**
 * 教案自动补全 —— 教师端的核心能力
 *
 * ── 为什么做这件事 ────────────────────────────────────────────────────
 * 老师的原话：**一般会准备 PPT，但不一定会写教案**。
 * 而这门课的批改、答疑、验收全部以教案为对齐基准 —— 教案缺一节，
 * 那一节的批改就只能退化成「通用工程规范初筛」（学生端会如实这么说）。
 *
 * 所以缺口不是「老师不会写」，而是「写教案的边际成本高于收益」。
 * 这里做的事：把老师**已经有的东西**（课件文本、示例代码、模块说明、
 * 已有的同风格教案）收拢起来，让模型补出**和现有教案同构**的那一份，
 * 老师只做审批。
 *
 * ── 一条硬原则 ──────────────────────────────────────────────────────
 * 生成的是**草稿**，落盘在 `教案草稿/`，绝不直接写进 `详细教案/`。
 * 教案是验收基准 —— 一份没人看过的自动生成文本一旦成为基准，
 * 批改会拿它去judge学生，错误会被放大 30 次。所以：
 *   草稿区（自动） → 老师审批 → 正式教案（人工背书）
 * 这条界线也写进了 UI 文案，老师能看到「这份还没进正式教案」。
 *
 * ── 骨架从哪来 ──────────────────────────────────────────────────────
 * 不是凭空设计的模板，是从这门课**已有的 18 份教案**里提取的公共结构：
 *   目标 / 推导 / 实操 / 验收标准 / 当堂交付物
 * 其中「验收标准」是最重要的一节 —— 它是批改逐条对照的那张表。
 * 老师可以用 `<课程目录>/教案模板.md` 覆盖内置骨架（见 planTemplate）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { oneLine, callModel, msg, INDEX_REL } from './host.js'

/** 草稿区（**每门课私有**：见 host.js 的 PRIVATE_RELS） */
export const PLAN_DRAFT_DIR = '教案草稿'
export const PLAN_DRAFT_INDEX = PLAN_DRAFT_DIR + '\\_草稿索引.json'
/** 老师可覆盖的骨架文件（放在课程目录根部；没有就用内置的） */
export const PLAN_TEMPLATE_REL = '教案模板.md'
/** 课时锚点：课时号 ↔ 课件页码范围。老师确认后写在这里，之后不再猜。 */
export const PLAN_ANCHOR_REL = PLAN_DRAFT_DIR + '\\_锚点.json'
/** 被覆盖的旧教案备份到这里，不直接删 */
export const PLAN_HISTORY_DIR = PLAN_DRAFT_DIR + '\\_历史'

/**
 * 五节骨架。顺序即教案的顺序，名称即 Markdown 的二级标题。
 * `key` 用于程序判定，`title` 用于写字。
 */
export const PLAN_SECTIONS = [
  { key: 'goal', title: '目标', need: '3~5 条，每条都可检验（"能写出…"而不是"理解…"）' },
  { key: 'derivation', title: '推导', need: '一、二、三… 分小节；公式用 $...$ 与 $$...$$；写清每一步为什么成立' },
  { key: 'practice', title: '实操', need: '任务一、任务二…；每个任务都要有明确产物（文件名）' },
  { key: 'accept', title: '验收标准', need: '逐条可判定 —— 这是**批改对标的基准**，最重要的一节' },
  { key: 'deliver', title: '当堂交付物', need: '清单：文件名 + 一句话说明' },
]

export const PLAN_SECTION_TITLES = PLAN_SECTIONS.map((s) => s.title)

/** 文件名里不能出现的字符（Windows）：\ / : * ? " < > | */
export function safeName(s) {
  return oneLine(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').slice(0, 48)
}

/** 草稿文件名：课时N_<标题>.md —— 与正式教案同构，采纳时不用改名 */
export function draftFileName(lessonNo, title) {
  const t = safeName(title) || ('课时' + lessonNo)
  return '课时' + Number(lessonNo) + '_' + t + '.md'
}

/**
 * 内置骨架。写出来是为了让老师**看得见要填什么** ——
 * 它是提示词的一部分，不是给人手抄的。
 */
export function builtinTemplate(lessonNo, title) {
  const n = Number(lessonNo) || 0
  return [
    '# 课时 ' + (n || 'N') + '：' + (oneLine(title) || '<标题>'),
    '',
    '## 目标',
    '',
    '1. ',
    '',
    '## 推导',
    '',
    '### 一、<小节标题>',
    '',
    '## 实操',
    '',
    '### 任务一：<任务名>',
    '',
    '- 要求：',
    '- 产物：`<文件名>`',
    '',
    '## 验收标准',
    '',
    '1. ',
    '',
    '## 当堂交付物',
    '',
    '- `<文件名>` —— ',
  ].join('\n')
}

/**
 * 取骨架。老师可以在课程目录根部放 `教案模板.md` 覆盖内置的 ——
 * 模板是**课程级**的东西（换一门课，验收标准的写法完全不同），
 * 所以它是可替换的文件，不是写死的常量。
 */
export function planTemplate(core, lessonNo, title) {
  const out = { text: builtinTemplate(lessonNo, title), source: '内置骨架' }
  try {
    if (core && core.exists(PLAN_TEMPLATE_REL)) {
      const raw = core.readText(PLAN_TEMPLATE_REL)
      if (oneLine(raw)) {
        // 模板里的占位符：{{课时}} {{标题}} —— 允许老师直接写死标题以外的部分
        out.text = String(raw)
          .replace(/\{\{\s*课时\s*\}\}/g, String(lessonNo))
          .replace(/\{\{\s*标题\s*\}\}/g, oneLine(title))
        out.source = PLAN_TEMPLATE_REL
      }
    }
  } catch (e) { /* 模板读坏了就用内置的，不能因此生成不了 */ }
  return out
}

/**
 * 解析一份教案：标题 + 五节各自的内容。
 *
 * 为什么需要它：`outline.status` 要能说「这份教案缺了验收标准」，
 * 而不是只说「文件在」。缺了验收标准的那一节，批改是没有基准的 ——
 * 这正是老师最需要被告知的一种「看起来有教案」。
 */
export function parsePlan(md) {
  const text = String(md == null ? '' : md)
  const lines = text.split(/\r?\n/)
  const out = { title: '', sections: {}, missing: [], order: [], chars: text.length }
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && !out.title) { out.title = oneLine(h1[1]); continue }
    const h2 = /^##\s+(.+?)\s*$/.exec(line)
    if (h2) {
      const name = oneLine(h2[1]).replace(/[：:]\s*$/, '')
      // 只认骨架里的五节，其余二级标题不干扰判定（老师可能加"参考资料"）
      out.order.push(name)
    }
  }
  // 逐节取正文：从该节的二级标题到下一个二级标题
  for (const sec of PLAN_SECTIONS) {
    const re = new RegExp('^##\\s*' + sec.title + '\\s*$', 'm')
    const m = re.exec(text)
    if (!m) { out.missing.push(sec.title); out.sections[sec.title] = ''; continue }
    const rest = text.slice(m.index + m[0].length)
    const next = /^##\s+\S/m.exec(rest)
    const body = (next ? rest.slice(0, next.index) : rest).trim()
    out.sections[sec.title] = body
    // 「## 验收标准」下面只有一个「1.」也算空 —— 判空要按去掉了编号与符号之后还有没有字
    if (!oneLine(body.replace(/^[\s\d.、)（(]+/, ''))) out.missing.push(sec.title)
  }
  out.hasAll = out.missing.length === 0
  return out
}

// ── 课时锚点：课时号 ↔ 课件的哪几页 ──────────────────────────────
/**
 * 为什么要有这一层、且要老师确认：
 *   课件的「课时分隔页」检测（host.js 的 detectLessonDividers）只切边界、
 *   取 PPT 自己的标题，**不猜**它对应索引里的第几课时 —— 因为 PPT 标题
 *   与索引标题并不严格一致（例：PPT 写「用线性代数勒死自己（logits模型为例）」，
 *   索引写「从统计学习理论到深度学习的矩阵化重构」）。
 *   实测这门课 30 个课时只有 **10 张分隔页**：一个分隔页常常覆盖两个课时。
 *
 * 所以策略是「先给一个可用的自动推断，并在界面上标明这是推断」，
 * 老师改一次就写进 _锚点.json，之后一直用它，不再猜。
 */
export function readAnchors(core) {
  const out = { list: {}, source: '' }
  try {
    if (core.exists(PLAN_ANCHOR_REL)) {
      const j = JSON.parse(core.readText(PLAN_ANCHOR_REL))
      for (const k of Object.keys(j || {})) {
        if (k === '_note') continue
        const v = j[k]
        if (v && v.chapter && Number(v.from) > 0) {
          out.list[String(k)] = { chapter: String(v.chapter), from: Number(v.from), to: Number(v.to) || Number(v.from), manual: true }
        }
      }
      out.source = PLAN_ANCHOR_REL
    }
  } catch (e) { /* 锚点文件坏了就当作没有，退回自动推断 */ }
  return out
}

export function writeAnchors(core, list) {
  const j = {
    _note: '课时 ↔ 课件页码锚点。老师确认过的为准；没写的课时由系统按模块推断（界面上会标「推断」）。',
  }
  for (const k of Object.keys(list || {})) {
    const v = list[k]
    if (!v || !v.chapter || !(Number(v.from) > 0)) continue
    j[String(k)] = { chapter: String(v.chapter), from: Number(v.from), to: Number(v.to) || Number(v.from) }
  }
  core.writeText(PLAN_ANCHOR_REL, JSON.stringify(j, null, 2) + '\n')
  return j
}

/**
 * 模块 → 章节的自动推断。
 *
 * 依据是课件里的分隔页：分隔页取出的模块名（"模块一"…）与索引里的
 * `modules[].name` 是同一套写法，所以「这个模块占了哪一章的哪几页」
 * 可以直接算出来，**不需要猜标题**。
 * 一个模块横跨多章时按顺序拼接；某章没有该模块的分隔页就不算。
 */
export function inferModuleSpans(lecturesByChapter) {
  const spans = {}
  for (const [chapter, det] of Object.entries(lecturesByChapter || {})) {
    for (const L of (det && det.lessons) || []) {
      const mod = oneLine(L.module)
      if (!mod) continue
      if (!spans[mod]) spans[mod] = []
      spans[mod].push({ chapter, from: L.startIndex, to: L.endIndex, title: L.title, seq: L.seq })
    }
  }
  for (const k of Object.keys(spans)) spans[k].sort((a, b) => (a.chapter === b.chapter ? a.from - b.from : a.chapter.localeCompare(b.chapter)))
  return spans
}

/**
 * 某个课时的课件页范围：老师的锚点优先，否则按模块推断。
 * 返回 null 表示「这段课件根本没做」（M4/M5 就是这样，必须如实说，不能编）。
 */
export function anchorFor(lessonNo, moduleName, spans, anchors) {
  const a = anchors && anchors.list ? anchors.list[String(lessonNo)] : null
  if (a) return Object.assign({}, a, { approx: false })
  const list = (spans && spans[moduleName]) || []
  if (!list.length) return null
  const from = list[0]
  const to = list[list.length - 1]
  return { chapter: from.chapter, from: from.from, to: to.to, approx: true, parts: list.length }
}

// ── 采集：这一课时的全部现存依据 ────────────────────────────────
const CODE_EXT = /\.(py|ipynb|md|yaml|yml|json|csv|txt|tex|r|m|cpp|c|h|java|js|ts)$/i

/** 模块目录下的示例代码清单（老师机上的原始位置） */
function codeFilesOf(core, moduleDir) {
  const out = []
  for (const sub of ['代码示例', '作业', '作业参考']) {
    for (const e of core.listDir(moduleDir + '\\' + sub)) {
      if (!e.isFile()) continue
      if (!CODE_EXT.test(e.name)) continue
      if (/^README\.md$/i.test(e.name)) continue
      out.push({ rel: moduleDir + '\\' + sub + '\\' + e.name, name: e.name, sub, bytes: 0 })
    }
  }
  return out
}

/**
 * 收集一个课时的写作依据。
 *
 * 采集顺序刻意按「信息密度」排：示例代码 > 课件文本 > 已有教案风格 > 模块说明。
 * 缺什么就如实记在 `missing` 里，让提示词明确告诉模型「你没看到课件」——
 * 否则模型会拿常识把 M4/M5 的教案编出来，而那正是最需要警惕的情形。
 */
export function collectLesson(core, tree, lessonNo, opts) {
  const o = opts || {}
  const idx = { lessonNo: Number(lessonNo), found: false, missing: [] }
  let mod = null
  let lesson = null
  for (const m of (tree && tree.modules) || []) {
    for (const l of m.lessons || []) {
      if (Number(l.no) === Number(lessonNo)) { mod = m; lesson = l; break }
    }
    if (lesson) break
  }
  if (!lesson) { idx.missing.push('索引里没有这个课时号'); return idx }
  idx.found = true
  idx.lesson = lesson
  idx.module = mod
  idx.moduleDir = mod.dir || ''
  idx.planDir = mod.planDir || '详细教案'

  // 1) 已存在的正式教案（也是**风格样例** —— "以现有这套为案例"）
  try { idx.planPath = core.exists(lesson.planPath || '') ? lesson.planPath : '' } catch (e) { idx.planPath = '' }
  if (idx.planPath) { try { idx.planText = core.readText(idx.planPath) } catch (e) { idx.planText = '' } }

  // 2) 同模块的其他教案：抽一份当风格样例（挑最长的 —— 最长的通常写得最细）
  idx.styleSample = null
  if (!o.skipStyle) {
    let best = null
    for (const l of (mod.lessons || [])) {
      if (Number(l.no) === Number(lessonNo)) continue
      if (!l.planPath) continue
      try {
        const t = core.readText(l.planPath)
        if (!best || t.length > best.text.length) best = { no: l.no, title: l.title, text: t }
      } catch (e) { /* 单份读失败不算致命 */ }
    }
    idx.styleSample = best
  }

  // 3) 示例代码（本课时最实的依据）
  idx.codeFiles = codeFilesOf(core, idx.moduleDir)
  idx.code = []
  let budget = Number(o.codeBudget) > 0 ? Number(o.codeBudget) : 16000
  // 文件名里带课时号的优先（"03_纯NumPy逻辑回归" 这种命名约定在这门课里很普遍）
  const scored = idx.codeFiles.slice().sort((a, b) => {
    const sa = new RegExp('^0*' + lessonNo + '[_.]').test(a.name) ? 1 : 0
    const sb = new RegExp('^0*' + lessonNo + '[_.]').test(b.name) ? 1 : 0
    return sb - sa
  })
  for (const f of scored) {
    if (budget <= 0) break
    let text = ''
    try { text = core.readText(f.rel) } catch (e) { continue }
    const per = Number(o.codePerFile) > 0 ? Number(o.codePerFile) : 4000
    const cut = text.length > per
    const piece = cut ? text.slice(0, per) : text
    budget -= piece.length
    idx.code.push({ name: f.name, sub: f.sub, chars: text.length, truncated: cut, text: piece })
  }
  if (!idx.code.length) idx.missing.push('这个模块下没有找到示例代码')

  // 4) 模块说明
  idx.moduleNote = ''
  for (const rel of [idx.moduleDir + '\\模块说明.md', idx.moduleDir + '\\README.md']) {
    try { if (core.exists(rel)) { idx.moduleNote = core.readText(rel); break } } catch (e) { /* 下一个 */ }
  }
  if (!idx.moduleNote) idx.missing.push('模块说明.md 缺失')

  // 5) 课件页码范围 + 正文。
  //    正文在这里取，而不是留给调用方 —— 调用方很容易记得传 anchor、忘了传正文，
  //    而「忘了传」的症状是模型拿到一句「本课时课件：第一章 5-9 页」却看不到内容，
  //    于是它按常识把推导编出来。这种失败是**静默**的，所以在源头堵掉。
  idx.anchor = anchorFor(lessonNo, mod.name, o.spans || {}, o.anchors || {})
  idx.slideText = null
  if (idx.anchor) {
    const byCh = o.slidesByChapter || {}
    const data = byCh[idx.anchor.chapter]
    if (data) {
      idx.slideText = sliceSlideText(data, idx.anchor.from, idx.anchor.to, {
        perPage: o.slidePerPage, total: o.slideBudget,
      })
    }
    if (!idx.slideText || !idx.slideText.text) idx.missing.push('这一课时的课件页里没有文字（可能是纯图页）')
  } else {
    idx.missing.push('这一模块还没有课件（推断不出页码范围）')
  }

  return idx
}

/** 从课件数据里切出某段页码的正文文本，供提示词使用 */
export function sliceSlideText(chapterData, from, to, opts) {
  const o = opts || {}
  const perPage = Number(o.perPage) > 0 ? Number(o.perPage) : 900
  const total = Number(o.total) > 0 ? Number(o.total) : 30000
  if (!chapterData || !Array.isArray(chapterData.slides)) return { text: '', pages: 0, truncated: false }
  const lo = Number(from) || 1
  const hi = Number(to) || lo
  const out = []
  let used = 0
  let pages = 0
  let truncated = false
  for (const s of chapterData.slides) {
    if (s.index < lo || s.index > hi) continue
    const t = oneLine(s.text)
    if (!t) continue
    pages += 1
    let piece = t.length > perPage ? t.slice(0, perPage) + '…' : t
    if (used + piece.length > total) { truncated = true; piece = piece.slice(0, Math.max(0, total - used)) }
    used += piece.length
    out.push('第 ' + s.index + ' 页：' + piece)
    if (used >= total) { truncated = true; break }
  }
  return { text: out.join('\n'), pages, truncated }
}

// ── 提示词 ──────────────────────────────────────────────────────
export const PLAN_SYSTEM = [
  '你是这门课的主讲老师，正在把**已有的课件与示例代码**整理成一份可以直接当验收基准用的详细教案。',
  '',
  '硬性要求：',
  '1. 只输出 Markdown 正文，不要任何前言、寒暄、「好的，我来为你…」，也不要 ``` 包裹整篇。',
  '2. 必须严格用这五个二级标题，顺序不能变：## 目标 / ## 推导 / ## 实操 / ## 验收标准 / ## 当堂交付物',
  '3. 标题必须是 `# 课时 N：<课时标题>`，N 与标题用给你的那个。',
  '4. **推导**要分小节（### 一、二、三…），凡涉及公式一律用 LaTeX：行内 $...$，独立 $$...$$。',
  '   这门课的推导是给工程背景的学生看的，每一步都要说清「为什么可以这样写」，不要跳步。',
  '5. **验收标准**是最重要的一节：每条都要能被别人拿着代码**逐条判定通过/不通过**。',
  '   禁止写「理解 X」「掌握 Y」这类无法判定的条目；要写「构造出 $\\mathbf{X}_{aug}$，形状为 (N, d+1)」这种。',
  '6. **实操**的每个任务都要有明确产物（写出文件名），产物命名沿用我给你的示例代码的命名风格。',
  '7. 只能用我给你的材料。材料里没有的内容**不要编**；如果某一部分缺材料（我会明确告诉你缺什么），',
  '   就在那一节里用一行 `> 待补充：…` 说明缺什么、需要老师补什么，而不是用常识填充。',
  '8. 与已有的同风格教案保持一致的写法与术语（我会给你一份样例）。',
].join('\n')

/** 把一次采集结果拼成提示词。纯函数，便于单测与"看不到什么"的审计。 */
export function buildPlanPrompt(ctxData, opts) {
  const o = opts || {}
  const d = ctxData
  const parts = []
  parts.push('【课程】' + (o.courseTitle || '（未命名课程）'))
  if (o.courseGoal) parts.push('【课程目标】' + o.courseGoal)
  parts.push('【模块】' + ((d.module && d.module.name) || '') + ' · ' + ((d.module && d.module.theme) || '')
    + (d.module && d.module.range ? ('（' + d.module.range + '）') : ''))
  parts.push('【本课时】第 ' + d.lessonNo + ' 课时：' + ((d.lesson && d.lesson.title) || ''))

  if (d.moduleNote) parts.push('', '【本模块说明】', String(d.moduleNote).slice(0, 2000))

  if (d.anchor && d.slideText) {
    parts.push('', '【课件】' + d.anchor.chapter + ' 第 ' + d.anchor.from + '–' + d.anchor.to + ' 页'
      + (d.anchor.approx ? '（页码范围由模块推断，未经老师确认）' : '（老师已确认）')
      + (d.slideText.truncated ? '，文本已截断' : ''))
    parts.push(d.slideText.text)
  } else {
    parts.push('', '【课件】这一课时**没有对应的课件页**（本模块尚未制作课件）。'
      + '请不要凭常识补写推导，改为依据示例代码能支撑的内容写，并在推导末尾用 `> 待补充：课件…` 标明缺什么。')
  }

  if (d.code && d.code.length) {
    parts.push('', '【示例代码（本模块已有，是最实的依据）】')
    for (const f of d.code) {
      parts.push('', '—— ' + f.name + '（' + f.sub + '，' + f.chars + ' 字符'
        + (f.truncated ? '，**已截断**，下面不是全文' : '') + '）', '```', f.text, '```')
    }
  } else {
    parts.push('', '【示例代码】没有找到。实操任务只能写成任务描述 + 产物要求，不要编造具体代码。')
  }

  if (d.styleSample) {
    parts.push('', '【同风格样例：本模块第 ' + d.styleSample.no + ' 课时的教案（节选）】',
      '这是我要你照着写的写法与颗粒度；**内容不要抄**。',
      '```markdown', String(d.styleSample.text).slice(0, 6000), '```')
  }

  parts.push('', '【缺失的材料】' + (d.missing && d.missing.length ? d.missing.join('；') : '（无）'))
  parts.push('', '请按上面的硬性要求输出这一课时的完整教案。')
  return parts.join('\n')
}

/**
 * 跑一次教案生成。**这是教师端唯一会花 token 的动作**（老师自己的额度）。
 *
 * 与「教师端不调用模型」那条旧注释的关系：那条说的是**日常整理**不花钱
 * （审计、汇总、发布都是纯读写）。教案补全是老师主动发起的写作任务，
 * 一次一课、明码标价地花他自己的额度，和学生的提问记账是两回事。
 */
export async function runPlanDraft(ctx, { lessonNo, data, courseTitle, courseGoal, trace, choice, system }) {
  const log = trace || []
  const prompt = buildPlanPrompt(data, { courseTitle, courseGoal })
  log.push('教案提示词字符数: ' + prompt.length)
  const r = await callModel(ctx, {
    system: system || PLAN_SYSTEM,
    messages: [msg('user', prompt)],
    trace: log,
    choice: choice,
  })
  const parsed = parsePlan(r.text)
  return {
    text: r.text, parsed, usage: r.usage,
    provider: r.provider, model: r.model,
    promptChars: prompt.length,
    // 让界面能说清「这次生成看到了什么」—— 生成质量出问题时，
    // 第一件要查的就是「它到底看到了什么」，而不是重跑一次。
    saw: {
      slides: data && data.slideText ? (data.slideText.pages + ' 页') : '无课件',
      code: (data && data.code ? data.code.length : 0) + ' 份代码',
      style: data && data.styleSample ? ('第 ' + data.styleSample.no + ' 课时') : '无样例',
      missing: (data && data.missing) || [],
    },
  }
}

/** 模型输出常带整篇 ``` 包裹或前言；剥掉它们再落盘，老师下一次编辑才顺手 */
export function cleanPlanText(text) {
  let t = String(text == null ? '' : text).trim()
  t = t.replace(/^[\s\S]*?```(?:markdown|md)?\s*\n/i, (m) => (m.indexOf('```') === 0 ? m : ''))
  t = t.replace(/\n```\s*$/, '')
  // 去掉「好的，下面是…」这类开场白：只保留从第一个一级标题开始的内容
  const i = t.search(/^#\s+\S/m)
  if (i > 0) t = t.slice(i)
  return t.trim() + '\n'
}

// ── 多轮修改：像学生提问那样，一轮一轮把教案改到位 ──────────────────
/**
 * 为什么教案要能多轮改，而不是「重新生成一次」：
 *   老师对着生成的稿子看，发现的问题几乎都是**局部的** ——
 *   「这一节的推导跳步了」「验收标准太虚，改成可判定的」「第 12 页那张图要讲进去」。
 *   重新生成会把已经满意的部分一起洗掉；逐轮改只动该动的地方，
 *   而且每一轮都能看出来「这轮改了什么」。
 *
 * 证据块与学生端提问**同一套形状**（chapter/page/kind/text/note + 截图），
 * 所以老师能像学生一样：在课件上拖选一段文字、或框一张图，指着它说怎么改。
 * 这不是「顺便复用」——正因为同一套，两边才是同一种操作。
 */
export function formatEvidenceForPlan(evidence) {
  const list = Array.isArray(evidence) ? evidence : []
  if (!list.length) return ''
  const KIND = { region: '框选图区', text: '拖选文字', page: '整页截图' }
  const out = ['', '【老师圈出来的 ' + list.length + ' 块内容】']
  list.forEach((e, i) => {
    out.push((i + 1) + '. ' + (e.chapter || '') + ' 第 ' + (e.page || '?') + ' 页 · '
      + (KIND[e.kind] || '内容'))
    if (e.note) out.push('   （老师的说明：' + e.note + '）')
    if (e.text) out.push('   ' + String(e.text).replace(/\n+/g, '\n   ').slice(0, 900))
  })
  return out.join('\n')
}

/** 一轮最多带几张证据截图。和学生端提问同一个量级 —— 多了模型反而抓不住重点。 */
export const MAX_PLAN_IMAGES = 4

export const PLAN_REVISE_SYSTEM = [
  '你是这门课的主讲老师，正在**改一份已有的教案草稿**。',
  '',
  '硬性要求：',
  '1. 只输出改完之后的**整篇** Markdown，不要前言、不要解释、不要 ``` 包裹。',
  '2. 严格保留五个二级标题与顺序：## 目标 / ## 推导 / ## 实操 / ## 验收标准 / ## 当堂交付物。',
  '   一级标题 `# 课时 N：<标题>` 原样保留。',
  '3. **只改老师要求改的地方，其余部分逐字保持不变。** 这是最重要的一条：',
  '   老师改了三轮之后，第一轮已经满意的内容不该被后面的轮次悄悄改写。',
  '4. 老师圈了课件内容（文字或截图）时，那部分就是**依据**：',
  '   把它讲进对应的小节里，而不是泛泛提一句。',
  '5. 公式一律 LaTeX：行内 $...$，独立 $$...$$。',
  '6. 「验收标准」必须逐条可判定（能拿着代码判通过/不通过），不要写「理解 X」这类。',
].join('\n')

/** 拼一轮修改的提示词。纯函数，便于单测与「它到底看到了什么」的审计。 */
export function buildRevisePrompt(d) {
  const parts = []
  parts.push('【课时】第 ' + d.lessonNo + ' 课时：' + (d.title || ''))
  if (d.anchor && d.anchor.chapter) {
    parts.push('【课件范围】' + d.anchor.chapter + ' 第 ' + d.anchor.from + '–' + d.anchor.to + ' 页')
  }
  parts.push('', '【当前教案草稿（整篇）】', '```markdown', String(d.current || ''), '```')
  const ev = formatEvidenceForPlan(d.evidence)
  if (ev) parts.push(ev)
  if (d.imageCount > 0) {
    parts.push('', '（本次带 ' + d.imageCount + ' 张图，是按上面证据的编号顺序截的课件内容 —— '
      + '第 N 张图对应第 N 块。请先读懂它们，再按老师的要求改。）')
  }
  if (Array.isArray(d.history) && d.history.length) {
    parts.push('', '【之前几轮已经改过什么（供你避免改回去）】')
    d.history.slice(-4).forEach((t, i) => {
      parts.push('第 ' + (i + 1) + ' 轮要求：' + oneLine(t.q))
    })
  }
  parts.push('', '【老师这一轮的要求】', oneLine(d.instruction) || '（老师只圈了内容，请据此完善对应小节）')
  parts.push('', '请输出改完之后的整篇教案。')
  return parts.join('\n')
}

/**
 * 逐节合并：新稿里某一节空了/没了，就保留旧稿的。
 *
 * 为什么必须做这一步：模型偶尔会「顺手」把某一节写丢或写空，而
 * **一份丢了一节的教案比原来更糟** —— 老师要逐字比对才能发现，
 * 而这个功能的价值恰恰在于「不用逐字比对」。
 * 规则只在**新稿缺内容**时回退，绝不拿旧稿去覆盖新稿。
 */
export function mergePlanSections(oldText, newText) {
  const a = parsePlan(oldText)
  const b = parsePlan(newText)
  const kept = []
  let out = String(newText == null ? '' : newText)
  for (const sec of PLAN_SECTIONS) {
    const blank = !oneLine(String(b.sections[sec.title] || '').replace(/^[\s\d.、)（(]+/, ''))
    if (!blank) continue
    const oldBody = String(a.sections[sec.title] || '')
    if (!oneLine(oldBody.replace(/^[\s\d.、)（(]+/, ''))) continue
    const re = new RegExp('(^##\\s*' + sec.title + '\\s*$)', 'm')
    if (re.test(out)) out = out.replace(re, '$1\n\n' + oldBody)
    else out = out.trimEnd() + '\n\n## ' + sec.title + '\n\n' + oldBody + '\n'
    kept.push(sec.title)
  }
  const merged = parsePlan(out)
  return { text: out, keptFromOld: kept, missing: merged.missing }
}

/** 两稿之间哪些节变了 —— 给老师看「这轮改了什么」，而不是让他自己找 */
export function diffPlanSections(oldText, newText) {
  const a = parsePlan(oldText)
  const b = parsePlan(newText)
  const changed = []
  for (const sec of PLAN_SECTIONS) {
    const x = oneLine(a.sections[sec.title])
    const y = oneLine(b.sections[sec.title])
    if (x === y) continue
    changed.push({ title: sec.title, before: x.length, after: y.length, delta: y.length - x.length })
  }
  return { changed, charsBefore: String(oldText || '').length, charsAfter: String(newText || '').length }
}

/** 跑一轮修改。这是教师端第二个会花 token 的地方（同样用老师自己的额度）。 */
export async function runPlanRevise(ctx, { data, trace, choice }) {
  const log = trace || []
  const prompt = buildRevisePrompt(data)
  log.push('改稿提示词字符数: ' + prompt.length)
  const content = [{ type: 'text', text: prompt }]
  let attached = 0
  for (let i = 0; i < (data.images || []).length; i += 1) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) { log.push('附件服务不可用，第 ' + (i + 1) + ' 张图未随消息发送'); continue }
    try {
      const s = String(data.images[i] || '')
      const bytes = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64')
      const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'pick-' + (i + 1) + '.png' })
      content.push({ type: 'image', attachment: ref })
      attached += 1
      log.push('证据图 ' + (i + 1) + ': ' + ref.width + 'x' + ref.height)
    } catch (error) { log.push('证据图 ' + (i + 1) + ' 保存失败: ' + oneLine(error && error.message)) }
  }
  const last = msg('user', prompt)
  last.content = content
  const r = await callModel(ctx, {
    system: PLAN_REVISE_SYSTEM, messages: [last], trace: log, choice: choice,
  })
  const before = String(data.current || '')
  const merged = mergePlanSections(before, cleanPlanText(r.text))
  return {
    text: merged.text, usage: r.usage, provider: r.provider, model: r.model,
    imagesAttached: attached, keptFromOld: merged.keptFromOld, missing: merged.missing,
    diff: diffPlanSections(before, merged.text),
  }
}

/** 历史版本快照。逐轮改就必须能回退 —— 改坏了要能退回去重来。 */
export function snapshotDraft(core, lessonNo, text, label) {
  try {
    const n = core.listDir(PLAN_HISTORY_DIR).filter((e) => e.isFile()).length
    const name = '课时' + Number(lessonNo) + '.' + String(n + 1).padStart(3, '0')
      + (label ? ('.' + label) : '') + '.md'
    core.writeText(PLAN_HISTORY_DIR + '\\' + name, String(text || ''))
    return name
  } catch (e) { return '' }
}

// ── 草稿区读写 ──────────────────────────────────────────────────
export function readDraftIndex(core) {
  try {
    if (!core.exists(PLAN_DRAFT_INDEX)) return { drafts: [] }
    const j = JSON.parse(core.readText(PLAN_DRAFT_INDEX))
    return { drafts: Array.isArray(j.drafts) ? j.drafts : [] }
  } catch (e) { return { drafts: [], error: oneLine(e && e.message) } }
}

export function writeDraftIndex(core, j) {
  core.writeText(PLAN_DRAFT_INDEX, JSON.stringify(Object.assign({ _note: '教案草稿索引。草稿不是教案 —— 只有老师采纳后才进 详细教案/。' }, j), null, 2) + '\n')
}

/**
 * 存一份草稿。同名直接覆盖（重跑一次生成就是覆盖，老师的编辑也在这里改）。
 *
 * 返回值里带上**清洗后真正落盘的那份文本** —— 调用方要拿它做预览。
 * 踩过：预览用了模型的原始输出，于是界面上显示的是
 * 「好的，我来为你整理这份教案：```markdown # 课时 19…」，
 * 而文件里其实是干净的。预览与文件不一致，老师会以为生成坏了。
 */
export function saveDraft(core, entry, text) {
  const file = entry.file || draftFileName(entry.lesson, entry.title)
  const clean = cleanPlanText(text)
  core.writeText(PLAN_DRAFT_DIR + '\\' + file, clean)
  const j = readDraftIndex(core)
  const list = j.drafts.filter((d) => Number(d.lesson) !== Number(entry.lesson))
  list.push(Object.assign({}, entry, { file, chars: clean.length, at: new Date().toISOString() }))
  list.sort((a, b) => Number(a.lesson) - Number(b.lesson))
  writeDraftIndex(core, { drafts: list })
  return Object.assign({}, entry, { file, chars: clean.length, text: clean })
}

export function findDraft(core, lesson) {
  const j = readDraftIndex(core)
  return j.drafts.find((d) => Number(d.lesson) === Number(lesson)) || null
}

export function updateDraftMeta(core, lesson, patch) {
  const j = readDraftIndex(core)
  let hit = null
  j.drafts = j.drafts.map((d) => {
    if (Number(d.lesson) !== Number(lesson)) return d
    hit = Object.assign({}, d, patch)
    return hit
  })
  if (hit) writeDraftIndex(core, { drafts: j.drafts })
  return hit
}

export function removeDraft(core, lesson) {
  const d = findDraft(core, lesson)
  if (!d) return null
  try { fs.unlinkSync(core.courseAbs(PLAN_DRAFT_DIR + '\\' + d.file)) } catch (e) { /* 文件可能已经不在了 */ }
  const j = readDraftIndex(core)
  writeDraftIndex(core, { drafts: j.drafts.filter((x) => Number(x.lesson) !== Number(lesson)) })
  return d
}

// ── 采纳：草稿 → 正式教案，并同步索引 ────────────────────────────
export function indexAbs(core) { return core.sharedAbs(INDEX_REL) }

export function readIndexRaw(core) {
  const p = indexAbs(core)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

export function writeIndexRaw(core, idx) {
  fs.writeFileSync(indexAbs(core), JSON.stringify(idx, null, 2) + '\n', 'utf8')
}

/**
 * 采纳一份草稿：写进 `<模块>/详细教案/`，并把索引里的 `plan` 字段指过去。
 *
 * ⚠️ 索引是**共享内容**（全校一份，也是学生端拿到的 课程.json 的来源）。
 *    所以这里改的是根目录那份，不是课程目录里的副本 —— 改错了会让所有
 *    学生看到「这一课时没有教案」。
 */
export function acceptDraft(core, lessonNo, opts) {
  const o = opts || {}
  const d = findDraft(core, lessonNo)
  if (!d) throw new Error('这个课时还没有草稿')
  const idx = readIndexRaw(core)
  let mod = null
  let lesson = null
  for (const m of idx.modules || []) {
    for (const l of m.lessons || []) { if (Number(l.no) === Number(lessonNo)) { mod = m; lesson = l } }
    if (lesson) break
  }
  if (!lesson) throw new Error('索引里没有第 ' + lessonNo + ' 课时')
  const planDir = mod.planDir || '详细教案'
  const rel = mod.dir + '\\' + planDir + '\\' + d.file
  const targetAbs = core.sharedAbs(rel)
  let backedUp = ''
  if (fs.existsSync(targetAbs)) {
    if (!o.overwrite) throw new Error('正式教案已存在：' + rel + '（要覆盖请显式选择覆盖）')
    // 覆盖前留档：教案是验收基准，**不能**直接冲掉。老师事后要对比才有依据。
    backedUp = PLAN_HISTORY_DIR + '\\' + d.file.replace(/\.md$/, '') + '.' + Date.now() + '.md'
    core.writeText(backedUp, fs.readFileSync(targetAbs, 'utf8'))
  }
  const text = core.readText(PLAN_DRAFT_DIR + '\\' + d.file)
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true })
  fs.writeFileSync(targetAbs, text, 'utf8')

  lesson.plan = d.file
  let missingCleared = false
  for (const m of idx.modules || []) {
    const all = (m.lessons || []).every((l) => l.plan)
    if (all && m.missingPlans) { delete m.missingPlans; missingCleared = true }
  }
  writeIndexRaw(core, idx)
  updateDraftMeta(core, lessonNo, { status: 'accepted', acceptedTo: rel, acceptedAt: new Date().toISOString() })
  return { ok: true, lesson: Number(lessonNo), path: rel, backedUp, missingCleared, file: d.file }
}

/**
 * 重建索引里的 `plan` 字段。
 *
 * 存在的理由：索引是**手工维护**的派生文件（见它自己的 _note），
 * 老师写完一份教案放进去，很容易忘了回来改索引 —— 而索引一漏，
 * 学生端就说「这一课时没有教案」，批改随即退化成通用初筛，
 * 且没有任何报错。所以给一个「扫一遍磁盘、把索引对齐」的动作，
 * 并把**每一处改动**列出来给老师看（而不是静默修正）。
 */
export function rebuildIndex(core) {
  const idx = readIndexRaw(core)
  const changes = []
  const orphans = []
  for (const m of idx.modules || []) {
    const planDir = m.planDir || '详细教案'
    let entries = []
    try { entries = fs.readdirSync(core.sharedAbs(m.dir + '\\' + planDir), { withFileTypes: true }) } catch (e) { entries = [] }
    const byLesson = new Map()
    for (const e of entries) {
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue
      if (/^README\.md$/i.test(e.name)) continue
      const mm = /^课时\s*(\d+)[_．.\s]/.exec(e.name)
      if (!mm) { orphans.push({ module: m.name, name: e.name, why: '文件名不含「课时N_」前缀，无法自动对应课时' }); continue }
      const no = Number(mm[1])
      // 同一课时有多份时，.md 里更晚的不是判据 —— 用文件名更长的（信息更全）优先，
      // 并把冲突报出来让老师自己删，而不是替他猜。
      if (!byLesson.has(no)) byLesson.set(no, [])
      byLesson.get(no).push(e.name)
    }
    for (const l of m.lessons || []) {
      const cands = byLesson.get(Number(l.no)) || []
      if (!cands.length) {
        if (l.plan) { changes.push({ module: m.name, lesson: l.no, from: l.plan, to: '', why: '磁盘上找不到这份教案' }); l.plan = '' }
        continue
      }
      if (cands.length > 1) {
        orphans.push({ module: m.name, name: cands.join(' / '), why: '第 ' + l.no + ' 课时对应多份教案，请删掉多余的' })
      }
      const pick = cands.slice().sort((a, b) => b.length - a.length)[0]
      if (l.plan !== pick) { changes.push({ module: m.name, lesson: l.no, from: l.plan || '', to: pick }); l.plan = pick }
    }
    const all = (m.lessons || []).every((l) => l.plan)
    if (!all && !m.missingPlans) { m.missingPlans = true; changes.push({ module: m.name, lesson: 0, from: '', to: '', why: '该模块仍有课时没有教案（标记 missingPlans）' }) }
    if (all && m.missingPlans) { delete m.missingPlans; changes.push({ module: m.name, lesson: 0, from: '', to: '', why: '该模块教案已补齐（清除 missingPlans）' }) }
  }
  if (changes.length) writeIndexRaw(core, idx)
  return { changes, orphans, wrote: changes.length > 0 }
}

/**
 * 大纲体检：把「30 个课时各自缺什么」一次说清。
 *
 * 这是减少老师工作量的第一件工具 —— 老师通常不知道自己缺哪几节，
 * 而「缺教案」和「缺课件」是两种完全不同的补救（前者可以自动补，
 * 后者要去录课）。所以这两者必须分开报，不能混成一个「完成度」。
 */
export function outlineStatus(core, tree, opts) {
  const o = opts || {}
  const anchors = o.anchors || readAnchors(core)
  const spans = o.spans || {}
  const slidesCache = o.slidesCache || {}
  const drafts = readDraftIndex(core)
  const draftOf = {}
  for (const d of drafts.drafts || []) draftOf[Number(d.lesson)] = d

  const out = []
  const byModule = []
  for (const m of (tree && tree.modules) || []) {
    const modRow = { name: m.name, theme: m.theme, range: m.range, dir: m.dir, total: (m.lessons || []).length, hasPlan: 0, hasSlides: 0, hasCode: 0, draft: 0, lessons: [] }
    let codeCount = 0
    for (const sub of ['代码示例', '作业']) {
      codeCount += core.listDir((m.dir || '') + '\\' + sub).filter((e) => e.isFile() && CODE_EXT.test(e.name) && !/^README\.md$/i.test(e.name)).length
    }
    modRow.codeFiles = codeCount
    for (const l of m.lessons || []) {
      const anchor = anchorFor(l.no, m.name, spans, anchors)
      const planExists = !!l.hasPlan
      const sections = planExists ? (() => { try { return parsePlan(core.readText(l.planPath)) } catch (e) { return null } })() : null
      const d = draftOf[Number(l.no)]
      const row = {
        no: l.no, title: l.title, module: m.name,
        plan: planExists, planPath: l.planPath || '',
        planChars: planExists ? (() => { try { return core.readText(l.planPath).length } catch (e) { return 0 } })() : 0,
        planMissingSections: sections ? sections.missing : null,
        draft: d ? { status: d.status || 'draft', at: d.at, chars: d.chars || 0, file: d.file, missing: d.missing || [] } : null,
        slides: anchor ? { chapter: anchor.chapter, from: anchor.from, to: anchor.to, approx: anchor.approx !== false } : null,
        codeFiles: codeCount,
        // 「能自动补」= 有代码示例或课件文本之一。两者都没有就必须老师先给材料，
        // 硬生成只会得到一份看起来完整、实际是常识拼凑的教案。
        autoFillable: codeCount > 0 || !!anchor,
      }
      if (planExists) modRow.hasPlan += 1
      if (anchor) modRow.hasSlides += 1
      if (d && d.status !== 'rejected') modRow.draft += 1
      modRow.lessons.push(row)
      out.push(row)
    }
    modRow.hasCode = codeCount > 0
    byModule.push(modRow)
  }
  const total = out.length
  const withPlan = out.filter((r) => r.plan).length
  const withSlides = out.filter((r) => r.slides).length
  const withDraft = out.filter((r) => r.draft && r.draft.status !== 'rejected').length
  return {
    course: (tree && tree.course) || '',
    totalLessons: total,
    withPlan, missingPlan: total - withPlan,
    withSlides, missingSlides: total - withSlides,
    withDraft,
    autoFillable: out.filter((r) => !r.plan && r.autoFillable).length,
    noMaterial: out.filter((r) => !r.plan && !r.autoFillable).length,
    anchorSource: anchors.source || '（无，按模块推断）',
    modules: byModule,
    lessons: out,
    // 只有缺教案、且材料够的课时才值得点「生成」—— 界面按这个顺序排
    worklist: out.filter((r) => !r.plan && r.autoFillable).map((r) => r.no),
    blocked: out.filter((r) => !r.plan && !r.autoFillable).map((r) => r.no),
  }
}
