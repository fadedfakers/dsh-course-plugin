/**
 * 备份**源材料**到私有仓（`DSH-algorithm-privated`）。
 *
 * ── 为什么这件事比"资料放哪"更急 ────────────────────────────────────────
 * 本轮把材料分布量了一遍，结论是：
 *
 *     教师机工作区 ≈ **250 MB**（原始 pptx 90 MB + 原始导出图 89.5 MB + …）
 *     学生 clone 到的公开仓 = **15 MB**（压缩后的课件图 + 教案 + 面板）
 *
 * 也就是说：**那些"发不出去"的部分（原件、原始导出图、未发布教案）
 * 只存在这一台电脑上** —— 没有备份、没有版本历史。硬盘坏了就没了，
 * 而这门课的全部劳动都在里面。
 *
 * 公开仓保护的是"能发出去的那一半"；这个脚本补的是另一半。
 *
 * ── 备份什么（**不是整盘拷**）────────────────────────────────────────────
 * 只备份**不可再生的**东西。判据是「丢了之后能不能重新得到」：
 *
 *   ✅ 原始 pptx（90 MB）—— 不可再生
 *   ✅ 转好的 PDF（10.3 MB）—— 可再生（但要装 WPS/Office），顺手带上更省事
 *   ✅ 索引 / 教案 / 大纲 / 文档 —— 不可再生
 *   ✅ `资料.json`、`课程配置.json`、问题池 —— 不可再生（这门课的记录）
 *   ❌ 原始导出图 89.5 MB —— **可再生**（从 pptx 抽一次就有了）
 *   ❌ `.webp-out` 13.6 MB —— 可再生（to_webp.py 跑一遍）
 *   ❌ 公开仓工作副本、插件构建产物 —— 本来就都在仓里
 * 这样备份从 ~250 MB 降到 ~110 MB，而**没有丢任何不可再生的东西**。
 *
 * ⚠️ 私有仓是**私有**的，但它仍然在 GitHub 上。所以：
 *   · 不放任何凭据（token/密钥）—— 脚本会扫一遍并拒绝可疑文件
 *   · 不放学生提交的作业原文（`作业提交/` 里可能有学生的东西，那是隐私）
 *   · 不放 `.git` 目录（嵌套仓库，推上去是一堆垃圾）
 *
 * 用法：
 *   node tools/backup-sources.mjs                 # 只列出会备份什么、多大
 *   node tools/backup-sources.mjs --push "信息"    # 真的推
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptured, runExitCode, runOutput } from '../../课程中心/course-plugin/dsh-course-core/src/run.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLISH_DIR = path.dirname(HERE)
const WORKSPACE = path.dirname(PUBLISH_DIR)

const argv = process.argv.slice(2)
const doPush = argv.includes('--push')
const msgIdx = argv.indexOf('--push')
const message = msgIdx > -1 && argv[msgIdx + 1] && !argv[msgIdx + 1].startsWith('--') ? argv[msgIdx + 1] : ''
const OWNER_REPO = process.env.CIP_BACKUP_REPO || 'fadedfakers/DSH-algorithm-privated'
const BRANCH = process.env.CIP_BACKUP_BRANCH || 'main'
/** 清单文件落在发布目录下（可提交、可复查"到底备份了什么"） */
const LIST_FILE = path.join(PUBLISH_DIR, 'backup.manifest.txt')

// ── 要备份的顶层条目（后缀 `/` 表示整个目录） ──────────────────────────
const INCLUDE_FILES = ['教学大纲.md', '教学大纲-优化版.md', '详细教案-30课时.md',
  '课程配置.json', '资料.json', '我的身份.json', '课程资料导航.md',
  '数据集建议与下载说明.md', '模块四与模块五_缺口清单.md', '课程生产流水线.md']
const INCLUDE_GLOBS = [/\.pptx$/i, /\.pdf$/i]
const INCLUDE_DIRS = ['教案草稿', '课程中心']
/** 目录里的**排除**规则（可再生 / 隐私 / 太大） */
const EXCLUDE_DIRS = [
  '课程中心/.cache',            // 缓存
  '课程中心/course-plugin',     // 插件源码（在公开仓里）
  '课程中心/course-panel-plugin', // 旧单体客户端
  '课程中心/_归档',             // 归档
  '课程中心/预览数据/media',     // 原始导出图 89.5 MB —— 可从 pptx 重抽
  '课程中心/预览数据/第一章', '课程中心/预览数据/第二章', '课程中心/预览数据/第三章', // 同上（另一种摆法）
  '作业提交',                   // 学生隐私：学生交的东西不该进任何仓
  '课程问题池/学生',             // 同上：学生自己的提问目录
]
const EXCLUDE_FILES = [/\.(tmp|log|bak)$/i, /^\.tmp/i]
/** 可疑内容（凭据）—— 命中就**拒绝备份**，并把文件报出来 */
const SECRET_PAT = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{30,}/

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

const rel = (p) => path.relative(WORKSPACE, p).replace(/\\/g, '/')
const excluded = (r) => {
  for (const d of EXCLUDE_DIRS) if (r === d || r.startsWith(d + '/')) return true
  for (const re of EXCLUDE_FILES) if (re.test(path.basename(r))) return true
  // 嵌套 git 仓库（公开仓工作副本、插件发布副本）一律不备份
  if (r.indexOf('/.git/') >= 0 || r.endsWith('/.git')) return true
  return false
}

console.log('工作区  : ' + WORKSPACE)
console.log('备份到  : ' + OWNER_REPO + '（' + BRANCH + '）\n')

const picked = []
let skippedBytes = 0
const pushFile = (abs) => {
  const r = rel(abs)
  if (excluded(r)) { skippedBytes += 0; return }
  try { picked.push({ r, abs, bytes: fs.statSync(abs).size }) } catch (e) { /* 读不到就跳过 */ }
}
const walk = (dir) => {
  let es = []
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
  for (const e of es) {
    const full = path.join(dir, e.name)
    if (excluded(rel(full))) continue
    if (e.isDirectory()) { walk(full); continue }
    pushFile(full)
  }
}
console.log('== 收集 ==')
for (const f of INCLUDE_FILES) {
  const abs = path.join(WORKSPACE, f)
  if (fs.existsSync(abs)) pushFile(abs)
}
for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
  if (!e.isFile()) continue
  if (INCLUDE_GLOBS.some((re) => re.test(e.name))) pushFile(path.join(WORKSPACE, e.name))
}
for (const d of INCLUDE_DIRS) {
  const abs = path.join(WORKSPACE, d)
  if (fs.existsSync(abs)) walk(abs)
}
picked.sort((a, b) => a.r.localeCompare(b.r))
const totalBytes = picked.reduce((s, x) => s + x.bytes, 0)
console.log('  选中 ' + picked.length + ' 个文件，合计 ' + (totalBytes / 1048576).toFixed(1) + ' MB')
const byTop = {}
for (const p of picked) {
  const top = p.r.split('/')[0]
  byTop[top] = byTop[top] || { n: 0, b: 0 }
  byTop[top].n += 1
  byTop[top].b += p.bytes
}
for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1].b - a[1].b).slice(0, 8)) {
  console.log('    ' + k.padEnd(28) + String(v.n).padStart(4) + ' 个  ' + (v.b / 1048576).toFixed(1).padStart(7) + ' MB')
}

console.log('\n== 自检 ==')
check('选中的东西**不是空的**', picked.length > 0, picked.length + ' 个')
check('原始 pptx 在里面（最不可再生的那一份）', picked.some((p) => /\.pptx$/i.test(p.r)),
  picked.filter((p) => /\.pptx$/i.test(p.r)).map((p) => p.r).join('、'))
check('没有把原始导出图（89.5 MB 可再生）搭进去',
  !picked.some((p) => /预览数据\/media\//.test(p.r)),
  picked.filter((p) => /预览数据\/media\//.test(p.r)).length + ' 个混进来了')
check('没有把学生提交/学生提问搭进去（隐私）',
  !picked.some((p) => /^(作业提交|课程问题池\/学生)\//.test(p.r)),
  picked.filter((p) => /^(作业提交|课程问题池\/学生)\//.test(p.r)).map((p) => p.r).slice(0, 3).join('、'))
check('没有嵌套 .git 目录', !picked.some((p) => p.r.indexOf('.git/') >= 0))
// ★ 凭据扫一遍：私有仓也是 GitHub 上的东西，密钥不该进去
{
  const hits = []
  for (const p of picked) {
    if (p.bytes > 4 * 1048576) continue          // 大文件（pptx/pdf）不逐字节扫
    try {
      const t = fs.readFileSync(p.abs, 'utf8')
      if (SECRET_PAT.test(t)) hits.push(p.r)
    } catch (e) { /* 二进制读不动就跳过 */ }
  }
  check('【安全】没有任何文件含凭据形状的字符串', hits.length === 0, hits.slice(0, 5).join('、'))
}
// 单文件上限：GitHub 硬限 100 MB，而 REST 建 blob 也按这个来
{
  const tooBig = picked.filter((p) => p.bytes > 95 * 1024 * 1024)
  check('没有超过 95 MB 的单文件（GitHub 硬限 100 MB）', tooBig.length === 0,
    tooBig.map((p) => p.r + ' ' + (p.bytes / 1048576).toFixed(0) + 'MB').join('、'))
}

// ── 写清单（可提交，用来复查"到底备份了什么"）────────────────────────────
fs.writeFileSync(LIST_FILE, [
  '# 源材料备份清单 —— 由 tools/backup-sources.mjs 生成。',
  '# 备份到 ' + OWNER_REPO + '（**私有**仓）。',
  '# 只备份不可再生的东西：原始 pptx / 转好的 PDF / 索引 / 教案 / 文档。',
  '# 刻意**不**备份：原始导出图与 webp 产物（可从 pptx 重抽）、学生作业与提问（隐私）、',
  '#             插件源码与公开仓副本（本来就在公开仓里）。',
  '# 生成时间：' + new Date().toISOString(),
  '# 共 ' + picked.length + ' 个文件，' + (totalBytes / 1048576).toFixed(1) + ' MB',
  '',
  ...picked.map((p) => p.r),
].join('\n') + '\n', 'utf8')
console.log('\n  清单已写入 ' + rel(LIST_FILE) + '（' + picked.length + ' 条）')

if (!doPush) {
  console.log('\n（只报告。要真的备份请加：--push "备份信息"）')
  console.log('  它会走 REST 通道推 ' + (totalBytes / 1048576).toFixed(1) + ' MB —— 大约几分钟。')
  process.exitCode = fail === 0 ? 0 : 1
} else {
  if (!message) { console.error('✗ --push 需要一句提交信息'); process.exit(2) }
  console.log('\n== 推送（REST 建 blob/tree/commit）==')
  const r = runCaptured(process.execPath, [path.join(HERE, 'exchange-repo.mjs'), OWNER_REPO, WORKSPACE,
    '--list-file', LIST_FILE, '--branch', BRANCH, '--push', message],
  { timeout: 3600000, hintDir: WORKSPACE })
  console.log(runOutput(r).split('\n').slice(-30).join('\n'))
  const code = runExitCode(r)
  check('推送完成（exit ' + code + '）', code === 0)
  process.exitCode = (fail === 0 && code === 0) ? 0 : 1
}
