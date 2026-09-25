/**
 * 课程布局（L1：可配置）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────
 * 实测这个插件里写死的「这门课」假设有 270 处，其中纯字符串的部分包括：
 *   章节名 第一章/第二章/第三章 · 模块名 模块一..五 · 详细教案 · 课程中心\预览数据
 *   课程问题池 · 作业提交 · 课程结构索引.json · 受控词表 TOPICS/issueTypes
 * 而 `课程配置.json` 原来只覆盖 title/code/term/goal/note —— **全是显示字段**。
 *
 * 于是「装到别的课上」意味着改十几处代码，而且**症状是静默的**：
 * 章节列表空了、教案找不到、媒体 404，一条错都不报。
 *
 * ── 这一层怎么做 ──────────────────────────────────────────────────────
 * 凡是「换一门课就该不一样」的字符串，都进配置；**读不到就用内置默认值**。
 * 所以：今天这门课**一行配置都不用改**，行为一个字不变；
 * 换课只写一份 `课程配置.json`。
 *
 * ── 一个必须说清的注意点 ──────────────────────────────────────────────
 * `topics` 与 `issueTypes` **不只是显示**：它们进提示词，也进下拉框。
 * 换课时必须一起换 —— 否则模型会拿「视觉任务」去分类一门文学课的问题，
 * 而分类错了不会报错，只会让老师看到一堆莫名其妙的归类。
 */

/**
 * 默认布局 —— 就是当前这门深度学习课的形状。
 * 这份默认值的意义是「**老工作区零改动继续跑**」，不是「推荐的通用形状」。
 */
export const LAYOUT_DEFAULTS = {
  // 章节名。空数组 = 这门课不分章（课件页会退化成一个连续序列）
  chapters: ['第一章', '第二章', '第三章'],
  // 模块名。只在**索引里没有 modules[].name** 时才用它兜底
  modules: ['模块一', '模块二', '模块三', '模块四', '模块五'],
  indexRel: '课程中心\\课程结构索引.json',
  slidesDir: '课程中心\\预览数据',
  mediaSub: 'media',
  planDir: '详细教案',
  codeDir: '代码示例',
  resDir: '资源',
  questionsRel: '课程问题池',
  submitRel: '作业提交',
  draftDir: '教案草稿',
  // 教案骨架（不同课的「验收标准」写法完全不同，所以它也是可配的）
  planSections: ['目标', '推导', '实操', '验收标准', '当堂交付物'],
}

export const VOCAB_DEFAULTS = {
  topics: ['数学推导', '损失与优化', '工程与调试', '训练技巧', '视觉任务', '多模态与3D', '工作流与方法论', '其他'],
  issueTypes: ['概念问题', '代码报错', '环境问题', '数值稳定性', '作业疑问', '讲义问题', '内容建议'],
  severities: ['阻塞', '高', '中', '低'],
}

/** 只接受非空字符串数组 —— 配置里写错类型时回默认值，而不是让下游拿到一个字符串 */
function strArray(v, fallback) {
  if (!Array.isArray(v)) return fallback.slice()
  const out = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  return out.length ? out : fallback.slice()
}

/**
 * 解析出一门课的实际布局。`cfg` 是 readCourseConfig 的结果。
 *
 * 三条规则：
 *   1. 缺项 → 默认值（老工作区零改动）
 *   2. 类型不对 → 默认值（**不抛错**：一份写坏的配置不该让面板打不开）
 *   3. 路径统一成**反斜杠**形式：宿主里到处拼 `\\`，混用会拼出
 *      `课程中心/预览数据\media` 这种半截路径 —— 在 Windows 上能跑，
 *      但会让「同一份配置在两边解析出不同字符串」这种问题极难查。
 */
export function resolveLayout(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {}
  const raw = (c.layout && typeof c.layout === 'object') ? c.layout : {}
  const out = {}
  for (const k of Object.keys(LAYOUT_DEFAULTS)) {
    const d = LAYOUT_DEFAULTS[k]
    const v = raw[k]
    if (Array.isArray(d)) out[k] = strArray(v, d)
    else out[k] = (typeof v === 'string' && v.trim()) ? v.trim().replace(/\//g, '\\') : d
  }
  // 词表：既可以在顶层写（老写法友好），也可以在 layout 里写
  const vocabSrc = Object.assign({}, c, raw)
  out.topics = strArray(vocabSrc.topics, VOCAB_DEFAULTS.topics)
  out.issueTypes = strArray(vocabSrc.issueTypes, VOCAB_DEFAULTS.issueTypes)
  out.severities = strArray(vocabSrc.severities, VOCAB_DEFAULTS.severities)
  // 教案骨架至少要有两节，否则「逐节检查」这类功能没有意义
  out.planSections = (() => {
    const s = strArray(vocabSrc.planSections, LAYOUT_DEFAULTS.planSections)
    return s.length >= 2 ? s : LAYOUT_DEFAULTS.planSections.slice()
  })()
  return out
}

/**
 * 这份布局是不是「完全是默认值」。
 * 面板要据此说一句「这门课还没配布局，用的是默认形状」——
 * 老师换课时第一件该知道的事就是「它现在按哪套形状在认你的文件」。
 */
export function isDefaultLayout(layout) {
  const L = layout || {}
  for (const k of Object.keys(LAYOUT_DEFAULTS)) {
    const d = LAYOUT_DEFAULTS[k]
    const v = L[k]
    if (Array.isArray(d)) { if (JSON.stringify(d) !== JSON.stringify(v)) return false }
    else if (d !== v) return false
  }
  for (const k of Object.keys(VOCAB_DEFAULTS)) {
    if (JSON.stringify(VOCAB_DEFAULTS[k]) !== JSON.stringify(L[k])) return false
  }
  return true
}

/**
 * 布局的**自检**：配置里写了什么、哪几项是默认值。
 * 换课失败时第一件要查的就是「它到底按哪套形状在认文件」——
 * 与其让老师去翻 json，不如直接列给他看。
 */
export function layoutReport(layout) {
  const L = layout || resolveLayout(null)
  const rows = []
  for (const k of Object.keys(LAYOUT_DEFAULTS)) {
    const d = LAYOUT_DEFAULTS[k]
    const v = L[k]
    const isDefault = Array.isArray(d) ? JSON.stringify(d) === JSON.stringify(v) : d === v
    rows.push({
      key: k,
      value: Array.isArray(v) ? v.join('、') : v,
      isDefault,
      note: isDefault ? '（内置默认值 —— 换课时记得改）' : '',
    })
  }
  for (const k of Object.keys(VOCAB_DEFAULTS)) {
    const isDefault = JSON.stringify(VOCAB_DEFAULTS[k]) === JSON.stringify(L[k])
    rows.push({ key: k, value: L[k].join('、'), isDefault, note: isDefault ? '（内置默认值）' : '' })
  }
  return { rows, allDefault: isDefaultLayout(L) }
}
