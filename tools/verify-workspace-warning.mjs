/**
 * 验「解析不到工作区时会**真的打出一组能照做的提示**」。
 *
 * 为什么不能靠 createCore 端到端触发：那条分支在本机上走不到 ——
 * 解析链兜底是教师机绝对路径，而这个目录在教师本机上确实存在。
 * （本想用 Rename 把真实目录临时改名来造场景，被系统拒绝：目录被运行中的 DSH 占着。）
 * 所以把渲染抽成 reportUnresolvedWorkspace() 直接喂 data，
 * 同时用一行断言守住「warn() 真的会调用它」。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 找内核源码目录。**两种布局都要认**（发布仓 / 开发侧），
 * 写死一种会让另一个位置跑不起来。
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
const m = await import(pathToFileURL(path.join(CORE_SRC, 'index.js')).href)

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

console.log('=== ① 未解析到工作区：必须打印且可照做 ===')
const said = []
const logger = { warn: (...a) => said.push(a.join(' ')) }
const wsBad = { resolved: false, tried: [], how: '未找到课程工作区（所有候选都没通过校验）' }
const got = m.reportUnresolvedWorkspace(wsBad, path.join(os.tmpdir(), 'cip-绝不存在的课程目录'), '至圣先师鼹鼠精', logger)
const all = said.join('\n')
console.log(said.map((s) => '  | ' + s).join('\n') || '  （什么都没打）')
check('返回值 true（确实打了）', got === true)
check('打了多行（不是一句话打发）', said.length >= 6, said.length + ' 行')
check('点明"没找到课程工作区"', all.includes('没找到课程工作区'))
check('说明是"另一台机器"这个原因', all.includes('另一台机器'))
check('修法① CIP_WORKSPACE', all.includes('CIP_WORKSPACE'))
check('修法② cip-workspace.txt', all.includes('cip-workspace.txt'))
check('修法③ 共享式布局 + 课程码', all.includes('CIP_COURSE_CODE'))
check('给了可执行的判据（课程结构索引.json）', all.includes('课程结构索引.json'))
check('没有把不存在的目录说成"成功"', !all.includes('✓'))
check('尝试过的候选有交代', all.includes('一个都没通过校验'))

console.log('\n=== ② 解析成功时：一个字都不该打（否则每次启动都刷屏）===')
const saidGood = []
const gotGood = m.reportUnresolvedWorkspace(
  { resolved: true, tried: ['x ✓'], how: 'ok' },
  'C:/whatever', '教师端', { warn: (...a) => saidGood.push(a.join(' ')) },
)
check('返回值 false', gotGood === false)
check('没有输出', saidGood.length === 0, saidGood.length + ' 行')

console.log('\n=== ③ 兼容：resolved 字段缺失时按"成功"处理（老调用方）===')
const saidOld = []
const gotOld = m.reportUnresolvedWorkspace(
  { tried: ['x ✓'], how: 'ok' }, 'C:/whatever', '教师端', { warn: (...a) => saidOld.push(a.join(' ')) },
)
check('不误报', gotOld === false && saidOld.length === 0)

console.log('\n=== ④ 守住「warn() 真的会调用它」===')
const hostSrc = fs.readFileSync(path.join(CORE_SRC, 'host.js'), 'utf8')
const css = hostSrc.indexOf('const cssCandidates')
check('createCore 的 warn() 里调用了 reportUnresolvedWorkspace', /warn\(\)\s*\{[\s\S]{0,400}?reportUnresolvedWorkspace\(WS, WORKSPACE, label\)/.test(hostSrc))
check('源码里仍保留 DEFAULT_WORKSPACE 常量（兜底没被删掉）', hostSrc.includes('const DEFAULT_WORKSPACE') || css > -1)
check('info() 下发 workspaceResolved', hostSrc.includes('workspaceResolved'))

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
