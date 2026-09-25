/**
 * 命令行自检：看插件把「课程工作区」解析到了哪里。
 *
 * 什么时候用：
 *   · 换到另一台电脑后，第一件要确认的事就是「工作区配对了吗」
 *   · 面板空着但没有任何报错时
 *   · 想确认「找不到工作区」时会明确报出来，而不是静默给个不存在的目录
 *
 * 路径全部由本文件位置推出，**不写死**（换机器/换目录名都不会失效）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 本文件在 <仓根>/tools/ 下，内核源码在 <仓根>/dsh-course-core/src/host.js
const CORE_HOST = path.resolve(HERE, '..', 'dsh-course-core', 'src', 'host.js')

if (!fs.existsSync(CORE_HOST)) {
  console.error('✗ 找不到内核源码：' + CORE_HOST)
  console.error('  （这个脚本要在插件仓的 tools/ 下跑）')
  process.exit(2)
}
const { resolveWorkspace, DEFAULT_WORKSPACE } = await import(pathToFileURL(CORE_HOST).href)

console.log('插件仓    : ' + path.resolve(HERE, '..'))
console.log('家目录    : ' + os.homedir())

const wf = process.env.CIP_WORKSPACE_FILE || path.join(os.homedir(), '.dsh', 'cip-workspace.txt')
console.log('工作区文件: ' + wf)
console.log('  存在吗  : ' + fs.existsSync(wf))
if (fs.existsSync(wf)) {
  try { console.log('  内容    : ' + fs.readFileSync(wf, 'utf8').trim()) } catch { /* 读不了就算了 */ }
}
console.log('内置兜底  : ' + DEFAULT_WORKSPACE + '   （存在吗: ' + fs.existsSync(DEFAULT_WORKSPACE) + '）')
for (const k of ['CIP_WORKSPACE', 'CIP_COURSE_DIR', 'CIP_COURSE_CODE']) {
  console.log((k + '        ').slice(0, 10) + ': ' + (process.env[k] || '（未设）'))
}

console.log('\n=== 当前实际解析结果 ===')
const ws = resolveWorkspace()
console.log('  workspace    : ' + ws.dir)
console.log('  courseDir    : ' + ws.courseDir)
console.log('  how          : ' + ws.how)
console.log('  resolved     : ' + ws.resolved)
console.log('  目录存在吗   : ' + fs.existsSync(ws.dir))
console.log('  有 课程中心  : ' + fs.existsSync(path.join(ws.dir, '课程中心')))
console.log('  tried        :')
for (const t of ws.tried) console.log('     ' + t)
if (!ws.tried.length) console.log('     （一个候选都没通过校验）')

console.log('\n=== 判定 ===')
if (ws.resolved === false) {
  console.log('  ✗ 没找到工作区。面板会是空的，而且这是**新机器上最常见的第一个坑**。')
  console.log('    修法（任选一条，改完重启 DSH）：')
  console.log('      ① 设环境变量 CIP_WORKSPACE=<你的课程工作区目录>')
  console.log('      ② 或把一行目录写进 ' + wf)
  console.log('      ③ 共享式布局再加 CIP_COURSE_CODE=<课程码>')
  console.log('    判据：该目录下要有「课程中心' + path.sep + '课程结构索引.json」。')
  process.exit(1)
}
if (!fs.existsSync(path.join(ws.dir, '课程中心'))) {
  console.log('  ⚠ 解析到了目录，但里面没有「课程中心」——面板会读到空课程。')
  console.log('    确认 ' + ws.dir + ' 是不是你要的那个工作区。')
  process.exit(1)
}
console.log('  ✓ 工作区解析正常，课程数据可读。')
