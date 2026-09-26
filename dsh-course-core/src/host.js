/**
 * dsh-course-core —— 学生端与教师端两个插件共享的宿主内核
 *
 * 为什么要有这个包：
 *   学生端和教师端必须是**两个可独立安装的插件**（各自的侧栏入口、各自的
 *   /cip-stu、/cip-tea 路由前缀）。但两边要做的事有大量重叠：解析课程结构索引、
 *   读课件、读教案、调模型、读写问题条目、按教案批改。
 *   如果各自复制一份，任何一处修 bug 都要改两遍，而且必然漂移 —— 这个项目里
 *   已经吃过一次亏（客户端和宿主对 m.file 的理解不一致，导致所有图片都加载不出来）。
 *
 * ⚠️ 路由前缀为什么必须是两个（这是 DSH 的硬约束，不是设计偏好）：
 *   webServer.register 对重复的 (kind, path) 会**直接抛错** ——
 *   路由模式属于「组合级契约」，撞车就是配置错误。
 *   所以两个插件各带自己的前缀，也正因为前缀不同，它们**可以装在同一个
 *   DSH 进程里同时运行**，这正是老师想在一台机器上对测两端的前提。
 *
 * 公共数据面（设计原则.md 第 2/3 条）：
 *   两个插件通过**同一个课程工作区目录**交换数据。工作区可以是：
 *     · 老师机：私有工作区（含全部模块、全部学生数据）
 *     · 学生机：clone 下来的公开仓（只含已发布内容）
 *   目录分工（每个位置只有一个写入方，因此不会互相覆盖）：
 *     课程问题池/公共/            老师写（策展后），学生读
 *     课程问题池/学生/<学号>/      该学生自己写，老师读
 *     作业提交/<学号>/            该学生自己写，老师读
 *     课程中心/                   课程数据（公开仓分发）
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
// 缓存层：派生数据（课程树 / 提交清单）的加速。单一事实来源仍是磁盘原始文件，
// 条目按来源 mtime+size 失效；缓存坏了只会退化成重算，不会让面板出错。
import { cached, statOf, sameStat, clearCache, cacheInfo, cacheDir } from './cache.js'
// L1「可配置」：这门课的形状（章节名/目录名/词表/教案骨架）从课程配置解析，
// 读不到就用内置默认值 —— 默认值就是这门课原来的形状。
import { resolveLayout, layoutReport } from './layout.js'
// 版本控制信息：这套面板与课程内容是哪个版本发出去的（老师要据此给学生一条克隆命令）
import { versionInfo, versionSummary } from './version.js'

// ── 工作区解析 ────────────────────────────────────────────────
const DEFAULT_WORKSPACE = 'C:\\Users\\Administrator\\Desktop\\暑期课程'

export function readWorkspaceFile(p) {
  try {
    const t = fs.readFileSync(p, 'utf8').trim()
    if (!t) return null
    const first = t.split(/\r?\n/).map((l) => l.replace(/^\uFEFF/, '').trim())
      .find((l) => l && l[0] !== '#' && l[0] !== ';')
    return first || null
  } catch (e) { return null }
}

/**
 * ── 工作区解析（支持多课程）─────────────────────────────────────────────
 *
 * 老师同时任教多门课，学生也各上各的课，所以「工作区」要能区分课程。
 *
 * 目录形状（推荐的共享式布局）：
 *
 *   <根>/                          共享课程内容：课件、预览图、插件、教案、教学大纲
 *     课程中心/课程结构索引.json
 *     课程/<课程码>/                每门课**只有私有数据**（体积很小：问题池 + 作业提交）
 *       课程问题池/公共|学生/
 *       作业提交/<学号>/
 *
 * 为什么共享内容不按课程复制：实测这门课的共享内容是 **105 MB / 489 文件**，
 * 而每门课的私有数据只有 **0.3 MB**。按课程复制共享内容，装 5 门课就是 500 MB
 * 的重复，且任何一次课件更新都要重复 5 遍。共享内容留在根目录，
 * 由发布工具把它写进每个课程的公开仓。
 *
 * 解析顺序（每一级都验证「像不像课程工作区」）：
 *   1. CIP_COURSE_DIR    直接指定课程目录（最高优先级，测试与多开都用它）
 *   2. CIP_WORKSPACE + CIP_COURSE_CODE   根目录 + 课程码 → <根>/课程/<码>
 *   3. CIP_WORKSPACE     旧布局：根目录本身就是一个课程
 *   4. 配置文件 → 内置默认值（同上两种形状都试）
 *
 * 兼容旧布局是刻意的：本次改动之前所有数据都在「根目录即课程」的形状里，
 * 直接要求迁移会让「改一行代码就跑不起来」。两种形状都能跑，
 * 迁移就能作为**独立的一步**去做与验证。
 */
export const COURSE_HOME_DIR = '课程'

/**
 * **每门课私有**的数据目录/文件。
 *
 * 为什么需要这份清单，而不是只靠「文件在哪」判断（见下面 abs() 的注释）：
 *   判据「课程目录里有这一项就用课程目录」对**已经存在**的东西是准的，
 *   但对**还没被创建**的东西是错的 —— 第一次写之前谁都不存在，于是落到了
 *   工作区根目录；而落下去之后它就在根目录里「存在」了，从此这门课的所有
 *   私有数据都跟着去了根目录。多课程共享式布局下，这等于把 A 班的答题
 *   和 B 班的混在一起，而且一切看起来都正常。
 *
 * 所以：这几项**永远**归课程目录，其余仍按「文件在哪」判断（课件、教案、
 * 结构索引是共享内容，必须留在根目录，不能一刀切）。
 * 新增私有数据目录时记得加进来 —— 加漏的症状就是上面那种「静默混课」。
 */
export const PRIVATE_RELS = ['课程问题池', '作业提交', '教案草稿', '课程配置.json', '学生名册.json', '我的身份.json']

/**
 * 一个目录「像不像课程工作区」。
 *
 * ⚠️ 判据是**结构索引文件**，不是「有 课程中心/ 目录」。
 *    踩过：课程目录里放了一份 课程配置.json（在 课程中心/ 下），
 *    于是那个课程目录自己满足「有课程中心」→ 解析时被当成工作区选走，
 *    结果「共享内容在根目录」这条布局完全失效（测试第 2/3/4 组全红）。
 *    结构索引是每门课唯一的骨架文件，拿它当判据最不容易误判。
 */
function looksLikeWorkspace(abs) {
  return fs.existsSync(path.join(abs, '课程中心', '课程结构索引.json'))
}

/** 列出根目录下所有课程（<根>/课程/<课程码>/）。 */
export function listCourses(rootAbs) {
  const base = path.join(rootAbs, COURSE_HOME_DIR)
  const out = []
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = path.join(base, e.name)
      // 配置放在课程目录**根部**，不放进 课程中心/ ——
      // 课程中心/ 是全校共享内容（索引、课件），往里面放每门课的东西会让
      // 「课程目录」看起来也像个工作区，解析时就会选错。
      const cfgFile = path.join(dir, '课程配置.json')
      let title = ''
      try { title = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).title || '' } catch (err) { /* 没有配置就用目录名 */ }
      out.push({ code: e.name, dir, title, hasConfig: !!title })
    }
  } catch (e) { /* 没有「课程」目录就是单课程布局 */ }
  return out.sort((a, b) => a.code.localeCompare(b.code))
}

/**
 * 解析课程工作区。
 *
 * @param {{defaultWorkspace?: string}} [opts]
 *        defaultWorkspace：最后一道兜底的目录。**只给测试用**。
 *        为什么要留这个口子：兜底值是 `DEFAULT_WORKSPACE`（教师机绝对路径），
 *        在教师本机上恰好存在，于是「所有候选都落空」那条分支**永远走不到** ——
 *        想验它就必须能在不改真实目录的前提下把兜底换掉。
 *        踩过的坑：试过用 Rename-Item 把真实工作区临时改名来制造落空，
 *        被系统拒绝（目录被运行中的 DSH 占着）—— 所以改成注入，不再动真实目录。
 */
export function resolveWorkspace(opts = {}) {
  const defaultWorkspace = opts.defaultWorkspace || DEFAULT_WORKSPACE
  const tried = []
  /** 候选：[说明, 目录, 课程码]；课程码为空表示「这个目录本身就是课程」 */
  const candidates = []
  const push = (how, dir, code) => candidates.push([how, dir, code || ''])

  // 1. 直接指定课程目录
  if (process.env.CIP_COURSE_DIR) push('环境变量 CIP_COURSE_DIR', process.env.CIP_COURSE_DIR, '')

  // 2/3. 根目录（+ 可选课程码）
  const roots = []
  if (process.env.CIP_WORKSPACE) roots.push(['环境变量 CIP_WORKSPACE', process.env.CIP_WORKSPACE])
  const wf = process.env.CIP_WORKSPACE_FILE || path.join(os.homedir(), '.dsh', 'cip-workspace.txt')
  const fromFile = readWorkspaceFile(wf)
  if (fromFile) roots.push(['配置文件 ' + wf, fromFile])
  roots.push(['内置默认值（教师机）', defaultWorkspace])

  const codes = []
  if (process.env.CIP_COURSE_CODE) codes.push(process.env.CIP_COURSE_CODE)
  // 没指定课程码时，**自动**挑：根目录下有「课程/」就用其中第一个（单课程时就是它）
  for (const [how, root] of roots) {
    const absRoot = path.resolve(root)
    // 顺序很重要：**先试课程码子目录，最后才试根目录本身**。
    // 共享式布局里根目录也有 课程中心/（共享内容），
    // 若把根目录排在前面，就会永远选不到「课程/<码>」那个课程目录。
    for (const code of codes) push(how + ' + 课程码 ' + code, absRoot, code)
    const found = listCourses(absRoot)
    for (const c of found) push(how + ' → 课程/' + c.code, absRoot, c.code)
    // 兜底：旧的「根目录本身就是课程」布局
    if (!found.length) push(how + '（单课程布局）', absRoot, '')
  }

  for (const [how, dir, code] of candidates) {
    const abs = code ? path.join(path.resolve(dir), COURSE_HOME_DIR, code) : path.resolve(dir)
    let target = abs
    // 课程目录里没有共享内容时，向上一层找（共享式布局里课程中心在根目录）。
    // 必须**逐级向上**找，不能只看一层 —— 根/课程/<码>/ 与 根/ 之间可能还有中间层。
    let hops = 0
    while (!looksLikeWorkspace(target) && hops < 3) {
      const up = path.dirname(target)
      if (up === target) break
      target = up; hops += 1
    }
    if (!looksLikeWorkspace(target)) continue
    const shared = target !== abs
    const label = how + ' → ' + target + (shared ? '（共享内容在上层）' : '')
    tried.push(label + ' ✓')
    return { dir: target, courseDir: abs, courseCode: code, how: label, tried, shared, resolved: true }
  }

  // ── 一个候选都没通过校验：**必须说人话，不能静默给一个不存在的目录** ──────────
  //
  // 为什么会走到这里：解析链的最后一环是 `DEFAULT_WORKSPACE`，而那是**教师机的
  // 绝对路径**（见文件顶部常量）。在教师本机上它恰好存在，于是永远命中、永远
  // 不报错 —— 换一台机器（新电脑、学生机、CI）就必然落空。
  //
  // 踩过的坑：原来的实现是
  //     return { dir: path.resolve(first[1]), how: first[0] + '（未验证）' }
  // 即「把第一个候选**原样**当成答案，只在文案里加个括号」。后果是插件带着一个
  // 不存在的目录继续往下跑：面板空着、没有任何一处报错，老师只能靠猜。
  //
  // 现在：dir 仍然给一个**能安全拼接的字符串**（保持向后兼容，避免下游 path.join 崩），
  // 但把「没解析成功」变成**机器可判的字段** resolved:false，并由 warn() 打出一条
  // 带修复办法的明确提示。
  const fallback = roots[roots.length - 1][1]
  return {
    dir: path.resolve(fallback),
    courseDir: path.resolve(fallback),
    courseCode: '',
    how: '未找到课程工作区（所有候选都没通过校验）',
    tried,
    shared: false,
    resolved: false,
    // 失败时提示里要给出**可照抄**的修复办法，所以把兜底值也带上
    defaultWorkspace,
  }
}

// ── 常量 ──────────────────────────────────────────────────────
export const CHAPTERS = ['第一章', '第二章', '第三章']
export const MODULES = ['模块一', '模块二', '模块三', '模块四', '模块五']
export const TYPES = ['概念问题', '代码报错', '环境问题', '数值稳定性', '作业疑问', '讲义问题', '内容建议']
export const SEVERITIES = ['阻塞', '高', '中', '低']
export const STATUSES = ['待处理', '已答复', '待复盘', '已沉淀', '转教案修订']
export const SOURCES = ['课堂', '作业', 'B站评论', '私聊', '答疑课', '自测', '阅读器框选图区', '阅读器拖选文字']
/**
 * 知识领域分类 —— **受控词表**，不给模型自由发挥。
 *
 * 为什么不用自由标签：问题一多，自由标签必然发散（「损失曲面」「损失函数」
 * 「loss landscape」会变成三个标签），检索反而更难。受控词表照课程骨架定，
 * 稳定、可枚举、且与教案模块能对上。
 *
 * 与 TYPES 正交，两个都要留：
 *   TYPES  = 问题的**性质**（概念没懂？环境炸了？）→ 决定老师怎么处理
 *   TOPICS = 涉及的**知识领域** → 决定去哪找、和谁重复
 */
export const TOPICS = [
  '数学推导',       // 线性代数、概率、矩阵化重构、公式变形
  '损失与优化',     // 损失曲面、优化器、正则化、泛化
  '工程与调试',     // 环境、报错、可复现性、随机性
  '训练技巧',       // 初始化、混合精度、Profiling、数据管道
  '视觉任务',       // 卷积、检测、分割、Transformer
  '多模态与3D',     // BEV、LiDAR、VLM、SAM
  '工作流与方法论',  // Vibe Coding、提示词、项目管理
  '其他',
]

export const SLIDES_DIR = '课程中心\\预览数据'
export const MEDIA_DIR_REL = '课程中心\\预览数据\\media'
export const INDEX_REL = '课程中心\\课程结构索引.json'

/**
 * ── 学生提交（作业）────────────────────────────────────────────────────
 *
 * 作业形态比「一个 .py 文件」多得多：手推公式是拍照、推导是打字的、
 * 实验报告是 md、notebook 是 .ipynb。所以提交要能装**文本 + 文件 + 图片**三类。
 *
 * 文件类型故意比课件宽松：课件只放行栅格图（避免误传工程文件），
 * 而作业可能是 pdf、zip、docx。仍然是一份**白名单**，只是更长。
 */
export const SUBMIT_EXT = (process.env.CIP_SUBMIT_EXT
  || '.py,.ipynb,.md,.txt,.yaml,.yml,.json,.csv,.tsv,.pdf,.zip,.png,.jpg,.jpeg,.webp,.gif,.tex,.r,.m,.cpp,.c,.h,.java,.js,.ts')
  .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
export function submitExtAllowed(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return m ? SUBMIT_EXT.indexOf('.' + m[1].toLowerCase()) >= 0 : false
}
/** 单个二进制附件上限（图片/PDF）。文本另有 MAX_SUB_BYTES 限制。 */
export const MAX_BLOB_BYTES = Number(process.env.CIP_MAX_BLOB_BYTES) > 0
  ? Number(process.env.CIP_MAX_BLOB_BYTES) : 12 * 1024 * 1024
/** 一次提交最多带几个附件。 */
export const MAX_SUBMIT_FILES = Number(process.env.CIP_MAX_SUBMIT_FILES) > 0
  ? Number(process.env.CIP_MAX_SUBMIT_FILES) : 8

/**
 * ── 课程标识（可配置） ────────────────────────────────────────────────
 *
 * 这个面板不是只为「深度学习」这一门课做的。要装到别的课上，需要变的
 * 只有下面几个值，所以它们**优先从工作区的 JSON 读**，读不到才用内置默认：
 *
 *     课程中心/课程配置.json
 *     {
 *       "title": "课程名", "code": "课程码", "term": "学期",
 *       "goal": "一句话课程目标", "note": "备注（显示在统计行右侧）"
 *     }
 *
 * ⚠️ 为什么只搬这几个字段（而不是 CHAPTRES/MODULES/TOPICS 一起搬）：
 *   那些是**枚举**，它们出现在受控词表、批改提示词、下拉框默认值里，
 *   散落在十几处。一次性全搬成「配置驱动」会让这次改动横跨所有视图，
 *   而现在的首要任务是先把界面版块逐块定下来 —— 界面定完之后再搬枚举，
 *   返工量最小。这里先解决「学生打开面板看到的是本课程的名字」这个
 *   最显眼的问题。（详见 课程中心/课程数据模型.md §3 的 7 处硬编码。）
 */
export const COURSE_DEFAULTS = {
  title: '深度学习课程',
  code: '',
  term: '',
  goal: '',
  note: '',
}
// 统一约定：课程配置在**各自目录的根部** ——
//   工作区（共享内容）: <工作区>/课程配置.json
//   每门课（私有）    : <根>/课程/<课程码>/课程配置.json
// 不再放在 课程中心/ 里：那个目录是全校共享内容，往里放每门课的东西会让
// 「课程目录」看起来也像个工作区，解析时会被选错（测试抓到过）。
export const COURSE_CONFIG_REL = '课程配置.json'

/**
 * 课程配置里**结构类**的字段：它们不是显示用的，而是决定插件怎么认这门课的文件。
 * readCourseConfig 必须把它们搬出来 —— 漏一个的症状是「配置写了、面板毫无反应」，
 * 而且不报错（端到端测试抓过一次：layout 与 topics 根本没传出来）。
 */
export const LAYOUT_PASSTHROUGH = ['layout', 'topics', 'issueTypes', 'severities', 'planSections']

/**
 * 读课程配置。**按顺序**在多个目录里找 课程配置.json，先找到的字段优先。
 *
 * 为什么要多个目录：共享式布局下每门课的配置在**课程目录**里
 * （它是每门课私有的），而旧的单课程布局里它在工作区根目录。
 * 只读一个地方就会出现「明明写了课程码，面板里却是空的」——
 * 而这个症状看起来像解析失败，其实只是读错了地方。
 *
 * 任何异常都退回默认值：配置坏了不该让面板打不开。
 */
export function readCourseConfig(dirs) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean)
  const out = Object.assign({}, COURSE_DEFAULTS, { source: '内置默认值' })
  const seen = []
  for (const dir of list) {
    const rel = path.join(dir, COURSE_CONFIG_REL)
    if (seen.indexOf(rel) >= 0) continue
    seen.push(rel)
    try {
      if (!fs.existsSync(rel)) continue
      const j = JSON.parse(fs.readFileSync(rel, 'utf8'))
      for (const k of Object.keys(COURSE_DEFAULTS)) {
        // 先找到的非空值优先：课程目录里的配置覆盖根目录的
        if (out[k] === COURSE_DEFAULTS[k] && typeof j[k] === 'string' && j[k]) out[k] = j[k]
      }
      // ── L1：结构类字段（layout / 词表 / 教案骨架）也要搬出来 ─────────────
      // ⚠️ 这一段是**端到端测试抓出来的漏**：原来只搬上面那 5 个字符串字段，
      //    于是 `layout`、`topics` 这类对象/数组**在读完配置的那一刻就被丢掉了** ——
      //    而 layout.js 明明会解析它们。症状是「配置写了、面板毫无反应」而且不报错：
      //    看起来像解析器坏了，其实是配置压根没传过去。
      //    凡是「换一门课就会不一样」的字段，都必须在这里显式列出来。
      for (const k of LAYOUT_PASSTHROUGH) {
        if (out[k] !== undefined) continue
        const v = j[k]
        if (v && typeof v === 'object') out[k] = v
      }
      if (out.source === '内置默认值') out.source = rel
    } catch (e) {
      out.source = '内置默认值（读取 ' + rel + ' 失败：' + String(e && e.message).slice(0, 80) + '）'
    }
  }
  return out
}

/** 公共数据面（见文件头注释） */
export const PUBLIC_ITEMS_REL = '课程问题池\\公共'
export const STUDENT_ITEMS_REL = '课程问题池\\学生'
export const SUBMIT_ROOT_REL = '作业提交'

export const SECTION_ORDER = ['原始提问', '现象', '初步判断', 'AI 答复', '处理结论', '复盘', '问题总结', '教师归档']
export const THREAD_TITLE = '追问记录'
export const MAX_THREAD_TURNS = Number(process.env.CIP_MAX_TURNS) > 0 ? Number(process.env.CIP_MAX_TURNS) : 40

export const MAX_SUB_BYTES = Number(process.env.CIP_MAX_SUB_BYTES) > 0 ? Number(process.env.CIP_MAX_SUB_BYTES) : 4 * 1024 * 1024
export const ALLOWED_EXT = (process.env.CIP_ALLOWED_EXT || '.py,.ipynb,.md,.txt,.yaml,.yml,.json,.csv,.tsv')
const VIDEO_EXT = /\.(mp4|mov|webm|avi|m4v)$/i
const RASTER_EXT = ['.webp', '.png', '.jpg', '.jpeg', '.gif']

// ── 纯工具 ────────────────────────────────────────────────────
export const oneLine = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
export const pad4 = (v) => { const n = String(v == null ? '' : v).replace(/\D/g, ''); return (n || '0').padStart(4, '0').slice(-4) }
export function today() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}
export function nowIso() { return new Date().toISOString() }
export function slugify(text, fallback) {
  const s = String(text || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '')
  return (s || fallback || 'item').slice(0, 40)
}
/** 学号/身份标识：只允许安全字符，避免用它拼路径时被穿越 */
export function safeId(v) {
  const s = String(v == null ? '' : v).replace(/[^A-Za-z0-9_\u4e00-\u9fa5.-]/g, '').replace(/^\.+/, '')
  return s.slice(0, 40)
}
export function extAllowed(nm) {
  const m = /\.([a-z0-9]+)$/i.exec(String(nm || ''))
  return m ? ALLOWED_EXT.split(',').map((x) => x.trim().toLowerCase()).indexOf('.' + m[1].toLowerCase()) >= 0 : false
}

function yamlValue(raw) {
  const v = String(raw == null ? '' : raw).trim()
  if (!v) return ''
  if (v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"')
  if (v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1)
  if (v[0] === '[') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : v } catch (e) { return v } }
  return v
}
export function parseMarkdown(text) {
  const n = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(n)
  if (!m) return { fields: {}, body: n }
  const fields = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line)
    if (kv) fields[kv[1]] = yamlValue(kv[2])
  }
  return { fields, body: n.slice(m[0].length) }
}
export function parseSections(body) {
  const out = []
  const text = String(body == null ? '' : body)
  const re = /^##\s+(.+)$/gm
  const hits = []
  let m = re.exec(text)
  while (m !== null) { hits.push({ title: m[1].trim(), start: m.index, end: m.index + m[0].length }); m = re.exec(text) }
  for (let i = 0; i < hits.length; i += 1) {
    const stop = i + 1 < hits.length ? hits[i + 1].start : text.length
    out.push({ title: hits[i].title, content: text.slice(hits[i].end, stop).trim() })
  }
  if (!out.length && text.trim()) out.push({ title: '正文', content: text.trim() })
  return out
}
export function sectionOf(body, title, fb) {
  for (const s of parseSections(body)) if (s.title === title) return s.content || fb
  return fb
}
export function fold(title, value) {
  const t = String(value == null ? '' : value).replace(/\s+$/, '')
  return t ? '## ' + title + '\n\n' + t + '\n' : ''
}
const esc = (v) => '"' + oneLine(v).replace(/"/g, "'") + '"'
export function serialize(fields, body) {
  // ⚠️ 这是一个**白名单**：不在 order 里的字段会被静默丢掉，不报错。
  //    已经踩过两次：slideSeq（提问来自第几个课件课时）与 evidence（跨页证据块数）
  //    都写进了 fields 却没进这个列表，条目文件里根本找不到 —— 而下游全都正常，
  //    所以只有「断言文件内容」的测试才抓得到。新增字段记得往这里加。
  const order = ['id', 'title', 'summary', 'topic', 'concept', 'loc', 'source', 'module', 'lesson', 'type', 'severity', 'status',
    'created', 'updated', 'reporter', 'student', 'audit', 'owner', 'related_files', 'ai', 'tokens',
    'faq_id', 'linked_issue', 'common', 'slideSeq', 'evidence']
  const lines = ['---']
  for (const k of order) {
    const v = fields[k]
    if (v === undefined || v === null || v === '') continue
    // 数字不加引号：slideSeq 之类是编号，写成 "3" 迟早有人按字符串比较
    lines.push(k + ': ' + (Array.isArray(v) ? JSON.stringify(v) : (typeof v === 'number' ? String(v) : esc(v))))
  }
  lines.push('---', '')
  return lines.join('\n') + String(body || '').replace(/^\n+/, '')
}
export function pickEnum(v, allowed, fallback) {
  const s = oneLine(v)
  return allowed.indexOf(s) >= 0 ? s : fallback
}

// ── 追问线程（结构化存 JSON，和给人读的 md 分开）──────────────
// 为什么不用 md 里的一个小节存线程：多轮问答里有代码块、$公式$、换行，
// 塞进 `## 追问记录` 再解析回来非常容易出错（转义、缩进、空行都会被吃掉）。
// md 保持「给人看」，线程用 JSON 保持「给程序读写」。
export function threadPathFor(itemRel) { return itemRel.replace(/\.md$/i, '') + '.thread.json' }
export function readThread(absThread) {
  try { const j = JSON.parse(fs.readFileSync(absThread, 'utf8')); return Array.isArray(j.turns) ? j.turns : [] } catch (e) { return [] }
}
export function writeThread(absThread, turns) {
  fs.mkdirSync(path.dirname(absThread), { recursive: true })
  fs.writeFileSync(absThread, JSON.stringify({ updatedAt: nowIso(), turns }, null, 2), 'utf8')
}
/** 渲染线程为 md 小节（只用于人读，程序不从这里解析回去） */
export function renderThread(turns) {
  if (!turns.length) return ''
  const parts = ['## ' + THREAD_TITLE + '\n']
  turns.forEach((t, i) => {
    parts.push('**第 ' + (i + 1) + ' 轮追问**\n\n' + String(t.q || '').trim() + '\n')
    parts.push('**AI 作答**\n\n' + String(t.a || '').trim() + '\n')
  })
  return parts.join('\n')
}

// ── 模型调用 ──────────────────────────────────────────────────
export const STUDENT_SYSTEM = [
  '你是一位深度学习课程的助教，正在回答学生的提问。',
  '课程风格：必须回到数学推导与机制，不接受只给结论或只背 API。',
  '要求：',
  '1. 如果消息里带了图片，那是学生从课件里框选的一块，请先读懂它，再回答。',
  '2. 先直接回答学生问的那一点，不要复述问题。',
  '3. 数学公式一律用 LaTeX 写在 $...$ 或 $$...$$ 里。',
  '4. 指出学生可能的误区。',
  '5. 如果有可执行的自查步骤，给出具体做法。',
  '6. 控制在 400 字以内，不要客套话。',
  '7. 如果不确定，直接说不确定，不要编造。',
  '8. 这是多轮对话，后面每一轮都要给完整回答，不要说「同上」「见上」。',
].join('\n')

export const TITLE_SYSTEM = [
  '你在为深度学习课程的「问题池」拟标题。',
  '任务：把一次学生提问凝练成**一句话标题**，让老师扫一眼就知道这条问的是什么。',
  '',
  '风格要求（必须严格统一，因为整个问题池要看起来像一个人写的）：',
  '- 12–24 个汉字，单行，不加标点结尾。',
  '- 以问句或陈述句直陈困惑点，例如「为什么负特征值意味着鞍点」「Adam 二阶矩为何要偏差校正」。',
  '- 用课程里的术语，不要用「关于…的问题」「求助」「请问」这类外壳。',
  '- 不要包含课时号、日期、学号。',
  '',
  '只输出标题本身，不要引号、不要解释、不要换行。',
].join('\n')

/**
 * 标题 + 分类，一次产出（见 prompt.js 的 makeFacets）。
 * 强行要求 JSON：分类必须是受控词表里的一个，概念标签用课程术语。
 */
export const FACETS_SYSTEM = [
  '你在为深度学习课程的「问题池」做条目整理。给你一次学生提问，你要同时输出三样东西。',
  '',
  '【title】凝练成一句话标题。风格要求（整个问题池要看起来像同一个人写的）：',
  '- 12–24 个汉字，单行，不加标点结尾。',
  '- 以问句或陈述句直陈困惑点，例如「为什么负特征值意味着鞍点」。',
  '- 用课程里的术语，不要「关于…的问题」「求助」「请问」这类外壳。',
  '- 不含课时号、日期、学号。',
  '',
  '【topic】这条提问涉及的**知识领域**，必须从下面这个列表里**原样选一个**：',
  TOPICS.map((t) => '  - ' + t).join('\n'),
  '选不出来就用「其他」。不要自己造词，不要输出列表外的值。',
  '',
  '【concept】这条提问真正卡住的**具体概念**，2–12 字，用课程里的术语',
  '（例如「Hessian 负特征值」「Adam 偏差校正」「Einops 内存布局」）。',
  '最多 3 个词，用「、」分隔。不要写句子、不要写「学生不懂」这类空话。',
  '',
  '只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
  '{"title":"...","topic":"...","concept":"..."}',
].join('\n')

export const SUMMARY_SYSTEM = [
  '你在为深度学习课程的问题池做「问题总结」。',
  '给你一段学生提问与 AI 的往返问答，请输出两到三句话的凝练总结，包含：',
  '① 学生真正卡住的概念是什么；② 结论是什么。',
  '风格与标题保持一致：直陈、用课程术语、不客套。不要写「该学生」「本文」这类词。',
  '只输出总结正文，不要标题行。',
].join('\n')

export const GRADER_SYSTEM = [
  '你是一位深度学习课程的助教，正在批改学生作业。',
  '下面会给你：① 本课时教案（含学习目标与验收标准）② 学生提交的代码 ③ 批改维度表。',
  '批改原则（很重要）：',
  '- 以教案为准。教案要求学生用的方法（例如“仅用 NumPy 手写”），就不要因为学生用了 sklearn 而给高分——那正是本次要检查的对齐点。',
  '- 逐条对照教案的《验收标准》小节，逐条给出通过/不通过/无法判断与证据。',
  '- 不要给出最终分数或等级。你只做客观初筛与证据列举，成绩判定由教师完成。',
  '- 指出具体行号或代码片段作为证据；没有证据的判断不要写。',
  '- 数学式子用 LaTeX（$...$）。',
  '- 最后用 `### 问题清单` 起一节，逐条列出发现的问题，每条一行，格式：`- [严重度] 问题描述（证据）`。严重度取 阻塞/高/中/低。',
  '  这一节会被程序解析出来存进问题池，所以格式必须严格。',
].join('\n')

/**
 * 从批改正文里取出《问题清单》小节。
 *
 * ⚠️ 这里曾经错过一次：GRADER_SYSTEM 要求模型输出 `### 问题清单`（三级标题，
 *    因为它挂在批改正文的二级结构下面），但取小节用的 sectionOf() 只认 `##`。
 *    结果模型老老实实按格式输出了，解析器却一条也取不到 —— 问题池永远是空的，
 *    而正文看起来完全正常，极难发现。
 *    教训：解析器的语义必须和提示词的字面要求对齐；对齐不了就在解析侧兼容。
 */
export function issueSection(answer) {
  const text = String(answer || '')
  // 先按 ## （模型有时会升格），再按 ###
  const byTwo = sectionOf(text, '问题清单', '')
  if (oneLine(byTwo)) return byTwo
  const re = /^#{2,4}\s*问题清单\s*$/m
  const m = re.exec(text)
  if (!m) return ''
  const rest = text.slice(m.index + m[0].length)
  const next = /^#{2,4}\s+\S/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/** 解析批改输出末尾的《问题清单》小节，转成结构化问题 */
export function parseIssueList(answer) {
  const body = issueSection(answer)
  const out = []
  for (const line of String(body).split('\n')) {
    const m = /^\s*[-*]\s*\[(阻塞|高|中|低)\]\s*(.+?)\s*$/.exec(line)
    if (m) out.push({ severity: m[1], text: oneLine(m[2]) })
  }
  return out
}

/**
 * 把检索型模型的调用接进来 —— 一次模型调用，返回文本 + token 用量。
 * 用量用于把费用归到发起方。
 *
 * `choice` 允许调用方指定 provider/model/reasoningEffort（学生在面板上选的）。
 * 不指定时沿用 DSH 会话当前的模型选择 —— 但**不猜**：读不到就明确说读不到，
 * 而不是悄悄塞一个默认模型进去。原来 fallback 到 'deepseek-flash'，
 * 结果是「面板显示用的是我选的模型、实际跑的是另一个」，而日志里看不出来。
 */
export async function callModel(ctx, { system, messages, trace, choice }) {
  const log = trace || []
  const llm = ctx.get('llm')
  if (llm === undefined) { log.push('llm 不可用'); throw new Error('llm 服务不可用') }
  const picked = choice && choice.provider && choice.model ? choice : null
  const selector = ctx.get('agentDefaultModel')
  let sel = null
  try { sel = selector && typeof selector.currentSelection === 'function' ? selector.currentSelection() : null } catch (e) { sel = null }
  const src = picked || sel
  if (!src || !src.provider || !src.model) {
    log.push('拿不到 provider/model')
    throw new Error('拿不到模型选择：面板里选一个模型，或先在 DSH 里设置默认模型')
  }
  const provider = src.provider
  const model = src.model
  const effort = picked ? picked.reasoningEffort : src.reasoningEffort
  log.push('模型: ' + provider + '/' + model + (effort ? (' (effort=' + effort + ')') : '') + (picked ? ' [面板指定]' : ' [会话默认]'))
  let answer = ''
  let failure = ''
  const usage = { inputTokens: 0, outputTokens: 0 }
  const req = { provider, model, messages, system }
  if (effort) req.reasoningEffort = effort
  for await (const chunk of llm.stream(req)) {
    if (chunk.type === 'text-delta') answer += chunk.text
    if (chunk.type === 'usage' && chunk.usage) {
      usage.inputTokens += Number(chunk.usage.inputTokens || 0)
      usage.outputTokens += Number(chunk.usage.outputTokens || 0)
    }
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      failure = (chunk.reason.failure && chunk.reason.failure.message) || 'unknown'
    }
  }
  if (failure) { log.push('模型报错: ' + failure); throw new Error('模型返回错误：' + failure) }
  if (!oneLine(answer)) throw new Error('模型未返回文本内容')
  log.push('回包字符数: ' + answer.length + ' · tokens in/out ' + usage.inputTokens + '/' + usage.outputTokens)
  return { text: answer.trim(), usage, provider, model, reasoningEffort: effort || '' }
}

/**
 * 可选模型目录 —— 给学生端的「用哪个模型回答」下拉框用。
 *
 * 为什么需要这个：DSH 自己的模型选择是**整场会话**级别的，而学生的问题是
 * 「这一条我想用便宜/快的，那一条我想用强的」。两者不是一回事，
 * 所以面板要能按提问单独指定。
 *
 * 任何一步失败都退化成「只有会话默认那一项」，绝不因为目录拿不到就打不开面板。
 */
export async function listModelCatalog(ctx) {
  const out = { providers: [], models: [], current: null, warnings: [] }
  try {
    const selector = ctx.get('agentDefaultModel')
    const sel = selector && typeof selector.currentSelection === 'function' ? selector.currentSelection() : null
    if (sel && sel.provider && sel.model) out.current = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || '' }
  } catch (e) { out.warnings.push('读会话默认模型失败：' + oneLine(e && e.message)) }
  const llm = ctx.get('llm')
  if (llm === undefined) { out.warnings.push('llm 服务不可用，只能使用会话默认模型'); return out }
  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? (llm.listProviders() || []) : []
  } catch (e) { out.warnings.push('列 provider 失败：' + oneLine(e && e.message)) }
  for (const p of providers) {
    const pid = p && (p.id || p.provider)
    if (!pid) continue
    out.providers.push({ id: pid, name: (p && p.name) || pid })
    try {
      const list = typeof llm.listModels === 'function' ? (await llm.listModels(pid)) : []
      for (const m of (list || [])) {
        if (!m || !m.id) continue
        out.models.push({
          provider: pid, model: m.id, name: m.name || m.id,
          description: m.description || '',
          // 能不能看图，直接决定「框选截图提问」这条路走不走得通
          image: !!(m.inputModalities && m.inputModalities.indexOf('image') >= 0),
        })
      }
    } catch (e) { out.warnings.push('列 ' + pid + ' 的模型失败：' + oneLine(e && e.message)) }
  }
  // 会话默认那个模型如果不在目录里，也要出现在下拉框里 —— 否则用户会发现
  // 「当前用的模型选不到」，只能被迫改用别的。
  if (out.current) {
    const has = out.models.some((m) => m.provider === out.current.provider && m.model === out.current.model)
    if (!has) out.models.unshift({ provider: out.current.provider, model: out.current.model, name: out.current.model + '（会话默认）', description: '', image: null, offCatalog: true })
  }
  return out
}

/**
 * 没解析到课程工作区时，打出一组**能照做**的提示。
 *
 * 为什么值得单独成函数：
 *   1. 这是新机器上最先撞到的坑，而且原来完全静默 —— 解析链的兜底是
 *      `DEFAULT_WORKSPACE`（**教师机的绝对路径**），在教师本机上恰好存在，
 *      所以这条分支永远走不到，也就永远没人发现提示有问题。
 *   2. 分支走不到 = 没法用 createCore 端到端触发（本机默认路径确实存在）。
 *      抽成纯函数之后可以直接喂一个 resolved:false 的 WS 来验，
 *      不需要为了造场景去动真实目录（试过 Rename，被运行中的 DSH 占着，拒了）。
 *
 * @param {{resolved?:boolean,tried?:string[],how?:string}} WS resolveWorkspace() 的结果
 * @param {string} workspace 解析出来的目录（可能并不存在）
 * @param {string} label 插件显示名，用于前缀
 * @param {{warning?:(...a:any[])=>void}} [logger] 默认 console
 * @returns {boolean} 是否真的打了提示
 */
export function reportUnresolvedWorkspace(WS, workspace, label, logger = console) {
  if (WS && WS.resolved !== false) return false
  const warn = logger.warning || logger.warn
  if (typeof warn !== 'function') return false
  const p = (s) => warn.call(logger, '[' + label + '] ' + s)
  p('⚠ 没找到课程工作区：' + workspace)
  p('   最常见的原因是：这是另一台机器（新电脑/学生机/CI），而解析链的兜底是一个'
    + '"教师机绝对路径"，只在教师本机上成立。')
  p('   修法（任选一条，改完重启 DSH）：')
  p('     ① 设环境变量 CIP_WORKSPACE=<你的课程工作区目录>')
  p('     ② 或把这一行目录写进 ' + path.join(os.homedir(), '.dsh', 'cip-workspace.txt'))
  p('        （在课程仓根目录跑 templates/install.ps1 会自动写）')
  p('     ③ 共享式布局再加 CIP_COURSE_CODE=<课程码>，定位到 <根>' + path.sep + '课程' + path.sep + '<课程码>')
  p('   判据：该目录下要有「课程中心' + path.sep + '课程结构索引.json」。')
  p('   尝试过的候选：' + (WS && WS.tried && WS.tried.length ? WS.tried.join(' | ') : '（一个都没通过校验）'))
  return true
}

export function msg(role, text, provider, model) {
  const base = { id: 'cip-' + Math.random().toString(36).slice(2), role, content: [{ type: 'text', text }] }
  if (role === 'assistant') base.source = { kind: 'model', provider: provider || 'unknown', model: model || 'unknown' }
  else base.source = { kind: 'plugin', plugin: 'course-panel' }
  return base
}

// ── 核心：把所有共享能力装进一个 ctx ───────────────────────────
/**
 * @param ctx     Cordis 上下文
 * @param opts.prefix      本插件的路由前缀，例如 '/cip-stu'
 * @param opts.role        'student' | 'teacher'
 * @param opts.pkgRoot     本插件包根（用于找自带的 katex/css）
 * @param opts.label       日志用名字
 */
export function createCore(ctx, opts) {
  const { prefix, role, pkgRoot, label } = opts
  const isTeacher = role === 'teacher'
  const WS = resolveWorkspace()
  const WORKSPACE = WS.dir
  /**
   * 课程私有数据的根。共享式布局里它是 <根>/课程/<课程码>，旧布局里等于 WORKSPACE。
   *
   * ⚠️ 是 `let` 而不是 `const`：老师可以**在面板里换课**（见下面的 useCourse）。
   *    这不只是省一次重启 —— `abs()`、`courseAbs()`、`COURSE` 全都读它，
   *    热切换能在**同一个同步块里**把三个一起换掉，Node 是单线程的，
   *    所以不存在「一个请求读到半切换状态」的窗口。
   *    若改成异步（比如 await 一下再换），那个窗口就出现了，而且是静默串数据。
   */
  let COURSE_DIR = WS.courseDir || WS.dir
  const fsMod = ctx.get('fs')
  // katex 与样式表是**核心包**自带的，不是各插件自带的 —— 只维护一份。
  // （pkgRoot 是各插件自己的包根，那里只有它的 client.js。）
  const CORE_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib')
  const katexDir = process.env.CIP_KATEX_DIR || path.join(CORE_LIB, 'katex')
  const cache = {
    slides: null, slidesAt: 0, chapterCode: '', mediaOk: null, mediaError: '',
    index: null, indexAt: 0, tree: null, katexOk: fs.existsSync(path.join(katexDir, 'katex.min.js')),
  }
  const P = {
    media: prefix + '-media', katex: prefix + '-katex', css: prefix + '.css', api: prefix + '-api',
    // 提交附件与提问截图（各自独立前缀，避免与上面几个前缀二义）
    sub: prefix + '-sub', shot: prefix + '-shot',
    // 诊断页走独立前缀：与 .css 那个前缀不重叠，避免前缀路由二义
    diag: prefix + '-diag',
  }
  if (!cache.mediaOk && ctx.webServer !== undefined) cache.mediaOk = true
  if (!cache.mediaOk) cache.mediaError = 'webServer 不可用'

  /**
   * 相对路径 → 绝对路径。
   *
   * ⚠️ 这里有一个**归属判断**：问题池与作业提交是每门课私有数据，
   *    在共享式布局下它们住在 <根>/课程/<课程码>/ 里；而课件、教案、
   *    课程结构索引是全校共享内容，住在根目录。
   *    判断方式**两条**：先看 rel 的第一段是不是 PRIVATE_RELS 里的私有项
   *    （私有项永远归课程目录）；不是的话再用「课程目录里有没有这一项」——
   *    不写死一份共享内容清单，因为清单会在新增课件目录时悄悄过期。
   *    旧的单课程布局下 COURSE_DIR === WORKSPACE，两边一致，行为不变。
   */
  const abs = (rel) => {
    if (/^[A-Za-z]:/.test(rel)) return rel
    if (COURSE_DIR !== WORKSPACE) {
      // 私有数据看**清单**（首次写入前磁盘上还不存在，靠 exists 判断必然判错）
      const first = String(rel).split(/[\\/]/)[0]
      if (PRIVATE_RELS.indexOf(first) >= 0) return path.join(COURSE_DIR, rel)
      const inCourse = path.join(COURSE_DIR, rel)
      if (fs.existsSync(inCourse)) return inCourse
    }
    return path.join(WORKSPACE, rel)
  }
  // 课程标识：工作区可覆盖（见 COURSE_DEFAULTS 注释）。放在这里而不是模块顶层，
  // 是因为它依赖 WORKSPACE —— 写死在模块顶层会让「换一门课」变成「改代码」。
  // 课程配置优先读课程目录（每门课自己的课程码/课程名），没有再看根目录。
  let COURSE = readCourseConfig([COURSE_DIR, WORKSPACE])

  /**
   * ── L1：把「这门课的形状」从配置里取出来 ──────────────────────────────
   *
   * 下面这几个名字与**模块级常量同名**，这是有意的：局部声明会遮蔽模块级的，
   * 于是 createCore 里那几十处 `INDEX_REL` / `SLIDES_DIR` 一个字都不用改，
   * 就全部跟着配置走了。改 6 行 vs 改 270 处 —— 而后者必然漏。
   *
   * 模块级那份仍然保留：工具脚本（course-repo.mjs 等）在 createCore 之外用它，
   * 拿的就是默认形状。两边都以 layout.js 的默认值为准，所以不会漂移。
   *
   * ⚠️ 还没跟着走的地方（下一轮）：`plan.js` 的 `indexAbs()` 用的是
   *    **模块级** INDEX_REL（它 import 的是模块导出，遮蔽影响不到它）。
   *    所以换课时索引重建仍指向默认路径 —— 这是已知的、待接的一处。
   */
  const LAYOUT = resolveLayout(COURSE)
  const INDEX_REL = LAYOUT.indexRel
  const SLIDES_DIR = LAYOUT.slidesDir
  const MEDIA_DIR_REL = LAYOUT.slidesDir + '\\' + LAYOUT.mediaSub
  const PUBLIC_ITEMS_REL = LAYOUT.questionsRel + '\\公共'
  const STUDENT_ITEMS_REL = LAYOUT.questionsRel + '\\学生'
  const SUBMIT_ROOT_REL = LAYOUT.submitRel
  /**
   * 读文本。第二个参数是**编码**，默认 utf8。
   * 之所以要支持别的编码：批改时要把学生拍的照片读成 base64 发进模型消息，
   * 而那张图是二进制的 —— 用 utf8 读二进制会得到一堆替换字符（不报错，但图废了），
   * 症状是「模型说图看不清」，很难往编码上想。
   */
  const readText = (rel, enc) => fs.readFileSync(abs(rel), enc || 'utf8')
  const writeText = (rel, c) => { const p = abs(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8') }
  /**
   * 写**二进制**。与 writeText 分开是必须的，不是洁癖：
   * writeText 固定传 'utf8'，用它写 Buffer 会先按 utf8 解码再编码回去 ——
   * 非法字节被替换成 U+FFFD，文件就不再是那张图了，而且**不报错**。
   * 症状是「存的截图/附件打开是坏的」，很难往编码上想。
   */
  const writeBytes = (rel, buf) => { const p = abs(rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf) }
  const exists = (rel) => fs.existsSync(abs(rel))
  const listDir = (rel) => { try { return fs.readdirSync(abs(rel), { withFileTypes: true }) } catch (e) { return [] } }

  // ── 课程结构 ──
  /**
   * 清掉本进程内存里的派生数据。
   *
   * 为什么需要它（而不是等 TTL）：树的内存层**没有过期时间** ——
   * 它只在「索引或教案目录的 mtime 变了」时才该重算。而 mtime 变化
   * 发生在**同一个进程刚刚写完文件之后**（老师采纳教案草稿、重建索引），
   * 那时候没有任何东西会去重新比对指纹，于是面板会一直显示旧结论：
   * 「已经采纳了，可面板还写着教案未撰写」。这是必须显式失效的场景。
   */
  function invalidateCache() {
    cache.index = null; cache.indexAt = 0
    cache.tree = null
    cache.slides = null; cache.slidesAt = 0; cache.chapterCode = ''
    try { clearCache(WORKSPACE) } catch (e) { /* 磁盘快照清不掉不影响正确性 */ }
    return true
  }

  /**
   * 换一门课 —— **不重启**。
   *
   * 老师同时教几门课时，「切课」是低频但必须顺手的动作：一门课一个面板、
   * 每次切都重启 DSH，那这个功能等于没有。而热切换在这里是安全的，
   * 因为要换的三样（COURSE_DIR / COURSE / 所有缓存）能在**一个同步块**里换完 ——
   * Node 单线程，中间插不进任何别的请求。一旦这里出现 await，就会出现
   * 「请求读到 A 课的目录、B 课的配置」这种静默串数据，所以这个函数
   * **必须是同步的**，不要为了「顺便读一下配置」而改成 async。
   *
   * 为什么共享内容（课件/教案/结构索引）不跟着换：它们是全校一份，
   * 住在工作区根目录，换课只换**私有数据**那一半（问题池、作业、草稿、名册）。
   */
  function useCourse(code) {
    const want = oneLine(code)
    const root = WORKSPACE
    // 指定了课程码就必须找到它 —— **不能**找不到就悄悄回落到根目录。
    // 「切到 B 课，结果你还在看 A 课的数据」是这类功能最坏的失败方式：
    // 界面一切正常，而老师在给 B 班讲 A 班的问题。
    if (want) {
      const dir = path.join(root, COURSE_HOME_DIR, want)
      if (!fs.existsSync(dir)) {
        const have = listCourses(root).map((c) => c.code)
        throw new Error('课程目录不存在：' + dir
          + (have.length ? ('　可切的课：' + have.join('、')) : '　（' + root + ' 下没有「' + COURSE_HOME_DIR + '」目录）'))
      }
      COURSE_DIR = dir
      COURSE = readCourseConfig([COURSE_DIR, WORKSPACE])
      invalidateCache()
      return { ok: true, code: COURSE.code || want, dir: COURSE_DIR, shared: COURSE_DIR !== WORKSPACE }
    }
    // 空课程码 = 回到「根目录本身即课程」的旧布局（单课程机器上就是这一档）
    COURSE_DIR = root
    COURSE = readCourseConfig([COURSE_DIR, WORKSPACE])
    invalidateCache()
    return { ok: true, code: COURSE.code || '', dir: COURSE_DIR, shared: false }
  }

  async function loadIndex() {
    if (cache.index && Date.now() - cache.indexAt < 120000) return cache.index
    if (!exists(INDEX_REL)) return null
    const data = JSON.parse(readText(INDEX_REL))
    // 这里**不能**顺手把 cache.tree 清掉：内存层 2 分钟会过期一次，
    // 若那次过期同时废掉树，磁盘快照就永远用不上 —— 树是否有效由它自己的
    // 指纹（索引 + 教案目录的 mtime）决定，不该由索引的内存过期时间决定。
    cache.index = data; cache.indexAt = Date.now()
    return data
  }
  /**
   * 课程树。
   *
   * ⚠️ `hasPlan` / `planPath` **必须**和 `lesson.open` 走同一套解析（`planPathFor`）。
   *
   * 踩过的坑（端侧实测，学生机器上真实复现）：这里原来自己拼一条教师机路径 ——
   *     hasPlan: !!(l.plan && fs.existsSync(abs(m.dir + '\\' + m.planDir + '\\' + l.plan)))
   * 而公开仓里教案是**平铺**在 `教案/<模块>/` 下的，学生机上没有 `<模块>\\详细教案\\`
   * 这个目录 → 30 个课时全部 `hasPlan=false`。
   * 可 `lesson.open` 走的是 `planPathFor()`，它有三条兜底（课程.json / 模块目录 / 平铺目录），
   * 所以**同一份教案，一个页面说有、另一个页面说没有** ——
   * 鱼骨图整张在喊「这里没教案」，而那 6 份教案其实都在。
   *
   * 所以这里改成逐课时问 `planPathFor()`，不再另写一套路径拼接。
   * 之前把 `buildTree` 写成同步的没有理由 —— `getTree` 本来就是 async。
   */
  async function buildTree(idx) {
    if (!idx) return null
    // 「已发布」以 课程.json 为准（它才是老师发布动作的产物）。
    // 读不到时退回「有教案即已发布」—— 教师机就是这种情形（本地直接有教案文件，
    // 但没有 课程.json，因为那是发布工具生成的）。两条路都给一个明确布尔值，
    // 绝不能再让客户端拿 undefined 去判断。
    const pub = publishedFromCourseJson()
    const mods = []
    for (const m of idx.modules || []) {
      const lessons = []
      for (const l of m.lessons || []) {
        const rel = await planPathFor(l.no)
        lessons.push(Object.assign({}, l, {
          hasPlan: !!rel,
          planPath: rel,
          published: pub.fromJson ? pub.nos.has(Number(l.no)) : !!rel,
        }))
      }
      mods.push({
        name: m.name, theme: m.theme || '', range: m.range || '',
        dir: m.dir || '', planDir: m.planDir || '',
        lessons,
      })
    }
    return { course: idx.course, totalLessons: idx.totalLessons, modules: mods, gradingDimensions: idx.gradingDimensions || [] }
  }
  /**
   * 课程树。
   *
   * `hasPlan` 要对每个课时做一次 `existsSync`（30 次），而它只在
   * 「索引变了」或「教案目录变了」时才可能变。所以：
   *   指纹 = 索引文件 + 各模块的教案目录，任一 mtime 变化就整体重算。
   * 只缓存**这一份派生结果**，不缓存 AI 相关数据 —— 那是学生的钱换来的，
   * 缓存错位会给出「看起来对、其实答的是别的问题」的内容。
   */
  async function getTree(traces) {
    if (cache.tree) { if (traces) traces.push('缓存命中: tree(内存)'); return cache.tree }
    const idx = await loadIndex()
    if (!idx) return null
    const stamp = treeStamp(idx)
    cache.tree = await cached(WORKSPACE, 'tree', stamp, () => buildTree(idx), traces)
    return cache.tree
  }

  /**
   * 课程树的指纹：索引文件本身 + 每个模块的教案目录 + **平铺的 `教案/` 目录**。
   *
   * 为什么要带目录 mtime：`hasPlan` 取决于**教案文件在不在**，
   * 而新增一份教案**不会**改索引文件。只盯索引的话，老师刚写完教案，
   * 面板还会说「教案未撰写」——那正是最需要它说对的时候。
   *
   * 为什么还要加 `教案/`：`hasPlan` 现在走 `planPathFor()`，而它有**第三条兜底** ——
   * 公开仓里教案平铺在 `教案/<模块>/` 下。学生机上模块级教案目录**根本不存在**，
   * 只盯它们的话指纹就只剩索引那一项，于是「老师新发布了教案、学生拉取更新后
   * 树还是旧的」——`hasPlan` 永远不刷新。同理见 buildTree 的注释。
   */
  function treeStamp(idx) {
    const parts = [statOf(abs(INDEX_REL))]
    for (const m of (idx && idx.modules) || []) {
      if (m.dir && m.planDir) parts.push(statOf(abs(m.dir + '\\' + m.planDir)))
    }
    // 平铺目录（公开仓形态）也要进指纹，否则它的变化推不动树
    parts.push(statOf(abs('教案')))
    // 课程.json 决定 published（老师重新发布会改它，而教案文件本身没变）
    for (const rel of ['课程.json', '课程中心\\课程.json']) parts.push(statOf(abs(rel)))
    const ok = parts.filter(Boolean)
    if (!ok.length) return null
    // 把多个指纹合成一个：任一项变化都会改变这一串
    return {
      file: 'tree:' + ok.length,
      mtime: ok.reduce((a, x) => a + x.mtime, 0),
      size: ok.reduce((a, x) => a + x.size, 0),
    }
  }
  /**
   * 课时分隔页检测。
   *
   * 课件的课时分隔页有一个**极硬的版面签名**（实测第一章第 1/10/30/36 页完全一致）：
   *   4 个形状 —— 模块名(y≈83,h≈123) / 课时副标题(y≈239,h≈155) / 主讲人(y≈321) / 占位图(y≈475)
   * 用几何特征而不是标题文本判断，是因为：
   *   · 文本会变（"模块零"/"模块一"/"模块二"…）
   *   · 而且 PPT 里的课时标题与索引里的课时标题**并不严格一致**
   *     （例：PPT 写「用线性代数勒死自己（logits模型为例）」，索引写
   *       「从统计学习理论到深度学习的矩阵化重构」）
   * 所以这里只负责**切出边界并取出 PPT 自己的标题**，编号由顺序决定；
   * 映射到哪个课时（索引）交给人和 UI，不在这里猜。
   */
  function detectLessonDividers(slides) {
    const out = []
    for (const s of slides || []) {
      const shapes = s.shapes || []
      if (shapes.length !== 4) continue
      // 按 y 排序后核对四段的几何特征（容差放宽，不同章节略有余量）
      const byY = shapes.slice().sort((a, b) => a.y - b.y)
      const [mod, sub, who, ph] = byY
      const near = (v, t, tol) => Math.abs(v - t) <= tol
      if (!near(mod.y, 83, 20) || !near(mod.h, 123, 30)) continue
      if (!near(sub.y, 239, 20) || !near(sub.h, 155, 30)) continue
      if (!near(who.y, 321, 20)) continue
      if (!near(ph.y, 475, 25)) continue
      const moduleName = oneLine(mod.text)
      const title = oneLine(sub.text)
      if (!title) continue
      // 模块名形如「模块一：从机器学习到深度学习」，取冒号前作为模块标识
      const m = /^(模块[一二三四五六七八九十]+)/.exec(moduleName)
      out.push({
        index: s.index,
        module: m ? m[1] : moduleName,
        moduleLabel: moduleName,
        title: title,
      })
    }
    return out
  }

  async function getSlides(chapter) {
    const ch = CHAPTERS.indexOf(oneLine(chapter)) >= 0 ? oneLine(chapter) : CHAPTERS[1]
    if (cache.chapterCode === ch && cache.slides && Date.now() - cache.slidesAt < 60000) return cache.slides
    const rel = SLIDES_DIR + '\\' + ch + '.json'
    if (!exists(rel)) return null
    const data = JSON.parse(readText(rel))
    data.chapter = ch
    // ⚠️ 绝不改写 m.file。客户端把它当**裸文件名**再拼路由；
    //    曾经在这里拼过一次前缀，结果双前缀 → 媒体路由 400 → 所有图片都加载不出来。
    for (const slide of data.slides) for (const m of slide.media) if (!m.file) m.file = null

    // 课时切分：分隔页本身算作新课时的第一页，直到下一个分隔页为止
    const dividers = detectLessonDividers(data.slides)
    data.lessons = dividers.map((d, i) => ({
      seq: i + 1,
      startIndex: d.index,
      endIndex: dividers[i + 1] ? dividers[i + 1].index - 1 : (data.slides[data.slides.length - 1] || {}).index,
      module: d.module,
      moduleLabel: d.moduleLabel,
      title: d.title,
    }))
    // 每页回标它属于第几个课件课时，客户端据此做「课时 ↔ 页」联动
    const byIndex = new Map()
    for (const L of data.lessons) for (let k = L.startIndex; k <= L.endIndex; k += 1) byIndex.set(k, L.seq)
    for (const s of data.slides) s.lessonSeq = byIndex.get(s.index) || 0

    cache.slides = data; cache.slidesAt = Date.now(); cache.chapterCode = ch
    return data
  }

  // ── 教案与材料 ──
  /**
   * 公开仓的课程清单：`课程.json` 里**逐课时**的发布记录。
   *
   * 为什么单独抽出来：`课程.json` 是「老师发布了什么」的**权威来源** ——
   * 它里面出现过的课时号才算已发布。面板的「已发布 N」必须照它算。
   *
   * 踩过的坑（端侧实测）：树的每个课时原来**没有 published 字段**，
   * 而客户端写的是 `lessons.filter(l => l.published !== false).length` ——
   * `undefined !== false` 恒为真，于是 **30 个课时全被算成「已发布」**，
   * 而 `课程.json` 明明写着 publishedLessons=6。
   * 学生于是看到 24 个他根本拿不到资料的课时被标成「已发布」，
   * 点进去发现没教案，只会怀疑是面板坏了。
   *
   * @returns {{nos:Set<number>, total:number, fromJson:boolean}}
   */
  function publishedFromCourseJson() {
    for (const rel of ['课程.json', '课程中心\\课程.json']) {
      if (!exists(rel)) continue
      try {
        const j = JSON.parse(readText(rel))
        const nos = new Set()
        for (const mod of j.modules || []) {
          for (const l of mod.lessons || []) {
            if (l && l.no !== undefined && l.no !== null && l.no !== '') nos.add(Number(l.no))
          }
        }
        return { nos, total: Number(j.totalLessons) || nos.size, fromJson: true }
      } catch (e) { /* 换下一个候选 */ }
    }
    return { nos: new Set(), total: 0, fromJson: false }
  }

  /** 公开仓里的 课程.json 带 planPath，是学生端最可靠的「课时→教案」映射 */
  function planFromCourseJson(lessonNo) {
    for (const rel of ['课程.json', '课程中心\\课程.json']) {
      if (!exists(rel)) continue
      try {
        const j = JSON.parse(readText(rel))
        for (const mod of j.modules || []) {
          for (const l of mod.lessons || []) {
            if (Number(l.no) === Number(lessonNo) && l.planPath) {
              const rel2 = String(l.planPath).replace(/\//g, '\\')
              if (fs.existsSync(abs(rel2))) return rel2
            }
          }
        }
      } catch (e) { /* 换下一个候选 */ }
    }
    return ''
  }
  /**
   * 按课时号找教案。
   * 三条路，按可靠性排序：
   *   1. 公开仓的 课程.json（学生端就靠这条 —— 他们的 clone 里没有原始模块目录）
   *   2. 索引里的 m.dir\m.planDir\l.plan（老师机上是这条）
   *   3. 在 教案\<模块>\ 下按「课时N_*.md」找（兜底）
   */
  async function planPathFor(lessonNo) {
    const fromJson = planFromCourseJson(lessonNo)
    if (fromJson) return fromJson
    const idx = await loadIndex()
    for (const m of (idx && idx.modules) || []) {
      for (const l of m.lessons || []) {
        if (Number(l.no) !== Number(lessonNo)) continue
        const rel = m.dir + '\\' + m.planDir + '\\' + (l.plan || '')
        if (l.plan && fs.existsSync(abs(rel))) return rel
        const hit = listDir(m.dir + '\\' + m.planDir)
          .map((e) => e.name)
          .find((n) => /^课时(\d+)_/.test(n) && Number(/^课时(\d+)_/.exec(n)[1]) === Number(lessonNo))
        if (hit) return m.dir + '\\' + m.planDir + '\\' + hit
      }
    }
    for (const d of listDir('教案')) {
      if (!d.isDirectory()) continue
      const hit = listDir('教案\\' + d.name)
        .map((e) => e.name)
        .find((n) => /^课时(\d+)_/.test(n) && Number(/^课时(\d+)_/.exec(n)[1]) === Number(lessonNo))
      if (hit) return '教案\\' + d.name + '\\' + hit
    }
    return ''
  }
  async function listDocs() {
    const out = []
    const idx = await loadIndex()
    for (const m of (idx && idx.modules) || []) {
      for (const e of listDir(m.dir + '\\' + m.planDir)) {
        if (e.isFile() && /^课时\d+_.+\.md$/.test(e.name)) {
          out.push({ path: m.dir + '\\' + m.planDir + '\\' + e.name, name: e.name, kind: m.name, module: m.name })
        }
      }
    }
    // 公开仓里教案被平铺在 教案/<模块>/ 下，学生端没有原始模块目录，也一并收进来
    for (const d of listDir('教案')) {
      if (!d.isDirectory()) continue
      for (const e of listDir('教案\\' + d.name)) {
        if (e.isFile() && /\.md$/i.test(e.name)) {
          out.push({ path: '教案\\' + d.name + '\\' + e.name, name: e.name, kind: d.name, module: d.name })
        }
      }
    }
    for (const e of listDir('课程中心')) {
      if (e.isFile() && /\.md$/i.test(e.name)) out.push({ path: '课程中心\\' + e.name, name: e.name, kind: '课程中心' })
    }
    // 同一课时在原始模块目录和公开仓平铺目录里各有一份时，去掉重复（按文件名）
    const seen = new Set()
    return out.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))
  }

  // ── 问题条目：公共面 + 学生私有面 ────────────────────────────
  function itemDirs() {
    const out = []
    if (exists(PUBLIC_ITEMS_REL)) out.push({ rel: PUBLIC_ITEMS_REL, scope: 'public' })
    for (const e of listDir(STUDENT_ITEMS_REL)) {
      if (e.isDirectory()) out.push({ rel: STUDENT_ITEMS_REL + '\\' + e.name, scope: 'student', student: e.name })
    }
    // 兼容旧布局（没有公共/学生分层时，条目直接放在 课程问题池\问题条目）
    if (exists('课程问题池\\问题条目')) out.push({ rel: '课程问题池\\问题条目', scope: 'legacy' })
    return out
  }
  async function listItems() {
    const items = []
    for (const d of itemDirs()) {
      for (const e of listDir(d.rel)) {
        if (!e.isFile() || !/\.md$/i.test(e.name)) continue
        const rel = d.rel + '\\' + e.name
        try {
          const doc = parseMarkdown(readText(rel))
          const f = doc.fields
          items.push({
            path: rel, scope: d.scope, student: d.student || f.student || '',
            id: f.id || '', title: f.title || e.name, summary: f.summary || '',
            topic: f.topic || '', concept: f.concept || '', loc: f.loc || '',
            module: f.module || '', lesson: f.lesson || '', type: f.type || '',
            // source 必须投影出来：面板已经区分「阅读器框选图区 / 作业 / B站评论…」，
            // 而「这条是批改自动生成的吗」正是靠它判断的 —— 少了它，
            // 界面上所有条目看起来都一样，没法把「批改生成的一堆」单独归拢。
            source: f.source || '',
            severity: f.severity || '', status: f.status || '', audit: f.audit || '',
            created: f.created || '', updated: f.updated || '', ai: f.ai || '',
            tokens: f.tokens || '', common: f.common || '',
            turns: readThread(abs(threadPathFor(rel))).length,
          })
        } catch (err) { /* 单条坏了不影响整池 */ }
      }
    }
    items.sort((a, b) => String(b.created + b.id).localeCompare(String(a.created + a.id)))
    return items
  }
  async function nextId(scope, student) {
    const all = await listItems()
    let max = 0
    for (const it of all) { const n = Number(String(it.id).replace(/\D/g, '')); if (n > max) max = n }
    void scope; void student
    return pad4(max + 1)
  }
  /** 读取一条条目：md + 线程 */
  function readItem(rel) {
    const doc = parseMarkdown(readText(rel))
    return { rel, fields: doc.fields, body: doc.body, turns: readThread(abs(threadPathFor(rel))) }
  }
  /** 写回一条条目：md（含线程的可读渲染）+ thread.json */
  function writeItem(rel, fields, sections, turns) {
    const parts = []
    for (const t of SECTION_ORDER) if (sections[t] !== undefined && sections[t] !== '') parts.push(fold(t, sections[t]))
    parts.push(renderThread(turns || []))
    writeText(rel, serialize(fields, parts.filter(Boolean).join('\n')))
    if (turns && turns.length) writeThread(abs(threadPathFor(rel)), turns)
  }
  /** 从既有 md 里取出各小节（丢掉线程小节，它另有存放） */
  function sectionsOf(body) {
    const s = {}
    for (const x of parseSections(body)) if (x.title !== THREAD_TITLE) s[x.title] = x.content
    return s
  }
  function itemRelFor(fields, title, scope, student) {
    const dir = scope === 'public' ? PUBLIC_ITEMS_REL : (STUDENT_ITEMS_REL + '\\' + safeId(student || 'anonymous'))
    return dir + '\\' + today() + '-' + fields.id + '-' + slugify(title, fields.id) + '.md'
  }

  // ── 学生提交 ──
  function submitDirOf(student) { return SUBMIT_ROOT_REL + '\\' + safeId(student || 'anonymous') }
  /**
   * 老师视角的「学生交了什么」清单。
   *
   * 必须跳过**元数据**与**附件**：版本清单（*.versions.json）是面板自己的记账文件，
   * 附件（_附件/）是正文的附图。两者都不是「学生交的作业」，
   * 混进来会让老师端的提交列表出现一堆看起来像作业的东西。
   */
  function listSubmissions(student) {
    const dir = student ? submitDirOf(student) : SUBMIT_ROOT_REL
    const out = []
    const skip = (nm) => nm.charAt(0) === '_' || nm.charAt(0) === '.'
      || /\.versions\.json$/i.test(nm) || /\.grade\.json$/i.test(nm)
    const walk = (rel, who) => {
      for (const e of listDir(rel)) {
        if (skip(e.name)) continue
        if (e.isDirectory()) { walk(rel + '\\' + e.name, who || e.name); continue }
        if (!e.isFile()) continue
        out.push({ path: rel + '\\' + e.name, name: e.name, student: who || '', bytes: (() => { try { return fs.statSync(abs(rel + '\\' + e.name)).size } catch (x) { return 0 } })() })
      }
    }
    walk(dir, student || '')
    return out
  }

  /**
   * 提交的附件目录。与「问题截图」分开放：
   *   作业提交/<学号>/_附件/      → 学生交上来的文件（pdf/zip/png…）
   *   课程问题池/学生/<学号>/图/   → 提问时框选的截图
   * 分开的理由：老师在「作业批改」里只需要看到学生**交了什么**，
   * 混在一起会让那个目录变成杂物间。
   */
  const SUBMIT_FILES_DIR = '_附件'
  const QUESTION_IMG_DIR = '图'

  /** 把 data URL 写成一个文件，返回相对路径。用于提交图片与提问截图。 */
  function saveBlobDataUrl(relDir, name, dataUrl) {
    const s = String(dataUrl || '')
    const comma = s.indexOf(',')
    if (comma < 0) throw new Error('不是合法的 data URL')
    const head = s.slice(0, comma)
    // payload 可能是 base64，也可能是 URL 编码的纯文本（FileReader 的另一种读法）。
    // 只按 base64 解会把纯文本附件解成乱码，所以两种都认。
    const payload = s.slice(comma + 1)
    const bytes = /;base64/i.test(head)
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    if (bytes.length > MAX_BLOB_BYTES) {
      throw new Error('附件太大：' + bytes.length + ' 字节（上限 ' + MAX_BLOB_BYTES + '）')
    }
    const mm = /^data:([^;]+)/.exec(head)
    const mediaType = mm ? mm[1] : 'application/octet-stream'
    const ext = mediaType === 'image/png' ? '.png'
      : (mediaType === 'image/jpeg' ? '.jpg'
        : (mediaType === 'image/webp' ? '.webp'
          : (mediaType === 'image/gif' ? '.gif'
            : (mediaType === 'application/pdf' ? '.pdf' : ''))))
    const keepExt = /\.[A-Za-z0-9]+$/.exec(String(name || ''))
    const useExt = ext || (keepExt ? keepExt[0].toLowerCase() : '.bin')
    // safeId 会把非 [A-Za-z0-9._-] 全换成 _，所以中文名会被压成下划线 —— 可接受，
    // 原始文件名另有记录（显示用），磁盘上只需要「唯一且安全」。
    const stem = safeId(String(name || '').replace(/\.[A-Za-z0-9]+$/, '') || 'file') || 'file'
    const rel = relDir + '\\' + stem + useExt
    writeBytes(rel, bytes)
    try { fs.chmodSync(abs(rel), 0o644) } catch (e) { /* Windows 上无所谓 */ }
    return { rel: rel, bytes: bytes.length, mediaType: mediaType }
  }
  /** 给提问截图用：落在学生自己的目录里 */
  function saveQuestionImage(student, dataUrl, name) {
    return saveBlobDataUrl(STUDENT_ITEMS_REL + '\\' + safeId(student) + '\\' + QUESTION_IMG_DIR, name || 'region', dataUrl)
  }

  /**
   * 一个课时的提交版本清单。
   *
   * 为什么要有「版本」：学生第一次交完拿到的批改意见，改完要能再交一次，
   * 而且**要能看见自己之前交了什么、当时被说了什么** —— 否则「再上传」
   * 只是覆盖，之前那份批改就成了孤儿，学生也无从判断自己有没有改对。
   * 所以每次提交都是一个新版本，历史全部保留。
   *
   * 版本号取当天已有版本数 +1（同一天多次提交也各自成版），不做全局自增 ——
   * 那需要锁，而这里只有一个学生自己在写自己的目录，不必要。
   */
  function versionsPathOf(student, lessonNo) {
    return submitDirOf(student) + '\\课时' + lessonNo + '.versions.json'
  }
  function readVersions(student, lessonNo) {
    const p = versionsPathOf(student, lessonNo)
    try {
      const t = readText(p)
      if (!t) return []
      const j = JSON.parse(t)
      return Array.isArray(j.versions) ? j.versions : []
    } catch (e) { return [] }
  }
  function writeVersions(student, lessonNo, versions) {
    writeText(versionsPathOf(student, lessonNo), JSON.stringify({
      student: safeId(student), lesson: Number(lessonNo) || 0,
      updatedAt: new Date().toISOString(),
      _说明: '这一课时的提交历史（每次提交一个版本，含批改结论）。附件在 _附件/ 下，正文在同目录的 .md 里。',
      versions: versions,
    }, null, 2) + '\n')
  }
  function submissionVersionDir(student, lessonNo, v) {
    return submitDirOf(student) + '\\课时' + lessonNo + '\\v' + v
  }
  function submissionBlobDir(student, lessonNo, v) {
    return submissionVersionDir(student, lessonNo, v) + '\\' + SUBMIT_FILES_DIR
  }
  /** 列出某个学生某课时各版本目录里的附件 */
  function listVersionFiles(student, lessonNo, v) {
    const dir = submissionBlobDir(student, lessonNo, v)
    return listDir(dir).filter((e) => e.isFile()).map((e) => ({
      name: e.name, rel: dir + '\\' + e.name, bytes: (() => { try { return fs.statSync(abs(dir + '\\' + e.name)).size } catch (x) { return 0 } })(),
    }))
  }

  // ── 路由装配 ─────────────────────────────────────────────────
  const routes = []
  function reg(r) { routes.push(r); return r }

  function registerStatic() {
    // 样式表：老师机上可指向工作区源文件（改完刷新即生效），否则用核心包内的副本
    const cssCandidates = [abs('课程中心\\_插件源码\\panel.css'), path.join(CORE_LIB, 'panel.css')]
    reg({ kind: 'prefix', path: P.css, handler: (req, res) => {
      for (const p of cssCandidates) {
        try {
          const bytes = fs.readFileSync(p)
          res.statusCode = 200; res.setHeader('Content-Type', 'text/css; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache'); res.end(bytes); return
        } catch (e) { /* 试下一个 */ }
      }
      res.statusCode = 404; res.end('not found')
    } })
    const allow = { 'katex.min.js': 'application/javascript; charset=utf-8', 'katex.min.css': 'text/css; charset=utf-8' }
    reg({ kind: 'prefix', path: P.katex, handler: (req, res) => {
      let nm = ''
      try {
        let rel = String(req.url || '')
        if (rel.indexOf(P.katex) === 0) rel = rel.slice(P.katex.length)
        if (rel[0] === '/') rel = rel.slice(1)
        const qi = rel.indexOf('?'); if (qi >= 0) rel = rel.slice(0, qi)
        nm = decodeURIComponent(rel)
      } catch (e) { nm = '' }
      if (!Object.prototype.hasOwnProperty.call(allow, nm)) { res.statusCode = 404; res.end('not found'); return }
      const full = path.join(katexDir, nm)
      if (path.dirname(path.resolve(full)) !== path.resolve(katexDir)) { res.statusCode = 404; res.end('not found'); return }
      try {
        const bytes = fs.readFileSync(full)
        res.statusCode = 200; res.setHeader('Content-Type', allow[nm])
        res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(bytes)
      } catch (e) { res.statusCode = 404; res.end('not found') }
    } })
  }

  function registerMedia() {
    const mediaDirRel = MEDIA_DIR_REL
    reg({ kind: 'prefix', path: P.media, handler: (req, res) => {
      let nm = ''
      try {
        let rel = String(req.url || '')
        if (rel.indexOf(P.media) === 0) rel = rel.slice(P.media.length)
        if (rel[0] === '/') rel = rel.slice(1)
        const qi = rel.indexOf('?'); if (qi >= 0) rel = rel.slice(0, qi)
        nm = decodeURIComponent(rel)
      } catch (e) { nm = '' }
      nm = nm.replace(/\\/g, '/')
      const segs = nm.split('/')
      if (!nm || nm.indexOf('..') >= 0 || segs.length !== 2 || CHAPTERS.indexOf(segs[0]) < 0 || !segs[1]) {
        res.statusCode = 400; res.end('bad name'); return
      }
      const dirAbs = abs(mediaDirRel + '\\' + segs[0])
      let useName = segs[1]
      let full = path.join(dirAbs, useName)
      if (!fs.existsSync(full)) {
        // 扩展名回退：JSON 里是抽取时的原始扩展名（.png/.gif），学生包里可能是 .webp
        const stem = useName.replace(/\.[^.]+$/, '')
        const hit = RASTER_EXT.map((x) => stem + x).find((x) => fs.existsSync(path.join(dirAbs, x)))
        if (hit) { useName = hit; full = path.join(dirAbs, hit) }
        else if (VIDEO_EXT.test(useName)) {
          // 视频有意不随课程包分发：返回一张说明牌，比破图有用
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="180">'
            + '<rect width="640" height="180" fill="#f4f4f5" stroke="#d4d4d8"/>'
            + '<text x="320" y="80" text-anchor="middle" font-size="17" fill="#52525b" font-family="sans-serif">此视频未随课程包分发</text>'
            + '<text x="320" y="112" text-anchor="middle" font-size="13" fill="#71717a" font-family="sans-serif">' + oneLine(useName) + '</text>'
            + '<text x="320" y="140" text-anchor="middle" font-size="12" fill="#a1a1aa" font-family="sans-serif">原始 PPT 内嵌的录屏片段，体积过大；需要请看课程录制</text>'
            + '</svg>'
          res.statusCode = 200; res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
          res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(svg); return
        }
      }
      try {
        const bytes = fs.readFileSync(full)
        cache.mediaOk = true
        res.statusCode = 200
        res.setHeader('Content-Type', /\.png$/i.test(useName) ? 'image/png'
          : (/\.jpe?g$/i.test(useName) ? 'image/jpeg'
            : (/\.gif$/i.test(useName) ? 'image/gif'
              : (/\.webp$/i.test(useName) ? 'image/webp'
                : (/\.svg$/i.test(useName) ? 'image/svg+xml'
                  : (/\.mp4$/i.test(useName) ? 'video/mp4'
                    : (/\.webm$/i.test(useName) ? 'video/webm' : 'application/octet-stream')))))))
        res.setHeader('Cache-Control', 'public, max-age=3600')
        res.end(bytes)
      } catch (error) {
        cache.mediaError = '读图失败 ' + oneLine(segs[0] + '/' + segs[1]) + '：' + oneLine(error && error.message)
        res.statusCode = 404; res.end('not found')
      }
    } })
  }

  /**
   * 提交附件与提问截图的服务路由。
   *
   * 为什么不复用 registerMedia：那个路由的取值域被钉死在「章节/文件名」两段，
   * 且只认课件目录。提交附件的路径形状完全不同（学号/课时/v N/_附件/名字），
   * 硬塞进去只会让那个路由长出两种语义。
   *
   * 与 media 同样做**路径规范化校验**：解码后必须是相对路径、
   * 不能有 ..、不能是绝对路径，且解析结果必须真的落在允许的根目录里。
   * 这是文件读取路由唯一正确的写法 —— 只查 '..' 子串是不够的
   * （Windows 上 %5C 和盘符都能绕过朴素检查）。
   */
  const contentTypeOf = (nm) => (/\.png$/i.test(nm) ? 'image/png'
    : (/\.jpe?g$/i.test(nm) ? 'image/jpeg'
      : (/\.gif$/i.test(nm) ? 'image/gif'
        : (/\.webp$/i.test(nm) ? 'image/webp'
          : (/\.svg$/i.test(nm) ? 'image/svg+xml'
            : (/\.pdf$/i.test(nm) ? 'application/pdf'
              : (/\.txt$/i.test(nm) ? 'text/plain; charset=utf-8'
                : (/\.md$/i.test(nm) ? 'text/markdown; charset=utf-8'
                  : 'application/octet-stream'))))))))

  function serveFileUnder(rootRel, urlPrefix, req, res, opts) {
    // 提交附件与提问截图里是**学生的私有数据**（作业、截图）。
    // 跨站请求一律拒 —— 否则任意网页都能把这些图读走（见 isSameOrigin 的注释）。
    if (!isSameOrigin(req)) {
      res.statusCode = 403
      res.end('forbidden: cross-site')
      return
    }
    let nm = ''
    try {
      let rel = String(req.url || '')
      if (rel.indexOf(urlPrefix) === 0) rel = rel.slice(urlPrefix.length)
      if (rel[0] === '/') rel = rel.slice(1)
      const qi = rel.indexOf('?'); if (qi >= 0) rel = rel.slice(0, qi)
      nm = decodeURIComponent(rel)
    } catch (e) { nm = '' }
    nm = nm.replace(/\\/g, '/')
    const bad = !nm || nm.indexOf('..') >= 0 || nm.charAt(0) === '/'
      || /^[A-Za-z]:/.test(nm) || nm.split('/').some((s) => !s || s.charAt(0) === '.')
    if (bad) { res.statusCode = 400; res.end('bad name'); return }
    const rootAbs = path.resolve(abs(rootRel))
    const full = path.resolve(path.join(rootAbs, nm))
    // 解析后必须仍在根目录内。用 path.relative 判断，比 startsWith 可靠
    // （startsWith 会把 C:\a\bc 当成 C:\a\b 的子路径）。
    const relCheck = path.relative(rootAbs, full)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) { res.statusCode = 403; res.end('forbidden'); return }
    try {
      const bytes = fs.readFileSync(full)
      if (bytes.length > MAX_BLOB_BYTES) { res.statusCode = 413; res.end('too large'); return }
      res.statusCode = 200
      res.setHeader('Content-Type', opts && opts.forceType ? opts.forceType : contentTypeOf(nm))
      res.setHeader('Cache-Control', 'private, max-age=60')
      if (opts && opts.download) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(nm.split('/').pop()) + '"')
      }
      res.end(bytes)
    } catch (error) { res.statusCode = 404; res.end('not found') }
  }

  function registerSubmissions() {
    // 附件：GET /cip-stu-sub/<学号>/<课时>/v N/_附件/<名字>
    reg({ kind: 'prefix', path: P.sub, handler: (req, res) => serveFileUnder(SUBMIT_ROOT_REL, P.sub, req, res) })
    // 提问截图：GET /cip-stu-shot/<学号>/<名字>
    reg({ kind: 'prefix', path: P.shot, handler: (req, res) => serveFileUnder(STUDENT_ITEMS_REL, P.shot, req, res) })
  }

  /**
   * 只接受**同源**的请求。
   *
   * ── 为什么不是「随机令牌」────────────────────────────────────────────────
   * 端侧报告建议给 `cip-stu-api` 加一个启动时生成、注入页面的 `X-CIP-Token`。
   * 想清楚之后没这么做，理由：**任何本机进程都能 `GET /cip-stu-token` 把令牌读走**，
   * 所以令牌挡不住"本机任意程序" —— 而报告里那条威胁恰恰是本机。
   * 与其加一道自己会误以为有效的关卡，不如挡住**真正挡得住的那一半**。
   *
   * ── 这里挡住的是哪一半 ───────────────────────────────────────────────────
   * 浏览器发起跨站请求时，会**自动带上**且页面 JS **无法伪造**的两个头：
   *     Origin: http://evil.example
   *     Sec-Fetch-Site: cross-site
   * 于是「学生在浏览器里打开某个网页、那个网页偷偷打本机 API 烧他的额度 /
   * 读他的提问」这条路被堵死。这正是报告里最现实的那条攻击路径。
   *
   * 非浏览器进程（本机脚本 / 别的工具）仍可伪造这两个头 —— 那类进程本来就能
   * 直接读磁盘上的提问文件，所以不是这段代码能解决的边界，也不假装能解决。
   *
   * ── 判据顺序（重要）──────────────────────────────────────────────────────
   *   1. 有 `Sec-Fetch-Site` 且不是 same-origin / none → 拒（现代浏览器的权威判据）
   *   2. 有 `Origin` 且与 Host 不同源 → 拒（老浏览器兜底）
   *   3. 两个都没有 → **放行**（curl / 本地脚本 / 诊断工具；它们不带这两个头）
   */
  function isSameOrigin(req) {
    const h = (req && req.headers) || {}
    const sfs = String(h['sec-fetch-site'] || '').toLowerCase()
    if (sfs) return sfs === 'same-origin' || sfs === 'none'
    const origin = String(h.origin || '')
    if (!origin) return true
    try {
      const o = new URL(origin)
      const host = String(h.host || '').toLowerCase()
      return !host || o.host.toLowerCase() === host
    } catch (e) {
      return false // Origin 存在但解析不出来：宁可拒
    }
  }

  function registerApi(handlers) {    const readBody = (req) => new Promise((resolve) => {
      const chunks = []; let n = 0
      req.on('data', (c) => { n += c.length; if (n > 16 * 1024 * 1024) { req.destroy(); return } chunks.push(c) })
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    reg({ kind: 'prefix', path: P.api, handler: async (req, res) => {
      // 跨站请求在**最前面**拒掉：连动作名都不解析，避免任何副作用。
      // 这一步挡的是「学生在浏览器里打开某个网页、那个网页偷打本机 API」
      // （见 isSameOrigin 的注释：非浏览器进程本来就能读磁盘，不在这道防线的范围内）。
      if (!isSameOrigin(req)) {
        res.statusCode = 403
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: '拒绝跨站请求（本面板只服务同源页面）' }))
        return
      }
      let action = ''
      try {
        let rel = String(req.url || '')
        if (rel.indexOf(P.api) === 0) rel = rel.slice(P.api.length)
        if (rel[0] === '/') rel = rel.slice(1)
        const qi = rel.indexOf('?'); if (qi >= 0) rel = rel.slice(0, qi)
        action = decodeURIComponent(rel)
      } catch (e) { action = '' }
      const out = { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      try {
        const fn = handlers[action]
        if (!fn) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: '未知动作：' + action }))
          return
        }
        out.body = await fn(await readBody(req))
      } catch (error) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: oneLine(error && error.message) || '未知错误' }))
        return
      }
      res.statusCode = 200
      // 之前这里漏了 setHeader：out.headers 声明了却从未使用，响应一直没有
      // Content-Type。res.json() 不看它所以功能上没坏，但调试时很难判断
      // 返回的到底是 JSON 还是被 SPA 回退接管的 HTML —— 加上它。
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(out.body === undefined ? { ok: true } : out.body))
    } })
  }

  /**
   * 诊断页的 HTML。它只做一件事：在浏览器里逐个请求本插件的所有路径，
   * 把状态码 / Content-Type / 前若干字节原样显示出来。
   *
   * 判定标准写死在页面上，避免"要懂代码才能看懂结果"：
   *   · API 路径返回 HTML  → 说明该前缀没注册路由，被 SPA 回退接管了
   *   · API 路径不是 JSON   → 响应体被换掉或解析异常
   *   · fetch 直接抛错      → CSP 或网络层拦截
   */
  function diagHtml(P) {
    const cases = []
    // 必须用注入的 prefix 拼路径，不能按角色名硬拼：
    // 曾经写成 '/' + role + '-api'，得到 /stu-api，漏了 cip- 前缀，
    // 于是诊断页自己测的是不存在的路径，报"被 SPA 回退接管"——把排查方向带偏。
    const mine = P.api.replace(/-api$/, '')
    const other = mine.indexOf('-stu') >= 0 ? mine.replace('-stu', '-tea') : mine.replace('-tea', '-stu')
    // 两端都测：老师在一台机器上对测时两个插件同时装着，对照着看更清楚
    for (const base of [mine, other]) {
      for (const act of ['info', 'tree', 'threads']) cases.push({ kind: 'api', url: base + '-api/' + act })
    }
    // 新增的「课时页 / 提交历史 / 模型目录」也进诊断页：
    // 这三个是最近接入的，最容易在「宿主重启过没有」这件事上出问题 ——
    // 诊断页存在的意义就是自查这类「界面说未知动作」的情况。
    for (const act of ['lesson.open', 'submission.history', 'submission.all', 'model.catalog']) {
      cases.push({ kind: 'api', url: P.api + '/' + act })
    }
    // ⚠️ 再加两条**带参数**的探针：不带参数的只能证明「动作存在」，证明不了「逻辑对」。
    //    例如 item.share 传一个不存在的路径会返回「条目不存在」——那既是**成功**
    //    （说明动作在）也很容易被误读成**失败**。所以带上 note 说明该怎么读。
    cases.push({
      kind: 'api', url: P.api + '/lesson.open',
      markedWith: { lesson: 8 },
      note: '期望 200 且返回里有 plan 字段（教案正文）。若报「未知动作」= 宿主没重启。',
    })
    cases.push({
      kind: 'api', url: P.api + '/item.share',
      markedWith: { path: '不存在的路径', shared: true },
      note: '期望 200 且 error 为「条目不存在」= 动作正常；报「未知动作」= 宿主没重启。',
    })
    for (const u of [P.css, P.katex + '/katex.min.js', P.media + '/第一章/slide001_image1.png']) {
      cases.push({ kind: 'asset', url: u })
    }
    const head = [
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<title>课程插件诊断</title><style>',
      'body{font:13px/1.6 Consolas,monospace;margin:16px;background:#111;color:#ddd}',
      'h1{font-size:16px;margin:0 0 4px}.note{color:#888;margin-bottom:12px}',
      '.row{border:1px solid #333;border-radius:6px;padding:8px 10px;margin-bottom:8px}',
      '.ok{border-color:#2e7d32}.bad{border-color:#c62828}.warn{border-color:#ef6c00}',
      '.u{font-weight:700}.m{color:#999;font-size:12px}',
      '.ok .s{color:#66bb6a;font-weight:700}.bad .s{color:#ef5350;font-weight:700}',
      'pre{margin:6px 0 0;padding:6px;background:#1b1b1b;border-radius:4px;max-height:170px;',
      'overflow:auto;white-space:pre-wrap;word-break:break-all;color:#b0bec5}',
      'button{font:inherit;padding:6px 14px;margin-bottom:12px;cursor:pointer}',
      '</style></head><body>',
      '<h1>课程插件诊断</h1>',
      '<div class="note">这个页面跑在<b>你的浏览器里</b>，与 DSH 同源。它逐个请求本插件的路径并显示真实结果。<br>',
      '判读：API 那几行应当返回 <b>合法 JSON</b>；若返回 HTML，说明该前缀没注册路由、被 SPA 回退接管了。</div>',
      '<button onclick="run()">重新检测</button><div id="out"></div>',
      '<script>var CASES=', JSON.stringify(cases), ';',
    ].join('\n')
    const tail = [
      'function esc(s){return String(s).replace(/[<>&]/g,function(m){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[m]})}',
      'function kindOf(t){var x=t.trim();if(!x)return "空响应体";',
      ' if(/^<!doctype|^<html/i.test(x))return "HTML（被 SPA 回退接管 → 前缀没注册路由）";',
      ' try{var j=JSON.parse(x);return (j&&j.error)?("JSON 但带 error："+j.error):"合法 JSON"}catch(e){return "不是 JSON"}}',
      'async function one(c){var d=document.createElement("div");d.className="row";',
      ' d.innerHTML=\'<div class="u">\'+esc(c.url)+\'</div><div class="m">请求中…</div>\';document.getElementById("out").appendChild(d);',
      ' try{var opt=c.kind==="api"?{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}:undefined;',
      '  var r=await fetch(c.url,opt);var t=await r.text();var k=kindOf(t);',
      '  var good=r.ok;if(c.kind==="api"&&k!=="合法 JSON")good=false;',
      '  if(c.kind==="asset"&&/^<!doctype|^<html/i.test(t.trim()))good=false;',
      '  var extra="";if(c.kind==="api"&&k==="合法 JSON"){try{var j=JSON.parse(t);',
      '   if(j.role)extra+=" role="+j.role; if(j.prefix)extra+=" prefix="+j.prefix;',
      '   if(j.workspace)extra+=" workspace="+j.workspace;',
      '   if(j.workspaceLooksValid!==undefined)extra+=" workspaceLooksValid="+j.workspaceLooksValid;',
      '   if(j.mediaOk!==undefined)extra+=" mediaOk="+j.mediaOk;',
      '   if(j.katexOk!==undefined)extra+=" katexOk="+j.katexOk;',
      '   if(j.tree)extra+=" 模块="+j.tree.modules.length+" 总课时="+j.tree.totalLessons;',
      '   if(j.mine)extra+=" 我的提问="+j.mine.length; if(j.items)extra+=" 教师可见="+j.items.length;',
      '  }catch(e){}}',
      '  d.className="row "+(good?"ok":"bad");',
      '  d.innerHTML=\'<div class="u">\'+esc(c.url)+\'</div><div class="m"><span class="s">HTTP \'+r.status+\'</span>\'+',
      '   \' · type: \'+esc(r.headers.get("content-type")||"(无)")+\' · \'+t.length+\' 字节 · \'+esc(k)+esc(extra)+\'</div>\'+',
      '   \'<pre>\'+esc(t.slice(0,600))+(t.length>600?"\\n…(已截断)":"")+\'</pre>\';',
      '  return good?0:1;',
      ' }catch(e){d.className="row bad";',
      '  d.innerHTML=\'<div class="u">\'+esc(c.url)+\'</div><div class="m"><span class="s">fetch 抛错</span></div><pre>\'+esc(String(e&&e.message||e))+\'</pre>\';',
      '  return 1}}',
      'async function run(){var out=document.getElementById("out");out.innerHTML="";var bad=0;',
      ' for(var i=0;i<CASES.length;i++){bad+=await one(CASES[i])}',
      ' var s=document.createElement("div");s.className="row "+(bad?"warn":"ok");',
      ' s.innerHTML=\'<div class="u">汇总</div><div class="m">\'+(bad?bad+" 项异常 —— 把异常那几行截图发我":"全部正常 —— 说明接口没问题，故障在前端渲染层")+\'</div>\';',
      ' out.insertBefore(s,out.firstChild)}',
      'run();',
      '</scr'+'ipt></body></html>',
    ].join('\n')
    return head + '\n' + tail
  }

  /**
   * 诊断页：在**浏览器里**同源地打通所有接口，把真实状态码/响应体显示出来。
   *
   * 为什么要它：面板「点开但没数据」这类问题，在 Node 里直接请求接口永远是好的
   * （终端里 curl 过：info/tree/slides/threads 全 200 且内容正确），
   * 所以故障只可能出在「浏览器发请求」这一侧 —— CSP、请求被中间层拦截、
   * 或者路径被 SPA 回退接管。这几种只有从浏览器发才能看见。
   * 页面挂在独立前缀上（<prefix>-diag），不占用 .css 那个前缀，避免前缀重叠。
   */
  function registerDiag() {
    reg({ kind: 'prefix', path: P.diag, handler: (req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(diagHtml(P))
    } })
  }

  /** ctx.effect 包装注册，保证卸载时路由跟着撤掉 */
  function mount() {
    registerStatic(); registerMedia(); registerSubmissions(); registerDiag()
    for (const r of routes) ctx.effect(() => ctx.webServer.register(r), label + ' ' + r.path)
  }

  return {
    // 位置
    WORKSPACE, WS, P, role, isTeacher, pkgRoot,
    // 课程私有根 + 私有项清单：教案草稿这类**新建**的私有数据要靠它定位，
    // 不能走 abs() 的「文件在哪」判断（首次写入前它还不存在）。
    COURSE_DIR, PRIVATE_RELS,
    courseAbs: (rel) => path.join(COURSE_DIR, rel),
    sharedAbs: (rel) => path.join(WORKSPACE, rel),
    // 文件
    abs, readText, writeText, writeBytes, exists, listDir,
    // 课程
    loadIndex, getTree, getSlides, listDocs, planPathFor,
    // 同一个进程里刚写完文件（采纳草稿 / 重建索引）后必须显式失效 ——
    // 树的内存层没有 TTL，不会自己发现 mtime 变了。
    invalidateCache,
    // 换课（同步；理由见 useCourse 的注释）
    useCourse,
    // 条目
    listItems, readItem, writeItem, sectionsOf, itemRelFor, nextId, itemDirs,
    // 线程读写：各插件要按轮次判断「老师答过没有」，所以必须从这里暴露出去。
    // （曾经漏了这两个，调用方 core.readThread(...) 抛 TypeError，而调用处恰好
    //   是个 try/catch —— 于是「教师已答复」标记永远是 false，没人发现。）
    readThread, threadPathFor,
    PUBLIC_ITEMS_REL, STUDENT_ITEMS_REL, SUBMIT_ROOT_REL,
    submitDirOf, listSubmissions,
    versionsPathOf, readVersions, writeVersions, submissionVersionDir, submissionBlobDir, listVersionFiles,
    saveBlobDataUrl, saveQuestionImage, submitExtAllowed, SUBMIT_EXT, MAX_BLOB_BYTES, MAX_SUBMIT_FILES,
    // 缓存层：插件拿它缓存**自己**的派生数据（例如学生端的提交清单）。
    // 单一事实来源仍是磁盘原始文件，条目按来源 mtime+size 失效。
    cached, statOf, sameStat, clearCache, cacheInfo, cacheDir,
    // 路由
    registerApi, registerStatic, registerMedia, registerSubmissions, mount, routes, readBodyForTest: null,
    // 诊断
    info: () => {
      // 版本信息：**这套面板与课程内容是哪个版本**。
      // 为什么放进 info() 而不只放在教师端发布页：
      //   ① 学生端也要能显示「你 clone 到的是哪个版本」——拿错版本的症状是
      //      「面板某些功能报未知动作」，而学生根本无从判断；
      //   ② 老师要从这里抄一条命令给学生（命令里含远端地址）。
      //
      // withRemote:false —— info() 是高频调用（客户端顶栏会拉），
      // 不该每次都 spawn git 去连远端；真要比对走 repo.status。
      // 而且**只算一次**：versionInfo 内部会 spawn `git describe`，
      // 在这里写两遍就是两次子进程。
      const vi = versionInfo(WORKSPACE, { withRemote: false })
      return {
        workspace: WORKSPACE, workspaceHow: WS.how, workspaceTried: WS.tried,
      // 两个字段判的不是一回事，都要留着：
      //   workspaceResolved     = 解析链**有没有一个候选通过校验**（配置层面）
      //   workspaceLooksValid   = 解析出来的目录**里有没有「课程中心」**（数据层面）
      // 例：CIP_WORKSPACE 指对了目录但里面还没建 课程中心/ → resolved=true, looksValid=false。
      workspaceResolved: WS.resolved !== false,
      workspaceLooksValid: fs.existsSync(path.join(WORKSPACE, '课程中心')),
      role, label, prefix,
      mediaOk: cache.mediaOk === true, mediaError: cache.mediaError,
      katexOk: cache.katexOk, hasLlm: ctx.get('llm') !== undefined,
      chapters: CHAPTERS,
      // 当前课程：既有课程配置（课程名/课程码/目标），也有**定位信息**
      // （工作区在哪、课程目录在哪、有哪些课可切）。
      //   · 面板顶栏必须能显示「你在看哪门课」—— 否则老师很容易把 A 课的问题池
      //     当成 B 课的，而这种错误很难自己发现。
      //   · 两项合并成**一个** course 键：曾经写成两个同名键，
      //     后一个把前一个静默覆盖（对象字面量允许重复键，不报错），
      //     于是定位信息一条都没下发出去。
      course: Object.assign({}, COURSE, {
        code: COURSE.code || WS.courseCode || '',
        dir: COURSE_DIR,
        workspace: WORKSPACE,
        shared: !!WS.shared,
        available: listCourses(WORKSPACE),
        // 当前这一门是不是「根目录即课程」的旧布局 —— 界面据此决定
        // 要不要显示课程下拉框（只有一门课时显示它只会让人困惑）。
        rootIsCourse: COURSE_DIR === WORKSPACE,
      }),
      // 受控词表优先用**课程配置里的**（换课必须一起换，否则模型会拿「视觉任务」
      // 去分类一门文学课的问题 —— 分类错了不报错，只会让老师看到莫名其妙的归类）。
      defaults: {
        sources: SOURCES, modules: LAYOUT.modules, types: LAYOUT.issueTypes,
        severities: LAYOUT.severities, statuses: STATUSES, topics: LAYOUT.topics,
        planSections: LAYOUT.planSections, chapters: LAYOUT.chapters,
      },
      // 完整布局 + 自检：老师换课时第一件要看的「它现在按哪套形状在认我的文件」
      layout: LAYOUT,
      layoutReport: layoutReport(LAYOUT),
      // 版本（见上面 vi 的注释：只算一次）
      version: vi,
      versionSummary: versionSummary(vi),
      publicDir: PUBLIC_ITEMS_REL, studentDir: STUDENT_ITEMS_REL, submitDir: SUBMIT_ROOT_REL,
      maxSubBytes: MAX_SUB_BYTES, allowedExt: ALLOWED_EXT, maxTurns: MAX_THREAD_TURNS,
      submitExt: SUBMIT_EXT, maxBlobBytes: MAX_BLOB_BYTES, maxSubmitFiles: MAX_SUBMIT_FILES,
      // 供客户端拼附件 URL：提交附件与提问截图各有自己的前缀。
      // 绝不在这里写死 '/cip-stu-sub' —— 学生端与教师端前缀不同，
      // 写死就会让教师端去请求学生端的路由（这个坑在客户端那侧已经踩过一次）。
      prefixes: { api: P.api, media: P.media, katex: P.katex, css: P.css, sub: P.sub, shot: P.shot },
      routes: routes.map((r) => r.path),
    }
    },
    warn() {
      // 没解析到工作区时先说这一条（渲染与文案都在 reportUnresolvedWorkspace 里，
      // 那个函数有独立用例覆盖，见 tools/verify-workspace-warning.mjs）。
      if (reportUnresolvedWorkspace(WS, WORKSPACE, label)) return
      if (!fs.existsSync(path.join(WORKSPACE, '课程中心'))) {
        console.warn('[' + label + '] ⚠ 工作区里没有「课程中心」目录，面板会是空的。试过：')
        for (const t of WS.tried) console.warn('[' + label + ']   ' + t)
      }
      if (!cache.katexOk) console.warn('[' + label + '] ⚠ 找不到 katex，公式将无法渲染')
    },
  }
}

export { DEFAULT_WORKSPACE }
