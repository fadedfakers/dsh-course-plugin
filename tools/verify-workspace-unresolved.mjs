/**
 * 验「一个候选都没通过校验」那条分支 —— 也就是新机器上最先撞到的情况。
 *
 * 为什么需要它：这条分支在**教师本机上永远走不到**（兜底是教师机绝对路径，
 * 而那个目录恰好存在），所以它以前是「写坏了也没人知道」的状态。
 * 本轮要验的正是「改完还静默吗」。
 *
 * 怎么制造这个场景（而不动真实目录）：
 *   · CIP_WORKSPACE / CIP_COURSE_DIR / CIP_COURSE_CODE 清掉
 *   · CIP_WORKSPACE_FILE 指到一个必然不存在的文件（等价于 `~/.dsh/cip-workspace.txt` 不存在）
 *   · 用 resolveWorkspace({ defaultWorkspace }) 把兜底换成必然不存在的目录
 *     —— 这个参数只给测试用，生产代码走默认值，行为不变。
 *
 * 判据（不是「看着对」）：
 *   ① resolved === false
 *   ② how 里不再有「未验证」这种含糊说法，而是明确说没找到
 *   ③ tried 为空（一个候选都没过）
 *   ④ fallback 仍然给一个**能安全 path.join 的字符串**（否则下游会崩）
 *   ⑤ 真实路径不存在时，**不再**把它当作答案返回
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 找内核源码目录。**两种布局都要认**：
 *   ① 发布仓布局： <仓根>/tools/        + <仓根>/dsh-course-core/
 *   ② 开发侧布局： <工作区>/课程发布/tools/ + <工作区>/课程中心/course-plugin/dsh-course-core/
 * 写死任意一种都会让另一个位置跑不起来（本轮就是这么踩的：脚本在发布侧能跑、
 * 被开发侧的构建门调用时却 ERR_MODULE_NOT_FOUND）。
 */
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
const { resolveWorkspace, DEFAULT_WORKSPACE } = await import(pathToFileURL(path.join(CORE_SRC, 'host.js')).href)

let pass = 0, fail = 0
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  ' + extra : '')) }
}

// ── 场景 A：新机器（所有来源都不存在）────────────────────────────────
console.log('=== A. 模拟另一台电脑：所有候选都不存在 ===')
delete process.env.CIP_WORKSPACE
delete process.env.CIP_COURSE_DIR
delete process.env.CIP_COURSE_CODE
process.env.CIP_WORKSPACE_FILE = path.join(os.tmpdir(), 'cip-不存在的工作区文件.txt')
fs.rmSync(process.env.CIP_WORKSPACE_FILE, { force: true })

const NONEXISTENT = path.join(os.tmpdir(), 'cip-不存在的兜底目录')
const wsA = resolveWorkspace({ defaultWorkspace: NONEXISTENT })

console.log('  dir   =', wsA.dir)
console.log('  how   =', wsA.how)
console.log('  tried =', JSON.stringify(wsA.tried))
check('① resolved === false（机器可判，不再靠读文案）', wsA.resolved === false, String(wsA.resolved))
check('② how 明确说「未找到」，不再用「未验证」含糊过去', wsA.how.includes('未找到') && !wsA.how.includes('未验证'), wsA.how)
check('③ tried 为空（一个候选都没通过）', Array.isArray(wsA.tried) && wsA.tried.length === 0)
check('④ dir 仍是可拼接的字符串（下游 path.join 不会崩）', typeof wsA.dir === 'string' && wsA.dir.length > 0)
check('⑤ 没有把一个不存在的目录当成"成功解析"', wsA.dir !== NONEXISTENT || wsA.resolved === false)
check('⑥ 带上 defaultWorkspace 供提示文案使用', wsA.defaultWorkspace === NONEXISTENT)
// 关键：确实不存在
check('⑦ 该目录确实不存在（否则这个用例没意义）', !fs.existsSync(wsA.dir), wsA.dir)

// ── 场景 B/C：回归。★这两段依赖「本机有一个真实课程工作区」★ ──────────────
//
// 发布出去的副本跑在别人机器上，那里不一定有工作区，所以**必须能优雅跳过** ——
// 否则外人 clone 下来一跑就是红的，还以为是插件坏了。
// 判据：拿兜底值问一下它存不存在；不存在就跳过，不算失败。
console.log('\n=== B/C. 回归（需要本机存在一个真实课程工作区）===')
if (!fs.existsSync(DEFAULT_WORKSPACE)) {
  console.log('  （跳过：本机没有 ' + DEFAULT_WORKSPACE + '，这两段只对开发机有意义）')
} else {
  console.log('\n--- B. 真实工作区仍能解析（用真实兜底值）---')
  delete process.env.CIP_WORKSPACE_FILE
  const wsB = resolveWorkspace()
  console.log('  dir   =', wsB.dir)
  console.log('  how   =', wsB.how)
  check('resolved === true', wsB.resolved === true, String(wsB.resolved))
  check('解析到真实工作区', wsB.dir === path.resolve(DEFAULT_WORKSPACE), wsB.dir)
  check('tried 有内容', wsB.tried.length > 0, wsB.tried.join(' | '))
  check('里面有 课程中心', fs.existsSync(path.join(wsB.dir, '课程中心')))

  console.log('\n--- C. CIP_WORKSPACE 指对目录 ---')
  process.env.CIP_WORKSPACE = DEFAULT_WORKSPACE
  const wsC = resolveWorkspace({ defaultWorkspace: NONEXISTENT })
  check('resolved === true', wsC.resolved === true)
  check('解析到该目录', wsC.dir === path.resolve(DEFAULT_WORKSPACE), wsC.dir)
  check('how 里提到 CIP_WORKSPACE', wsC.how.includes('CIP_WORKSPACE'), wsC.how)
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
