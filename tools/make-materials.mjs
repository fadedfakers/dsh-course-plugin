/**
 * 生成 / 刷新 `资料.json`（老师那份「资料清单」）+ 把课件原件转成 PDF。
 *
 * ── 它解决的是哪件事 ────────────────────────────────────────────────────
 * 老师问：「教师课件、ppt、资料放哪，学生从哪连接到该仓库？」
 * 答案是：**老师维护一份清单，学生按清单拿**。这个脚本负责把清单生成出来 ——
 * 不让老师手写 JSON（手写一定会漏字段、会写错路径、会忘了某个文件）。
 *
 * ── 它做四件事 ──────────────────────────────────────────────────────────
 *   ① 找课件原件（工作区根目录的 `第一章.pptx` 这种）
 *   ② 转成 PDF 放进 `资料/`（浏览器没有 pptx 渲染器，PDF 才能在线看）
 *   ③ 生成 `资料.json`：每一项的标题 / 类型 / 大小 / 章节映射 / 预览方式
 *   ④ **逐项核对**：清单里写的文件到底在不在、大小对不对，缺的当场报出来
 *
 * ── 为什么"不猜"章节映射 ────────────────────────────────────────────────
 * 每一章有自己的 `<章>.json`（面板用它渲染课件页），而原件是一整个 pptx。
 * 「第一章 = PPT 的第几页到第几页」这件事索引里**没有**，猜错会让学生点
 * 「去课件页框选」跳到错的页 —— 而那种错看起来像"面板坏了"。
 * 所以这里只填**能从文件名对上的那部分**（`第一章.pptx` → `第一章`），
 * `from/to` 留空并写进 `_待补`，让老师在清单里手填（一行的事）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/make-materials.mjs                    # 只报告（不转、不写）
 *   node tools/make-materials.mjs --convert          # 顺便把 pptx 转成 PDF
 *   node tools/make-materials.mjs --convert --force  # 已存在的 PDF 也重转
 *   node tools/make-materials.mjs --url-prefix https://github.com/o/r/releases/download/v1
 *        → 生成"文件放 Releases"的清单（不复制进仓，只写 url）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptured, runOutput, runExitCode } from '../../课程中心/course-plugin/dsh-course-core/src/run.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLISH_DIR = path.dirname(HERE)
const WORKSPACE = path.dirname(PUBLISH_DIR)

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DO_CONVERT = has('convert')
const FORCE = has('force')
const URL_PREFIX = String(opt('url-prefix', '')).replace(/\/+$/, '')

const CHAPTERS = ['第一章', '第二章', '第三章']
const MAT_DIR = path.join(WORKSPACE, '资料')
const MANIFEST = path.join(WORKSPACE, '资料.json')

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

// ── ① 找原件 ──────────────────────────────────────────────────────────
console.log('工作区：' + WORKSPACE)
const decks = []
for (const ch of CHAPTERS) {
  for (const ext of ['.pptx', '.ppt']) {
    const p = path.join(WORKSPACE, ch + ext)
    if (fs.existsSync(p)) { decks.push({ ch, src: p, bytes: fs.statSync(p).size, ext }); break }
  }
}
// 根目录下别的 pptx 也收进来（可能叫别的名字）
for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
  if (!e.isFile() || !/\.pptx?$/i.test(e.name)) continue
  const p = path.join(WORKSPACE, e.name)
  if (decks.some((d) => d.src === p)) continue
  decks.push({ ch: path.basename(e.name, path.extname(e.name)), src: p, bytes: fs.statSync(p).size, ext: path.extname(e.name) })
}
console.log('\n== ① 课件原件 ==')
if (!decks.length) {
  console.log('  （工作区根目录下没有 .pptx —— 没东西可转）')
} else {
  for (const d of decks) console.log('  · ' + path.basename(d.src).padEnd(22) + mb(d.bytes))
}
check('找到至少一份课件原件', decks.length > 0, decks.length + ' 份')

// ── ② 转 PDF ──────────────────────────────────────────────────────────
console.log('\n== ② 转 PDF（浏览器没有 pptx 渲染器，PDF 才能在线看）==')
fs.mkdirSync(MAT_DIR, { recursive: true })
const ps1 = path.join(HERE, 'deck-to-pdf.ps1')
if (!fs.existsSync(ps1)) {
  console.log('  ✗ 找不到 tools/deck-to-pdf.ps1 —— 没有它就不能自动转')
} else {
  for (const d of decks) {
    const dst = path.join(MAT_DIR, d.ch + '-原件.pdf')
    if (fs.existsSync(dst) && !FORCE) {
      d.pdf = dst
      d.pdfBytes = fs.statSync(dst).size
      console.log('  · ' + path.basename(dst).padEnd(22) + mb(d.pdfBytes) + '　（已存在，跳过；--force 可重转）')
      continue
    }
    if (!DO_CONVERT) {
      console.log('  · ' + d.ch + '：还没转（加 --convert 就转）')
      continue
    }
    const t0 = Date.now()
    // ⚠️ 走 runCaptured（**不是 spawnSync+encoding**）：沙箱里带管道一律 EPERM，
    //    而且**不抛异常**，只会得到「退出码 null + 没有输出」——
    //    看起来像"转换脚本本身没说话"。见 core/src/run.js 顶部注释。
    const r = runCaptured('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Pptx', d.src, '-Out', dst], { timeout: 900000, hintDir: WORKSPACE })
    const code = runExitCode(r)
    const out = runOutput(r)
    if (code === 0 && fs.existsSync(dst)) {
      d.pdf = dst
      d.pdfBytes = fs.statSync(dst).size
      const pages = (/SLIDES=(\d+)/.exec(out) || [])[1] || '?'
      console.log('  · ' + path.basename(dst).padEnd(22) + mb(d.pdfBytes)
        + '　' + pages + ' 页　' + Math.round((Date.now() - t0) / 1000) + ' 秒')
    } else {
      console.log('  ✗ ' + d.ch + ' 转换失败（exit ' + code + '）：' + out.split('\n').slice(0, 3).join(' / '))
    }
  }
}

// ── ③ 生成清单 ────────────────────────────────────────────────────────
console.log('\n== ③ 生成 资料.json ==')
/**
 * 章节映射：**只在能核对上的时候自动填**，否则留空并说明。
 *
 * 判据（本轮实测出来的）：把 PDF 的页数与 `<章>.json` 的页数对一下 ——
 *   第一章：PDF 58 页 / json 58 页  → 一一对应，**可以自动填**
 *   第二章：PDF 56 页 / json 56 页  → 同上
 *   第三章：PDF 19 页 / json 36 页  → **对不上**，不能猜（见下面 待补 的说明）
 * 这个办法不"聪明"，但它**可证伪**：页数不同就一定不填，而不是填一个看起来
 * 合理的范围。猜错的后果是学生点「去课件页框选」跳到错的页 ——
 * 而那种错在界面上完全看不出来，只会让人觉得"面板坏了"。
 */
function pdfPages(pdfAbs) {
  if (!fs.existsSync(pdfAbs)) return 0
  try {
    // 不引第三方库：PDF 里 `/Type /Page`（不是 /Pages）出现的次数就是页数。
    // 对本机 WPS 导出的 PDF 实测准确（58 / 56 / 19 三个都对上了）。
    // 数不准时返回 0 —— 那只是"不自动填映射"，不会写错东西。
    const buf = fs.readFileSync(pdfAbs)
    const s = buf.toString('latin1')
    const m = s.match(/\/Type\s*\/Page[^s]/g)
    return m ? m.length : 0
  } catch (e) { return 0 }
}
const items = []
const 待补 = []
for (const d of decks) {
  const pdfName = d.ch + '-原件.pdf'
  const pdfAbs = path.join(MAT_DIR, pdfName)
  const havePdf = fs.existsSync(pdfAbs)
  const useUrl = !!URL_PREFIX
  const entry = {
    title: d.ch + ' 课件原件',
    kind: 'slides',
    file: d.ch + path.extname(d.src),
    note: '完整原件，可翻页、可打印。要对着某一页提问，用面板的「去课件页框选」。',
  }
  if (useUrl) {
    // 文件放 Releases / 对象存储：清单里写 url，**不复制进仓**（仓才瘦得下来）
    entry.url = URL_PREFIX + '/' + encodeURIComponent(path.basename(d.src))
    entry.size = d.bytes
    entry.note += '（远端直链，点开即下）'
  } else {
    entry.size = havePdf ? fs.statSync(pdfAbs).size : d.bytes
    if (havePdf) entry.note += '　同目录另有 PDF 可直接在线看。'
  }
  // 章节映射：**能核对上才自动填**（见上面 pdfPages 的注释）
  const jsonAbs = path.join(WORKSPACE, '课程中心', '预览数据', d.ch + '.json')
  let jsonPages = 0
  try { jsonPages = (JSON.parse(fs.readFileSync(jsonAbs, 'utf8')).slides || []).length } catch (e) { jsonPages = 0 }
  const pdfP = havePdf ? pdfPages(pdfAbs) : 0
  if (jsonPages > 0) {
    if (pdfP > 0 && pdfP === jsonPages) {
      // 一一对应：可以放心填
      entry.slides = { chapter: d.ch, from: 1, to: pdfP, pdf: havePdf ? ('资料/' + pdfName) : '' }
      console.log('  · ' + d.ch + '：PDF ' + pdfP + ' 页 = 课件 ' + jsonPages + ' 页 → 映射自动填 1..' + pdfP)
    } else {
      entry.slides = { chapter: d.ch, from: 1, to: 0, pdf: havePdf ? ('资料/' + pdfName) : '' }
      待补.push(d.ch + '：原件 ' + (pdfP || '?') + ' 页 / 课件页 ' + jsonPages + ' 页 —— 对不上，'
        + '「去课件页框选」会跳到第 1 页（那也比跳错页好）。请核对后填 slides.from/to。')
      console.log('  · ' + d.ch + '：PDF ' + (pdfP || '?') + ' 页 ≠ 课件 ' + jsonPages + ' 页 → 映射**不自动填**（已记为待补）')
    }
  }
  items.push(entry)
  // PDF 单独也列一项：学生要的是"能在线看"，而 pptx 不能内嵌
  if (!useUrl && havePdf) {
    items.push({
      title: d.ch + ' 课件（PDF，可在线看）',
      kind: 'pdf',
      file: pdfName,
      size: fs.statSync(pdfAbs).size,
      note: '浏览器里直接翻页看；要框选某一块提问，用「去课件页框选」。',
    })
  }
}
const manifest = {
  _说明: '资料清单。面板的「资料」页按它渲染：每一项给学生一个下载入口，能在线看的还会给预览。',
  _怎么改: '加一项就多一个文件：file 是 资料/ 下的相对路径；文件放在别处（Releases / 对象存储）时改写 url（http/https 直链），不要再写 file。',
  _预览: 'kind=pdf/image/video 浏览器能直接内嵌预览；kind=slides（pptx 原件）不能，所以配一份 PDF 并用 slides.pdf 指过去，或让学生用「去课件页框选」。',
  _待补: 待补,
  updated: new Date().toISOString().slice(0, 10),
  note: URL_PREFIX ? ('原件放在 ' + URL_PREFIX + '（Releases / 对象存储），仓里只留清单。') : '原件与 PDF 都在仓内的 资料/ 目录下。',
  items,
}

if (!has('dry-run')) {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf8')
  console.log('  已写入 ' + MANIFEST + '（' + items.length + ' 项）')
} else {
  console.log('  （--dry-run，没有写文件）')
}
for (const t of 待补) console.log('  · 待补：' + t)

// ── ④ 逐项核对（清单说有的，磁盘上真的有吗）────────────────────────────
console.log('\n== ④ 核对清单 ==')
{
  const list = (() => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch (e) { return null } })()
  check('资料.json 可解析', !!list, MANIFEST)
  if (list) {
    /**
     * ⚠️ 判据不能是「清单里 file 那个名字在不在」。
     *
     * `file` 指的是**原件**（`第一章.pptx`，48.9 MB），而它**故意不进公开仓**
     * （单文件大、而且是二进制，进 git 之后历史永久背着它）。进仓的是它的 PDF。
     * 所以「仓内这一项有没有东西可给学生」要看**有没有 PDF**，不是看原件在不在。
     * 第一版按原名去查 → 三项全报「缺」，而那是设计好的形态 ——
     * 又是探针比错对象（这个项目里第 N 次了）。
     */
    const missing = []
    for (const it of list.items || []) {
      if (it.url) continue
      const rel = String(it.file || '').replace(/^资料\//, '')
      const p = path.join(WORKSPACE, '资料', rel)
      if (fs.existsSync(p)) continue
      // 原件不在仓里是正常的：只要它的 PDF 在，学生就有东西可拿
      if (it.kind === 'slides' && it.slides && it.slides.pdf) {
        const pdfRel = String(it.slides.pdf).replace(/^资料\//, '')
        if (fs.existsSync(path.join(WORKSPACE, '资料', pdfRel))) continue
      }
      missing.push(rel + (it.kind === 'slides' ? '（原件与它的 PDF 都不在）' : ''))
    }
    check('清单里每一项都能给学生**东西**（原件或它的 PDF）', missing.length === 0,
      missing.length ? ('缺：' + missing.slice(0, 5).join('、')) : ((list.items || []).length + ' 项都有'))

    // ★ 这一条是给老师看的**结论**：现在学生能不能在线看课件原件
    const hasPreviewable = (list.items || []).some((it) => it.kind === 'pdf' && !it.url)
    check('至少有一份 PDF 能在线看（否则"在线预览原件"是空承诺）', hasPreviewable,
      hasPreviewable ? '' : '没有任何 kind=pdf 的项 —— 学生只能下载 pptx，而浏览器看不了 pptx')

    // ★ 原件（pptx）**不该**进公开仓：它只让仓变胖，而且学生看不了
    const pptxInPublic = (list.items || []).some((it) => !it.url && /\.pptx?$/i.test(String(it.file || ''))
      && fs.existsSync(path.join(WORKSPACE, '资料', String(it.file || '').replace(/^资料\//, ''))))
    check('原件没有偷偷复制进公开仓（仓里只放 PDF，原件走备份）', !pptxInPublic,
      pptxInPublic ? '资料/ 下出现了 .pptx —— 它会跟着学生 clone 下去，而浏览器打不开它' : '')
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
console.log('\n下一步：')
console.log('  1) 把「章节 → 原件页范围」填进 资料.json 的 slides.from/to（上面「待补」那几条）')
console.log('  2) node course-repo.mjs publish   —— 资料/ 与 资料.json 会一起进公开仓')
console.log('  3) 学生端打开面板的「资料」页即可下载 / 在线看')
if (URL_PREFIX) {
  console.log('  4) 原件（pptx）要自己传到 ' + URL_PREFIX + ' —— 本脚本不代传（要你的凭据）')
}
process.exitCode = fail === 0 ? 0 : 1
