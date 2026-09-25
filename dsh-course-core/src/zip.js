/**
 * 最小 zip 读取器 —— 只用 Node 自带的 zlib，不引任何依赖
 *
 * ── 为什么必须能解 zip ────────────────────────────────────────────────
 * 学生的作业常常是**一整个项目**（`src/` + `requirements.txt` + notebook），
 * 交上来自然就是一个文件夹或一个 zip。而批改是模型逐行读代码 ——
 * 如果 zip 只当二进制附件存着，模型看到的就是「一个 3.2 MB 的未知文件」，
 * 然后给出满篇「无法核验」。那等于没交。
 *
 * 所以：**在服务端解开**，把里面的文本条目当成普通文本附件送进批改提示词。
 * 老师也能在面板里逐条展开看，不必下载再解压。
 *
 * ── 为什么自己写而不是装个包 ─────────────────────────────────────────
 * 这个插件要能被学生 clone 下来直接跑（见 课程发布/README）。多一个依赖，
 * 就多一次「pnpm 装不上 / 版本对不上」的失败；而 zip 的**读取**部分
 * （不是写入）是格式里最简单的一块：中央目录 + 两种压缩方式。
 * 解压本身交给 Node 内置的 zlib —— 真正难的 deflate 算法不归我们管。
 *
 * ── 安全边界（这不是杀毒，是防手滑）─────────────────────────────────
 *   · 路径穿越：条目名里的 `..` / 绝对路径一律拒绝（zip slip）
 *   · 数量与体积上限：一个 5000 文件的 zip 会把面板拖死
 *   · 只解压，不落盘执行；二进制条目直接跳过（只取文本）
 */
import zlib from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

/** 认一下是不是 zip（PK\x03\x04）。学生可能把别的压缩包改名成 .zip。 */
export function looksLikeZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b
    && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
}

/**
 * 读中央目录，列出条目。**不在这里解压** —— 先让调用方按体积/类型筛一遍，
 * 免得为了「看看里面有什么」而把 200 MB 全解出来。
 */
export function listZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (!looksLikeZip(b)) throw new Error('这不是一个 zip 文件（开头不是 PK）')
  // EOCD 在文件末尾，但后面可能跟一段注释（最多 64 KB）
  const from = Math.max(0, b.length - 66000)
  let eocd = -1
  for (let i = b.length - 22; i >= from; i -= 1) {
    if (b.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip 结构损坏：找不到中央目录结尾（EOCD）')
  const count = b.readUInt16LE(eocd + 10)
  let p = b.readUInt32LE(eocd + 16)
  if (p === 0xffffffff) throw new Error('暂不支持 ZIP64（超过 4 GB 的包）—— 请拆成几个小包再交')
  const out = []
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== SIG_CEN) {
      throw new Error('zip 结构损坏：第 ' + (i + 1) + ' 条中央目录记录读不出来')
    }
    const method = b.readUInt16LE(p + 10)
    const compSize = b.readUInt32LE(p + 20)
    const size = b.readUInt32LE(p + 24)
    const nameLen = b.readUInt16LE(p + 28)
    const extraLen = b.readUInt16LE(p + 30)
    const commentLen = b.readUInt16LE(p + 32)
    const offset = b.readUInt32LE(p + 42)
    // zip 里的文件名按规范是 UTF-8（或 CP437，那是 DOS 时代的旧包）
    const name = b.slice(p + 46, p + 46 + nameLen).toString('utf8')
    out.push({ name, method, compSize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 解一条条目，返回 Buffer */
export function readEntry(buf, e) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  const p = e.offset
  if (b.readUInt32LE(p) !== SIG_LOC) throw new Error('zip 结构损坏：' + e.name + ' 的本地头对不上')
  const nameLen = b.readUInt16LE(p + 26)
  const extraLen = b.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const raw = b.slice(start, start + e.compSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return zlib.inflateRawSync(raw)
  throw new Error('不支持的压缩方式 ' + e.method + '（' + e.name + '）—— 只用「存储」或「deflate」压的包')
}

/** 目录条目（以 / 结尾、或体积为 0 且没有内容的）—— 不当作文件 */
export function isDirEntry(e) {
  return /\/$/.test(e.name) || /\\$/.test(e.name)
}

/**
 * 条目名是否安全。两类要挡：
 *   · zip slip：`../../etc/passwd` 这种往上跳的
 *   · 绝对路径 / 盘符
 * 只做**判断**不做改名 —— 被拒的条目会原样报给用户看，静默改名更危险。
 */
export function safeEntryName(name) {
  const n = String(name || '').replace(/\\/g, '/')
  if (!n) return false
  if (n[0] === '/') return false
  if (/^[A-Za-z]:/.test(n)) return false
  const parts = n.split('/')
  for (const seg of parts) if (seg === '..') return false
  return true
}

const TEXT_EXT = /\.(py|ipynb|md|txt|yaml|yml|json|csv|tsv|tex|r|m|cpp|c|h|java|js|ts|html|css|toml|cfg|ini|sh|bat|ps1|sql|go|rs|rb|php|xml|gitignore|env|lock)$/i
export const isTextEntry = (name) => TEXT_EXT.test(String(name || '')) || /(^|\/)(README|LICENSE|Makefile|Dockerfile)$/i.test(String(name || ''))

/**
 * 解出文本条目 —— 批改要的就是这些。
 *
 * 三档上限都要有，理由各不同：
 *   maxFiles  一个 5000 文件的包会让面板转很久，而作业不会有 5000 个源文件
 *   maxOne    单个文件读到内存里要有限度（有学生交过 40 MB 的日志）
 *   maxTotal  提示词本身装不下那么多字，超了就要**如实说超了**
 * `skipped` 会把每一类跳过原因都记下来，绝不静默丢弃 ——
 * 「模型没看到那个文件」必须能从结果里查出来。
 */
export function extractTextEntries(buf, opts) {
  const o = opts || {}
  const maxFiles = Number(o.maxFiles) > 0 ? Number(o.maxFiles) : 60
  const maxOne = Number(o.maxOne) > 0 ? Number(o.maxOne) : 200 * 1024
  const maxTotal = Number(o.maxTotal) > 0 ? Number(o.maxTotal) : 600 * 1024
  const entries = listZip(buf).filter((e) => !isDirEntry(e))
  const out = { files: [], skipped: [], totalEntries: entries.length, bytes: 0, truncated: false }
  let budget = maxTotal
  for (const e of entries) {
    if (out.files.length >= maxFiles) { out.skipped.push({ name: e.name, why: '文件数超过上限 ' + maxFiles }); out.truncated = true; continue }
    if (!safeEntryName(e.name)) { out.skipped.push({ name: e.name, why: '路径不安全（含 .. 或绝对路径）' }); continue }
    if (!isTextEntry(e.name)) { out.skipped.push({ name: e.name, why: '不是文本文件（二进制/图片不送进批改）' }); continue }
    if (e.size > maxOne) { out.skipped.push({ name: e.name, why: '单个文件 ' + Math.round(e.size / 1024) + ' KB，超过上限 ' + Math.round(maxOne / 1024) + ' KB' }); continue }
    if (budget <= 0) { out.skipped.push({ name: e.name, why: '总字数已满' }); out.truncated = true; continue }
    let text = ''
    try { text = readEntry(buf, e).toString('utf8') } catch (err) {
      out.skipped.push({ name: e.name, why: '解压失败：' + String((err && err.message) || err).slice(0, 80) })
      continue
    }
    let cut = false
    if (text.length > budget) { text = text.slice(0, budget); cut = true; out.truncated = true }
    budget -= text.length
    out.bytes += Buffer.byteLength(text, 'utf8')
    out.files.push({ name: e.name, text, chars: text.length, size: e.size, truncated: cut })
  }
  return out
}
