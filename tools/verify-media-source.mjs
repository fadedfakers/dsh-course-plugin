/**
 * 逐字节核对：**远程那份课件图，和本地这份是不是同一份**。
 *
 * ── 这一步为什么必须存在（而且是"摘媒体"之前的那道闸）────────────────────
 * `course-repo.mjs publish --no-media` 会把课件图从公开仓里删掉，让学生的
 * clone 从 14.3 MB 降到 ~0.7 MB。但摘掉之后，学生能不能看到课件，
 * **完全取决于远程那份是不是完整、是不是同一份**。
 *
 * 而这件事失败的样子特别难查：
 *   · 老师本机一切正常（他本地就有图），**只有学生那边**是「图片不可用」占位框；
 *   · 少一张两张不会报任何错 —— 面板只知道"这个文件 404"，不知道"本该有 293 张"。
 * 所以必须在摘之前、在一台有本地全量图的机器上，把两边**逐字节**比一遍。
 *
 * ── 判据（四条，都要过）─────────────────────────────────────────────────
 *   ① 本地每一张图，远程都能取到
 *   ② 取回来的**字节完全相同**（按 sha1 比；不看 Content-Length 之类的元数据）
 *   ③ Content-Type 是 image/*（对象存储与 CDN 有时回 octet-stream，
 *      那种也能用；但回 text/html 说明取到的是错误页，必须报）
 *   ④ 远程**没有多出**本地没有的图（多出来的通常是改名/换版留下的残留 ——
 *      不影响学生，但值得知道，因为它会让"以后按文件名对账"对不上）
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   node tools/verify-media-source.mjs                       # 用 课程配置.json 的 mediaBase
 *   node tools/verify-media-source.mjs <mediaBase>            # 显式指定
 *   node tools/verify-media-source.mjs <mediaBase> --chapter 第一章   # 只查一章（快）
 *   node tools/verify-media-source.mjs <mediaBase> --limit 20         # 只查前 20 张（冒烟）
 *
 * mediaBase 是"章节目录的父目录"，例如：
 *   https://cdn.jsdelivr.net/gh/fadedfakers/DSH-algorithm@main/课程中心/预览数据/media
 * 面板拼 URL 的规则与这里**必须一致**（见 core/src/media.js 的 mediaRemoteUrl：
 * 每一段都 encodeURIComponent）。不一致的症状是「本机测着好好的、学生全都取不到」。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLISH_DIR = path.dirname(HERE)
const WORKSPACE = path.dirname(PUBLISH_DIR)

/**
 * 找内核源码目录 —— **两种布局都要认**（与仓库里其它脚本同一条纪律）：
 *   ① 发布仓布局：<仓根>/tools/ + <仓根>/dsh-course-core/
 *   ② 开发侧布局：<工作区>/课程发布/tools/ + <工作区>/课程中心/course-plugin/dsh-course-core/
 * 写死一种会让另一个位置直接 ERR_MODULE_NOT_FOUND。
 */
function findCoreSrc(startDir) {
  let d = startDir
  for (let i = 0; i < 6; i++) {
    for (const rel of ['dsh-course-core/src', '课程中心/course-plugin/dsh-course-core/src']) {
      const p = path.resolve(d, rel)
      if (fs.existsSync(path.join(p, 'media.js'))) return p
    }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return null
}
const CORE_SRC = findCoreSrc(HERE)
if (!CORE_SRC) {
  console.error('✗ 找不到 dsh-course-core/src（向上找了 6 层，两种布局都试过）')
  process.exit(2)
}

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i > -1 && argv[i + 1] ? argv[i + 1] : def
}
const pos = argv.filter((a) => !a.startsWith('--'))
/** 位置参数里要排掉选项的值（`--chapter 第一章` 的「第一章」不是 mediaBase） */
const optionValues = new Set(['chapter', 'limit', 'concurrency'].map((n) => opt(n, '')).filter(Boolean))
const mediaBaseArg = pos.filter((a) => !optionValues.has(a))[0] || ''

const CHAPTERS = ['第一章', '第二章', '第三章']
const onlyChapter = opt('chapter', '')
const limit = Number(opt('limit', '0')) || 0
const CONC = Math.max(1, Math.min(16, Number(opt('concurrency', '8')) || 8))

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

// ── 媒体源：显式参数 > 环境变量 > 课程配置 ─────────────────────────────
function loadMediaBase() {
  if (mediaBaseArg) return { base: mediaBaseArg.replace(/\/+$/, ''), how: '命令行参数' }
  if (process.env.CIP_MEDIA_BASE) return { base: String(process.env.CIP_MEDIA_BASE).replace(/\/+$/, ''), how: '环境变量 CIP_MEDIA_BASE' }
  for (const p of [path.join(WORKSPACE, '课程配置.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (j.mediaBase) return { base: String(j.mediaBase).replace(/\/+$/, ''), how: p }
    } catch (e) { /* 没有就往下 */ }
  }
  return { base: '', how: '' }
}
const mb = loadMediaBase()
console.log('媒体源  : ' + (mb.base || '（没配）') + (mb.how ? ('　← ' + mb.how) : ''))
if (!mb.base) {
  console.error('\n✗ 没有可用的 mediaBase。')
  console.error('  三种给法：命令行第一个参数 / 环境变量 CIP_MEDIA_BASE / 课程配置.json 的 mediaBase。')
  console.error('  注意：**先摘媒体再配源**是最坏的顺序 —— 学生会直接看不到课件。')
  process.exit(2)
}
if (!/^https?:\/\//i.test(mb.base)) {
  console.error('\n✗ mediaBase 必须是 http/https 裸地址（不能带凭据）：' + mb.base)
  process.exit(2)
}

// ── 本地那份（权威）──────────────────────────────────────────────────
const rawRoot = path.join(WORKSPACE, '课程中心', '预览数据')
const webpRoot = path.join(WORKSPACE, '.webp-out')
const RASTER_EXT = ['.webp', '.png', '.jpg', '.jpeg', '.gif']
/**
 * 本地「**发出去的那一份**」在哪 —— 比的是学生实际会拿到的东西，不是工作区里的原图。
 *
 * 顺序（都是"学生拿到的那一份"的候选，**最接近的排前面**）：
 *   ① 课程发布/public/课程中心/预览数据/media/<章>/   ← 已发布的那份（publish 的产物）
 *   ② .webp-out/<章>/                                ← 转换产物，是 ① 的输入，字节等价
 *   ③ 课程中心/预览数据/media/<章>/                   ← **原始导出图**，最后才用（扩展名不同）
 *
 * ⚠️ 第二版把 ③ 排在 ② 前面，于是这个脚本拿 1 MB 的原始 `.png` 去比对
 *    几十 KB 的 `.webp`，6 张全 404 —— 看起来像「远程缺图」，其实是我比错了对象。
 *    探针比错对象比漏测更费时间：它会把人引去一个不存在的问题。
 *
 * ⚠️ 用 ① 时**不查 git 状态**：本地未提交 ≠ 学生拿不到（学生拿的是远端）。
 *    这里要与远端比的是**内容**，而 ① 的字节就是 publish 写出去的那份。
 */
const PUBLIC_MEDIA = path.join(PUBLISH_DIR, 'public', '课程中心', '预览数据', 'media')
function localDirOf(ch) {
  for (const d of [path.join(PUBLIC_MEDIA, ch), path.join(webpRoot, ch), path.join(rawRoot, 'media', ch)]) {
    if (fs.existsSync(d)) return d
  }
  return ''
}
/** 本地目录里"这个名字"对应哪个文件（同名优先，其次换扩展名找） */
function resolveLocal(dir, name) {
  const exact = path.join(dir, name)
  if (fs.existsSync(exact)) return exact
  const stem = name.replace(/\.[^.]+$/, '')
  for (const ext of RASTER_EXT) {
    const p = path.join(dir, stem + ext)
    if (fs.existsSync(p)) return p
  }
  return ''
}
const targets = []
for (const ch of CHAPTERS) {
  if (onlyChapter && ch !== onlyChapter) continue
  const dir = localDirOf(ch)
  if (!dir) { console.log('  · ' + ch + '：本机没有这一章的图，跳过'); continue }
  // 以**索引里引用到的名字**为准（面板只会请求这些），而不是目录里有什么。
  // 这样「索引引用了但一张都没有」也会被抓出来 —— 那正是学生看到坏图的原因。
  let names = null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(rawRoot, ch + '.json'), 'utf8'))
    names = []
    for (const s of j.slides || []) for (const m of s.media || []) if (m && m.file) names.push(path.basename(m.file))
  } catch (e) { names = null }
  if (!names) {
    names = fs.readdirSync(dir).filter((f) => /\.(webp|png|jpe?g|gif)$/i.test(f))
    console.log('  · ' + ch + '：读不到 ' + ch + '.json，按目录内容核对（降级判据）')
  }
  for (const nm of [...new Set(names)].sort()) {
    const abs = resolveLocal(dir, nm)
    if (!abs) { targets.push({ ch, f: nm, abs: '', missingLocal: true }); continue }
    targets.push({ ch, f: nm, shipped: path.basename(abs), abs })
  }
}
const picked = limit ? targets.slice(0, limit) : targets
/**
 * 视频**单独算一类**，不并进主断言。
 *
 * 为什么：`.mp4` 是 pptx 里嵌的录屏片段，**有意不随课程包分发**
 * （单个 34 MB，而它们不是课程主体）。面板遇到视频会给一张「此视频未随课程包分发」
 * 的说明牌，而不是破图 —— 那是设计好的降级，不是故障。
 * 所以「本机没有这几个 mp4」不该让这一步变红；但它值得**说一句**，
 * 因为配上 mediaBase 之后面板会先去远程找视频：托管方如果把 mp4 也放上去，
 * 学生就能直接看；没放就还是那张说明牌。
 */
const isVideo = (n) => /\.(mp4|webm|mov|avi|m4v)$/i.test(n)
const missingLocal = targets.filter((t) => t.missingLocal && !isVideo(t.f))
const missingVideo = targets.filter((t) => t.missingLocal && isVideo(t.f))
if (missingVideo.length) {
  console.log('  · ' + missingVideo.length + ' 个视频本机就没有（有意不分发）：'
    + missingVideo.map((t) => t.ch + '/' + t.f).join('、'))
  console.log('    配了 mediaBase 时面板会先去远程找它们；托管方放了就能看，没放就是那张说明牌。')
}
if (missingLocal.length) {
  console.log('  · 本机缺 ' + missingLocal.length + ' 个索引引用的图（这些无法核对）：'
    + missingLocal.slice(0, 5).map((t) => t.ch + '/' + t.f).join('、'))
}
const usable = picked.filter((t) => !t.missingLocal)
console.log('本地图  : ' + usable.length + ' 张可核对' + (limit ? ('（--limit ' + limit + '，共 ' + targets.length + ' 个引用）') : '')
  + (onlyChapter ? ('　只查 ' + onlyChapter) : ''))
if (!usable.length) {
  console.error('\n✗ 本机一张图都没有 —— 没有可核对的东西（这一步要在**有全量图**的机器上跑）。')
  process.exit(2)
}

/**
 * 面板拼 URL 的规则必须与这里一致：**逐段 encodeURIComponent**，
 * 而且用的是**发出去那个文件名**（扩展名回退之后的名字），不是索引里的原名。
 * 不一致的症状是「本机测着好好的、学生全都取不到」。
 */
const remoteUrl = (ch, f) => mb.base + '/' + encodeURIComponent(ch) + '/' + encodeURIComponent(f)
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

/**
 * 取一份用来核对 —— **走面板同一条取回路径**（分段可续）。
 *
 * 为什么不能在这里写裸 fetch：面板取远程媒体用的是 `fetchMediaResumable`
 * （见 core/src/media.js），而仓里混着一张 7.3 MB 的图，裸 fetch 在本机这条链路上
 * **稳定超时**。核对脚本如果比面板"更强"，它就会绿着放过一个学生那边会失败的源；
 * 反过来如果比面板"更弱"，它会红着报假警。两边必须走同一条路，结论才作数。
 *
 * 404 是**确定的答案**（远程确实没有这张），立刻返回、不重试 ——
 * 重试只会把「确实缺图」拖成「连不上」，把要报的问题掩盖掉。
 */
const mediaMod = await import(pathToFileURL(path.join(CORE_SRC, 'media.js')).href)
async function fetchForCheck(url) {
  const got = await mediaMod.fetchMediaResumable(url, { tries: 3, timeout: 60000 })
  if (!got.ok) return { err: got.why }
  return { buf: got.buf, contentType: got.contentType || '', chunks: got.chunks }
}

console.log('\n== 逐字节核对（' + usable.length + ' 张，并发 ' + CONC + '）==')
const problems = []
let done = 0
async function one(t) {
  const url = remoteUrl(t.ch, t.shipped)
  const got = await fetchForCheck(url)
  if (got.err) { problems.push({ kind: '取回失败', ch: t.ch, f: t.shipped, why: got.err }); return }
  const ct = String(got.contentType || '')
  if (/^text\/|json|xml/i.test(ct)) {
    problems.push({ kind: '返回的不是图片', ch: t.ch, f: t.shipped, why: 'Content-Type=' + ct })
    return
  }
  const buf = got.buf
  const local = fs.readFileSync(t.abs)
  if (buf.length !== local.length || sha1(buf) !== sha1(local)) {
    problems.push({
      kind: '字节不同', ch: t.ch, f: t.shipped,
      why: '本地 ' + local.length + ' 字节 sha1=' + sha1(local).slice(0, 10)
        + ' / 远程 ' + buf.length + ' 字节 sha1=' + sha1(buf).slice(0, 10),
    })
    return
  }
  if (!/^image\//i.test(ct) && ct) t.oddType = ct
  done += 1
}
const queue = usable.slice()
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
  while (queue.length) await one(queue.shift())
}))

/**
 * 第二轮：把**失败的那些单独、串行**再试一遍。
 *
 * 为什么需要这一轮：这台机器到 CDN 的链路在并发下会大量失败
 * （实测 290 张 / 并发 4：3 个 `fetch failed` + 1 个超时）。
 * 而失败分两种，从结果上看不出区别：
 *   · **链路问题**（限流、连接被重置）→ 串行重试就过了
 *   · **远程真的没有**（404）→ 重试多少次都是 404，那才是要报的问题
 * 所以：第一轮并发跑完（快），第二轮只对失败的**降速串行**重试（准）。
 * 判据落在第二轮之后的结果上 —— 这样「网络抖动」不会变成假红，
 * 而「远程确实缺图」也不会被抖动的噪声掩盖过去。
 */
if (problems.length) {
  const retryList = problems.slice()
  console.log('  第二轮：' + retryList.length + ' 个失败项串行重试一次（并发下的链路失败多半在这一轮过）…')
  problems.length = 0
  let nowOk = 0
  for (const p of retryList) {
    const t = usable.find((x) => x.ch === p.ch && x.shipped === p.f)
    if (!t) { problems.push(p); continue }
    const before = done
    await one(t)
    if (done > before) { nowOk += 1; continue }
    // one() 会把新的失败 push 进 problems（此时长度已清零，所以拿到的是这一条）
    await new Promise((res) => setTimeout(res, 500))
  }
  if (nowOk) console.log('  第二轮补回 ' + nowOk + ' 张（第一轮是链路抖动，不是远程缺图）')
}

const odd = usable.filter((t) => t.oddType)
// 判据只落在这两件事上：**张数对得上**、**每张字节相同**。
// ⚠️ 用 `usable`（图）而不是 `picked`（含视频）：视频本机就没有，拿它当分母
//    会让这一步永远红 —— 而那是设计好的（见上面 missingVideo 那段）。
check('远程每一张图都能取到、且**字节完全相同**', done === usable.length,
  done + ' / ' + usable.length + ' 张一致')
if (problems.length) {
  const byKind = {}
  for (const p of problems) byKind[p.kind] = (byKind[p.kind] || 0) + 1
  console.log('  问题分类：' + Object.entries(byKind).map(([k, n]) => k + ' × ' + n).join('，'))
  for (const p of problems.slice(0, 20)) console.log('  ✗ [' + p.kind + '] ' + p.ch + '/' + p.f + '　' + p.why)
  if (problems.length > 20) console.log('  …还有 ' + (problems.length - 20) + ' 条')
  console.log('\n  ⚠️ **不要**在这些问题修好之前跑 publish --no-media：')
  console.log('     摘掉之后学生那边每一张缺的图都会变成「图片不可用」占位框。')
} else {
  console.log('  全部 ' + picked.length + ' 张逐字节一致 ✓')
}
// Content-Type 偏软的那一档：能用，但记一句（面板按扩展名兜底，不受影响）
if (odd.length) {
  console.log('  · 有 ' + odd.length + ' 张的 Content-Type 不是 image/*（例如 '
    + odd[0].oddType + '）—— 面板按扩展名判断，不影响显示；对象存储/CDN 常见。')
}

// ★ 这一条是**能证伪**的：只要本机有一张索引引用到的图找不到，它就红 ——
//   而「索引引用了、图不在」正是学生看到「图片不可用」占位框的直接原因。
check('索引引用到的图，本机一张不缺', missingLocal.length === 0,
  missingLocal.length ? ('缺 ' + missingLocal.length + ' 张：' + missingLocal.slice(0, 5).map((t) => t.ch + '/' + t.f).join('、')) : '')

/**
 * 体积画像 —— 为什么值得单独报一句。
 *
 * 实测仓里混着**个头差两个数量级**的图：大多数几十 KB，但
 * `第二章/slide006_image13.webp` 是 **7.3 MB**（比其余 289 张加起来还大）。
 * 它在「图随课程包分发」时只是让 clone 大一点；一旦改成**按需从 CDN 取**，
 * 它就从「一次性的 13.6 MB」变成「每个学生每次都要拉 7.3 MB」——
 * 慢、还容易被当成「图加载不出来」。所以这里把前几名摆出来，
 * 让老师知道哪几张值得重新压一遍（`tools/to_webp.py` 的质量参数）。
 */
{
  const sized = usable.map((t) => ({ ...t, bytes: (() => { try { return fs.statSync(t.abs).size } catch (e) { return 0 } })() }))
    .filter((t) => t.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  const total = sized.reduce((s, t) => s + t.bytes, 0)
  const big = sized.filter((t) => t.bytes > 1024 * 1024)
  console.log('\n== 体积画像（' + sized.length + ' 张，合计 ' + (total / 1048576).toFixed(1) + ' MB）==')
  console.log('  最大 5 张：')
  for (const t of sized.slice(0, 5)) {
    console.log('    ' + (t.bytes / 1048576).toFixed(2) + ' MB  ' + t.ch + '/' + t.shipped)
  }
  if (big.length) {
    console.log('  · 有 ' + big.length + ' 张超过 1 MB（合计 '
      + (big.reduce((s, t) => s + t.bytes, 0) / 1048576).toFixed(1) + ' MB）——')
    console.log('    图随课程包分发时它们只让 clone 大一点；改成按需从 CDN 取之后，')
    console.log('    它们会变成「每个学生每次都要拉」的那几张。值得重压一遍再发。')
  }
  // 判据本身只针对「有没有大得离谱的」：>8 MB 基本可以断定是**原图没压**
  // （正常的幻灯片切图不会这么大），那会实实在在拖慢每一个学生。
  const absurd = sized.filter((t) => t.bytes > 8 * 1024 * 1024)
  check('没有大得离谱的单张图（> 8 MB 基本是没压过的原图）', absurd.length === 0,
    absurd.length ? (absurd.length + ' 张：' + absurd.slice(0, 3).map((t) => (t.bytes / 1048576).toFixed(1) + 'MB ' + t.shipped).join('、')) : '')
}

// ── ④ 索引与本地是否自洽（不影响学生，但会影响"按文件名对账"）────────
if (!onlyChapter && !limit) {
  console.log('\n== 索引引用 vs 本机实际有的文件 ==')
  for (const ch of CHAPTERS) {
    const dir = localDirOf(ch)
    if (!dir) continue
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => /\.(webp|png|jpe?g|gif)$/i.test(f)) } catch (e) { files = [] }
    const localSet = new Set(files)
    // ⚠️ 这里也**必须**走扩展名回退（同 resolveLocal）：索引里写 `x.png`，
    //    目录里是 `x.webp`。第一版直接拿名字比，于是三章全部报「本机缺 131 张」
    //    并同时报「有 131 张索引没引用」—— 两句话说的是同一批文件。
    //    探针可比错了对象更费时间：它看起来像「索引与磁盘不一致」这种真问题。
    let referenced = null
    try {
      const j = JSON.parse(fs.readFileSync(path.join(rawRoot, ch + '.json'), 'utf8'))
      referenced = new Set()
      for (const s of j.slides || []) for (const m of s.media || []) if (m && m.file) referenced.add(path.basename(m.file))
    } catch (e) { referenced = null }
    if (!referenced) { console.log('  · ' + ch + '：读不到 ' + ch + '.json，跳过引用核对'); continue }
    // ⚠️ 视频要排除：`.mp4` **有意不随课程包分发**（单个 34 MB，不是课程主体），
    //    面板遇到它给的是「此视频未随课程包分发」说明牌 —— 那是设计好的降级。
    //    第一版没排除，于是三章各报「本机缺 N 个」，而那 N 个全是 mp4。
    const refImages = [...referenced].filter((f) => !isVideo(f))
    const missingInLocal = refImages.filter((f) => !resolveLocal(dir, f))
    check(ch + '：索引里引用的图本机全都有（' + refImages.length + ' 个图片引用）', missingInLocal.length === 0,
      missingInLocal.length ? ('本机缺 ' + missingInLocal.length + ' 个：' + missingInLocal.slice(0, 5).join(', ')) : '')
    // 反向：本机有没有索引根本没引用到的图（不影响学生，但"按文件名对账"会对不上）
    const shippedNames = new Set(files)
    const extraLocal = [...shippedNames].filter((f) => !referenced.has(f)
      && ![...referenced].some((r) => path.basename(resolveLocal(dir, r) || '') === f))
    if (extraLocal.length) console.log('  · ' + ch + '：本机有 ' + extraLocal.length + ' 张索引没引用的图（不影响，可能是历史残留）')
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail === 0 ? 0 : 1
// ⚠️ 不调 process.exit：这台机器上 Node v24 用了 fetch 之后 process.exit 会撞
//    libuv 的 UV_HANDLE_CLOSING 断言（退出码 -1073740791），与产品无关。
setTimeout(() => process.exit(process.exitCode), 3000).unref()
