/**
 * 「资料」—— 课件原件、讲义 PDF、数据集、代码包，**学生从哪拿、怎么在线看**。
 *
 * ── 老师问的那个问题 ────────────────────────────────────────────────────
 * 「教师课件、ppt、资料放哪，学生从哪连接到该仓库？」
 *
 * 这个问题之所以难答，是因为**三类东西的更新频率和体积差两个数量级**，
 * 却被默认塞进同一条分发通道：
 *
 *   | 内容                        | 体积        | 变化      |
 *   | 课程骨架 / 教案 / 公开问答   | 0.3 MB      | 每周      |
 *   | 面板插件                    | 1.1 MB      | 每轮      |
 *   | 课件图 / 原件 / 数据集       | 13.6 MB → ? | 基本不变  |
 *
 * 「改一个错别字 → 全班重下 14 MB」就是这么来的；而 90 MB 的原始 pptx
 * 根本进不了 git（单文件 100 MB 硬限、仓库 1 GB 软限，**历史还会永久背着它**）。
 *
 * ── 这一层的做法：清单 + 三种取用方式 ────────────────────────────────────
 * 老师维护一份 `资料.json`（清单），每一项指向一个文件；面板读清单渲染"资料"页。
 * 文件本身放哪由清单里的 `url` 决定，于是**换地方不用改代码**：
 *
 *   ① 仓内相对路径   `资料/第一章-讲义.pdf`        → 随课程包 clone（学生不用额外操作）
 *   ② GitHub Releases `https://github.com/<o>/<r>/releases/download/<tag>/<file>`
 *                                                  → 直链、不用 git、不用账号（推荐放原件）
 *   ③ 对象存储 / NAS  `https://…/…`                → 几百 MB 的视频、数据集
 *
 * 学生那一侧只有两件事：**下载**（浏览器直接点 url）和**在线预览**。
 *
 * ── 在线预览为什么是"给课件页"而不是内嵌 PDF ─────────────────────────────
 * 学生的真实需求是「**对着 PPT 截图提问**」（老师原话）。所以：
 *   · `pdf` 类型确实可以内嵌（浏览器自带阅读器，`<iframe>`）；
 *   · 但更有用的是"跳到课件页的那一章那一页" —— 面板的课件页支持框选取证 +
 *     就地提问，那才是这个插件的核心动作（见学生端 client 的 `pick` / `assignPick`）。
 * 所以清单里给 `slides: { chapter, from, to, pdf }`，界面同时给两个入口：
 * 「在线看原件」（内嵌 PDF）与「去课件页框选提问」（跳到能框选的地方）。
 *
 * ⚠️ 与 `materials.js` 的分工（名字像，别混）：
 *   · `materials.js`  —— **归位建议**：老师把文件拖进来时"该放到哪"，纯建议、不落盘
 *   · `resources.js`（本文件）—— **资料清单**：已经放好的东西，学生怎么拿到
 * 两者都会碰到"文件类型"，所以类型白名单在这里各写一份是**故意的**：
 * 归位建议关心的是"放进哪个课程目录"，资料清单关心的是"浏览器能不能直接看"，
 * 判据不同，硬合成一份反而会让两边都变模糊。
 *
 * ── 这个文件里只有**纯函数** ────────────────────────────────────────────
 * 真正的转换（pptx→PDF）、复制、上传在 tools/ 与 host.js 里。
 * 这里放的是**判断**：清单合不合法、每一项算哪一档、预览到底打开什么。
 * 理由与前几轮一样：这几件事说错了都不会当场报错 ——
 * 清单写错一项界面只是"少一项"，url 拼错学生点开是 404，
 * 而这看起来都像"老师没上传"，不像代码问题。
 */
import path from 'node:path'

/** 清单里允许的类型。**只有这几种**，界面按它决定用哪个预览器。 */
export const MATERIAL_KINDS = ['slides', 'pdf', 'image', 'video', 'file']

/** 扩展名 → 类型（清单没写 kind 时按它猜；老师少写一个字段不该让这一项消失） */
const KIND_BY_EXT = {
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video',
  '.pptx': 'slides', '.ppt': 'slides', '.key': 'slides',
}

/** 判断一项算不算「能在浏览器里直接看」（而不是只能下载） */
export function previewable(kind) {
  return kind === 'slides' || kind === 'pdf' || kind === 'image' || kind === 'video'
}

/**
 * 把一项资料**规整**成界面能直接用的形状。
 *
 * 判据都收在这里，因为界面上写这些判断会散成三处（学生端、教师端、诊断页），
 * 而"三处各写一份"在这个项目里已经出过事（路径归属、hasPlan 都是）。
 *
 * @param {object} raw 清单里的一项（老师手写，可能有缺字段、反斜杠、多余空格）
 * @param {number} index 序号（报错时说"第几项"）
 * @returns {{ok:boolean, item?:object, why?:string}}
 */
export function normalizeItem(raw, index) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const title = String(r.title || '').trim()
  const file = String(r.file || '').trim().replace(/\\/g, '/')
  if (!title) return { ok: false, why: '第 ' + (index + 1) + ' 项没有 title（界面要拿它当标题）' }
  if (!file) return { ok: false, why: '「' + title + '」没有 file（指向哪个文件）' }
  if (file.indexOf('..') >= 0 || file[0] === '/') {
    return { ok: false, why: '「' + title + '」的 file 不能是绝对路径、也不能含 ..：' + file }
  }
  const guess = KIND_BY_EXT[path.extname(file).toLowerCase()] || 'file'
  let kind = String(r.kind || guess).trim()
  if (MATERIAL_KINDS.indexOf(kind) < 0) kind = guess
  // url 给了就用它（那表示"文件放在别处"：Releases / 对象存储）；没给就是仓内相对路径
  const url = String(r.url || '').trim()
  const remote = !!url && /^https?:\/\//i.test(url)
  if (url && !remote) {
    return { ok: false, why: '「' + title + '」的 url 只能是 http/https（不能是 file:// 或本机路径）：' + url }
  }
  const rel = url ? '' : ('资料/' + file.replace(/^资料\//, ''))
  const slides = (r.slides && typeof r.slides === 'object') ? {
    chapter: String(r.slides.chapter || '').trim(),
    from: Number(r.slides.from) || 1,
    to: Number(r.slides.to) || 0,
    pdf: String(r.slides.pdf || '').trim(),
  } : null
  return {
    ok: true,
    item: {
      title,
      kind,
      note: String(r.note || '').trim(),
      size: Number(r.size) || 0,
      /** 学生点「下载」要打开的东西：仓内相对路径 或 远程直链 */
      target: url || rel,
      remote,
      previewable: previewable(kind),
      slides,
    },
  }
}

/**
 * 读一份清单对象 → 规整后的列表 + 报告。
 *
 * ⚠️ 坏项**不丢**：它会被收进 `bad`，由调用方显示出来。
 *    "某一项从清单里静默消失"是最难查的一类 —— 学生会说"老师没上传"，
 *    老师会说"我明明写了"，而两边看到的界面都没有任何证据。
 */
export function normalizeManifest(obj) {
  const list = Array.isArray(obj && obj.items) ? obj.items : []
  const items = []
  const bad = []
  list.forEach((raw, i) => {
    const r = normalizeItem(raw, i)
    if (r.ok) items.push(r.item)
    else bad.push(r.why)
  })
  return {
    updated: String((obj && obj.updated) || '').trim(),
    note: String((obj && obj.note) || '').trim(),
    items,
    bad,
  }
}

/**
 * 「这份资料能不能内嵌预览」——判据是**浏览器自带能力**，不是我们的偏好：
 *   pdf → 有内置阅读器；image / video → 直接显示；
 *   slides（pptx 原件）→ **不能**（浏览器没有 pptx 渲染器）
 * 所以 pptx 那一档必须靠"转成 PDF"或"去课件页框选"来预览。
 * 界面据此决定按钮文案，而不是给一个点了没反应的「预览」。
 */
export function previewMode(kind) {
  if (kind === 'pdf') return 'iframe'
  if (kind === 'image') return 'img'
  if (kind === 'video') return 'video'
  if (kind === 'slides') return 'slides'
  return 'none'
}

/**
 * 给一项资料选「在线预览」到底该打开什么。
 *
 * 优先级（都是刻意的）：
 *   ① `slides.pdf`：与课件页同源、能内嵌、**格式最忠实**（WPS/Office 导出的 PDF）
 *   ② 自己的 target（远程 PDF / 图片 / 视频，浏览器直接能渲染）
 *   ③ 都没有 → `mode: 'none'`：界面只给下载，**不假装能看**
 */
export function previewTarget(item) {
  if (!item) return { mode: 'none', src: '' }
  const mode = previewMode(item.kind)
  if (mode === 'slides') {
    if (item.slides && item.slides.pdf) return { mode: 'iframe', src: item.slides.pdf }
    return { mode: 'slides', src: '' }
  }
  if (mode === 'none') return { mode: 'none', src: '' }
  return { mode, src: item.target }
}

/**
 * 学生端的「去课件页」参数 —— **对着 PPT 截图提问**那条路。
 * 返回 null 表示这一项不是课件、或者清单没写章节，那就只给下载。
 */
export function slidesJump(item) {
  const s = item && item.slides
  if (!item || item.kind !== 'slides' || !s || !s.chapter) return null
  return { chapter: s.chapter, from: s.from || 1, to: s.to || 0 }
}

/** 一句人话的体积（清单里 size 是字节；0 = 不知道） */
export function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
