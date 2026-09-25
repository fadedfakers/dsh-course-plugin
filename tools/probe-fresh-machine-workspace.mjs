/**
 * 模拟「另一台电脑」：把解析链上「这台机器才有」的那些来源全部换成不存在的路径，
 * 看 resolveWorkspace() 给出什么。
 *
 * 为什么要这么测：core 里的兜底值是一个**写死的绝对路径**，形如
 *     const DEFAULT_WORKSPACE = 'C:\\Users\\<当初那台机器>\\Desktop\\<课程目录>'
 * 它是解析链的最后一道兜底。新机器上没有 ~/.dsh/cip-workspace.txt、
 * 也没有 CIP_* 环境变量，那么兜底命中 —— 但那个目录在新机器上**不存在**。
 *
 * 我第一版模拟是错的：只改了 USERPROFILE/HOME，而 os.homedir() 在 Windows 上
 * 不跟随它们（是调 Win32 API 拿的），于是「模拟新机器」其实还在读本机的家目录，
 * 结果和现状一模一样 —— 假阴性，看着像「没问题」。
 * 所以改成直接覆盖解析链上的每一环（CIP_WORKSPACE / CIP_WORKSPACE_FILE），
 * 这才是真的把「教师机专属来源」全掐掉。
 *
 * 注意：**在教师本机上这个脚本依然测不出「落空」**——因为兜底那个目录真的存在，
 * 它会正常命中。要做真正的"落空"判定，用 probe-workspace.mjs（它直接报当前解析结果），
 * 或看 verify-workspace-unresolved.mjs（用注入的兜底值强制走那条分支）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function findCoreSrc(startDir) {
  let d = startDir
  for (let i = 0; i < 6; i++) {
    for (const rel of ['dsh-course-core/src', '课程中心/course-plugin/dsh-course-core/src']) {
      const p = path.resolve(d, rel)
      if (fs.existsSync(path.join(p, 'host.js'))) return p
    }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE_SRC = findCoreSrc(HERE)
if (!CORE_SRC) {
  console.error('✗ 找不到 dsh-course-core/src（向上找了 6 层，两种布局都试过）')
  process.exit(2)
}
const { resolveWorkspace } = await import(pathToFileURL(path.join(CORE_SRC, 'host.js')).href)

const emptyFile = path.join(os.tmpdir(), 'cip-empty-workspace.txt')
fs.writeFileSync(emptyFile, '', 'utf8')

// 掐掉教师机专属来源：工作区文件指到一个空文件，环境变量指到不存在的目录
process.env.CIP_WORKSPACE_FILE = emptyFile
process.env.CIP_WORKSPACE = path.join('C:', 'Users', 'somebody-else', 'Desktop', '我的课程')
delete process.env.CIP_COURSE_DIR
delete process.env.CIP_COURSE_CODE

console.log('真实家目录        :', os.homedir())
console.log('CIP_WORKSPACE     :', process.env.CIP_WORKSPACE, '（不存在）')
console.log('CIP_WORKSPACE_FILE:', emptyFile, '（空文件）')
console.log('（已清掉 CIP_COURSE_DIR / CIP_COURSE_CODE）\n')

const ws = resolveWorkspace()
console.log('解析结果：')
console.log('  dir       :', ws.dir)
console.log('  how       :', ws.how)
console.log('  tried     :', ws.tried.length ? ws.tried : '（空 —— 没有任何候选通过校验）')
console.log('\n判定：')
console.log('  dir 存在吗        :', fs.existsSync(ws.dir))
console.log('  有 课程中心/ 吗   :', fs.existsSync(path.join(ws.dir, '课程中心')))
console.log('  how 里有「未验证」:', ws.how.includes('未验证'))
