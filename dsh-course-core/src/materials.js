/**
 * 材料归位建议引擎
 *
 * ── 为什么是「建议」而不是「自动归位」──────────────────────────────────
 * 老师拖进来一个文件夹，插件要判断「这份文件该去哪」。判错的后果很具体：
 * **文件进了别人家，而且不报错** —— 教案跑到另一个模块的 `详细教案/` 下，
 * 面板照常显示、批改照常跑，只是拿错了基准。这和「页码锚点不能猜」是同一个道理。
 *
 * 所以这里只产出**一个可改的清单**：
 *   { path, kind, target, module, why, confidence }
 * 老师逐条确认（改目录是下拉框），确认之后才落盘（见 host 的 materials.apply）。
 *
 * ── 判据从哪来：文件名与相对路径，不读内容 ────────────────────────────
 * 读内容会更准，但代价是：拖进来 500 个文件要先读一遍，而**绝大多数文件名
 * 已经说清楚了**（这门课的约定是 `模块三_计算机视觉分类与检测/详细教案/课时13_*.md`）。
 * 文件名说不清的那部分（`exam.pptx`、`笔记.md`）就老实报「待定」并说明原因，
 * 让老师一句话说清它是什么 —— 这比让插件猜准得多。
 *
 * `confidence` 只用来**排序与提示**（低置信度的排在前面，让老师先看），
 * 不用来做「自动通过」。没有哪一档是「不需要人看」。
 */

/** 允许的落点。写死是有意的：多一个落点就多一条老师要理解的规则。 */
export const TARGETS = [
  { key: 'root', title: '课程根目录', rel: '', need: '教学大纲、课程配置这类整门课的文件' },
  { key: 'slides', title: '课件数据', rel: '课程中心\\预览数据', need: '课件 json 与它的 media/' },
  { key: 'plans', title: '详细教案', rel: '<模块>\\详细教案', need: '课时N_*.md；要选模块' },
  { key: 'code', title: '示例代码', rel: '<模块>\\代码示例', need: '老师上课演示用的代码' },
  { key: 'res', title: '模块资源', rel: '<模块>\\资源', need: '数据集说明、参考链接、图片' },
  { key: 'pending', title: '待定（先不收）', rel: '', need: '文件名说不清它是什么，需要你指定' },
]

export const CODE_EXT = /\.(py|ipynb|r|m|cpp|c|h|java|js|ts|sh|bat|ps1|sql|go|rs|rb|php|yaml|yml|toml|cfg|ini)$/i
export const DOC_EXT = /\.(md|txt|pdf|docx?|pptx?|xlsx?)$/i
export const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp)$/i
export const MEDIA_EXT = /\.(mp4|mov|webm|avi|m4v)$/i

/** 从相对路径里认模块目录名（`模块三_计算机视觉分类与检测/...` → `模块三_计算机视觉分类与检测`） */
export function moduleFromPath(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/')
  for (const p of parts) if (/^模块[一二三四五六七八九十0-9]+[_\-]/.test(p)) return p
  return ''
}

/** 从文件名里认课时号（`课时13_xxx.md` → 13） */
export function lessonFromName(name) {
  const m = /课时\s*(\d+)/.exec(String(name || ''))
  return m ? Number(m[1]) : 0
}

/**
 * 给一个文件出建议。返回 { target, module, why, confidence }。
 * confidence: 1 = 文件名说得很清楚 · 0.6 = 靠扩展名推的 · 0 = 待定
 */
export function suggestOne(relPath, opts) {
  const o = opts || {}
  const rel = String(relPath || '').replace(/\\/g, '/')
  const name = rel.split('/').pop() || ''
  const mod = moduleFromPath(rel) || ''
  const modules = o.modules || []          // 已知模块目录名，用于「没写模块」时兜底
  const chapters = o.chapters || ['第一章', '第二章', '第三章']

  // ① 已经在某个已知子目录里 —— 老师拖的是**整棵正确的树**，别给他改
  if (/\/详细教案\//.test(rel) || /^详细教案\//.test(rel)) {
    return { target: 'plans', module: mod, why: '路径里已经写明是「详细教案」', confidence: 1 }
  }
  if (/\/代码示例\//.test(rel)) return { target: 'code', module: mod, why: '路径里已经写明是「代码示例」', confidence: 1 }
  if (/\/资源\//.test(rel)) return { target: 'res', module: mod, why: '路径里已经写明是「资源」', confidence: 1 }
  if (/预览数据/.test(rel)) return { target: 'slides', module: '', why: '路径里已经写明是课件数据', confidence: 1 }

  // ② 课程配置**必须先于**下面那条通用 json 规则判断 ——
  //    否则 `课程配置.json` 会落到「json 说不清是什么」的待定堆里，
  //    而它其实是最确定的一个（测试抓到的就是这个顺序错）。
  if (/^课程配置\.json$/i.test(name)) return { target: 'root', module: '', why: '课程配置', confidence: 1 }

  // ③ 课件数据：课程里的约定是 `课程中心/预览数据/<章>.json` + 同名 media 目录
  if (/\.json$/i.test(name)) {
    const stem = name.replace(/\.json$/i, '')
    if (chapters.indexOf(stem) >= 0) return { target: 'slides', module: '', why: '文件名就是章节名（第X章.json）', confidence: 1 }
    return { target: 'pending', module: '', why: 'json 说不清是课件还是配置 —— 请指定', confidence: 0 }
  }
  if (IMG_EXT.test(name) || MEDIA_EXT.test(name)) {
    // 课件媒体命名有硬约定：slide012_image34.png
    if (/^slide\d+_/i.test(name)) return { target: 'slides', module: '', why: '文件名是课件媒体命名（slideNNN_*）', confidence: 1 }
    return { target: 'res', module: mod, why: '图片/视频，按模块资源收', confidence: 0.6 }
  }

  // ③ 教案：`课时N_*.md` 最硬 —— 这门课的教案全是这个命名
  const no = lessonFromName(name)
  if (no && /\.md$/i.test(name)) {
    return { target: 'plans', module: mod, why: '文件名是「课时' + no + '_…」', confidence: mod ? 1 : 0.6 }
  }
  if (no && CODE_EXT.test(name)) {
    return { target: 'code', module: mod, why: '文件名带课时号，按示例代码收', confidence: mod ? 0.9 : 0.6 }
  }

  // ④ 整门课的文件：大纲、索引、配置
  if (/(大纲|索引|课程配置|课程地图|课程数据模型|教学计划|课程说明)/.test(name) && DOC_EXT.test(name)) {
    return { target: 'root', module: '', why: '整门课的文件（大纲/索引/配置）', confidence: 1 }
  }
  // ⑤ pptx：**不能直接收** —— 面板读的是转换后的课件 json，不是 pptx 本身
  if (/\.pptx?$/i.test(name)) {
    return {
      target: 'pending', module: '', confidence: 0,
      why: 'PowerPoint 源文件：面板读的是转换后的「第X章.json」，'
        + '直接收进来不会出现在课件页里。要么先用转换工具转，要么指定为模块资源留档',
    }
  }

  // ⑥ 模块说明：按模块资源收
  if (/^模块说明\.md$/i.test(name) || /^README\.md$/i.test(name)) {
    return { target: 'res', module: mod, why: '模块说明 / README', confidence: mod ? 0.8 : 0 }
  }

  // ⑦ 其余代码 / 文档：靠扩展名推，置信度低
  if (CODE_EXT.test(name)) return { target: 'code', module: mod || (modules[0] || ''), why: '代码文件（按扩展名推）', confidence: mod ? 0.6 : 0.3 }
  if (DOC_EXT.test(name)) return { target: 'plans', module: mod || (modules[0] || ''), why: '文档（按扩展名推，多半是教案）', confidence: mod ? 0.6 : 0.3 }

  return { target: 'pending', module: '', why: '认不出这是什么类型', confidence: 0 }
}

/**
 * 给一批文件出建议清单。
 *
 * 返回的对象里刻意分成两堆：
 *   suggested —— 有把握的（confidence > 0），默认全选
 *   uncertain —— 待定的（confidence === 0），**默认不选**，让老师先看
 * 「默认不选」很重要：如果待定的也默认勾上，老师一路点「确认」就会把
 * 认不出的文件也塞进某个目录里 —— 那正是我们要避免的静默错位。
 */
export function suggestPlacement(files, opts) {
  const list = Array.isArray(files) ? files : []
  const out = []
  for (const f of list) {
    const rel = String((f && (f.relPath || f.name)) || '')
    if (!rel) continue
    const s = suggestOne(rel, opts)
    out.push({
      relPath: rel, name: rel.split('/').pop(),
      bytes: (f && f.bytes) || 0,
      kind: s.target, module: s.module || '', why: s.why, confidence: s.confidence,
      // 待定的默认不选；其余默认选
      selected: s.confidence > 0,
      target: s.target,
    })
  }
  // 低置信度的排前面 —— 老师的时间该花在需要他判断的那些上
  out.sort((a, b) => (a.confidence - b.confidence) || a.relPath.localeCompare(b.relPath))
  const byKind = {}
  for (const x of out) byKind[x.kind] = (byKind[x.kind] || 0) + 1
  return {
    files: out,
    total: out.length,
    byKind,
    uncertain: out.filter((x) => x.confidence === 0).length,
    summary: TARGETS.filter((t) => byKind[t.key])
      .map((t) => t.title + ' ' + byKind[t.key] + ' 份').join('　'),
  }
}

/**
 * 把老师确认过的清单变成**真正要写的路径**。
 *
 * 三条防线，都是「宁可不写」：
 *   · 目标落点不在 TARGETS 里 → 拒绝（不让前端传任意路径进来）
 *   · `..` 或绝对路径 → 拒绝（zip 里可以塞这种东西）
 *   · 需要模块但没选模块 → 拒绝，并说清要选哪个
 * 返回 { writes: [{rel, from}], rejected: [{relPath, why}] } —— **不落盘**。
 */
export function planWrites(confirmed, opts) {
  const o = opts || {}
  const rootDir = o.rootDir || ''       // 课件数据要落在 <root>/课程中心/预览数据 下
  const writes = []
  const rejected = []
  const targetOf = (k) => TARGETS.find((t) => t.key === k) || null
  for (const f of (Array.isArray(confirmed) ? confirmed : [])) {
    const rel = String((f && f.relPath) || '')
    if (!rel) continue
    if (f.selected === false) continue
    if (rel.indexOf('..') >= 0 || /^[A-Za-z]:/.test(rel) || rel[0] === '/') {
      rejected.push({ relPath: rel, why: '路径不安全（含 .. 或绝对路径）' }); continue
    }
    const t = targetOf(f.target)
    if (!t) { rejected.push({ relPath: rel, why: '未知的落点：' + f.target }); continue }
    if (t.key === 'pending') { rejected.push({ relPath: rel, why: '还没指定落点' }); continue }
    let dir = ''
    if (t.key === 'plans' || t.key === 'code' || t.key === 'res') {
      if (!f.module) { rejected.push({ relPath: rel, why: '这一类要选一个模块（' + t.title + '）' }); continue }
      dir = f.module + '\\' + (t.key === 'plans' ? '详细教案' : (t.key === 'code' ? '代码示例' : '资源'))
    } else if (t.key === 'slides') {
      dir = '课程中心\\预览数据'
    }
    const name = rel.split('/').pop()
    writes.push({ rel: (dir ? (dir + '\\') : '') + name, from: rel, kind: t.key })
  }
  return { writes, rejected, rootDir }
}
