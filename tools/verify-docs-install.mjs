/**
 * 验「文档里的安装说明」与**产品实际行为**一致。
 *
 * ── 为什么值得单独一步 ──────────────────────────────────────────────────
 * 老师提的原话：「我创建的不是 DSH 插件吗，选择课程内容公开仓地址应在插件安装完之后，
 * 我觉得需要在 github 的 readme 上声明（学生端只装核与学生端插件）」。
 *
 * 这条反馈暴露的是**文档从来没被断言覆盖**：README 里原来写着「三个包都要装」，
 * 而实际上学生机只需要两个；安装命令写的是 `add ./dsh-course-core`（本地路径），
 * 而对外分发实际用的是 `add github:owner/repo#path:pkg`。
 * 两处都错了很久，**没有任何东西会红** —— 文档不像代码，写错了不会报错，
 * 只会让人按错的步骤做，然后卡在一个看起来像"插件坏了"的地方。
 *
 * ── 判据分三类 ──────────────────────────────────────────────────────────
 *   ① 事实类：文档说的包数/命令形态，与仓库里的真实结构一致
 *   ② 顺序类：**先装插件、再连课程仓**（老师特意指出的那一条）
 *   ③ 承诺类：文档里承诺的机制真的存在（向导动作、进度、workarea 文件…）
 *
 * ⚠️ 判据要**能证伪**：不写"文档里提到了安装"（永远为真），
 *    而写"学生那段里出现的 add 命令恰好两条、且都指向 core 与 student"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLISH_DIR = path.dirname(HERE)
const WORKSPACE = path.dirname(PUBLISH_DIR)
const DIST = path.join(PUBLISH_DIR, 'plugin-dist')

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const README = path.join(DIST, 'README.md')
const STUDENT_DOC = path.join(DIST, 'docs', '学生端接入.md')
const COLD = path.join(DIST, 'docs', '教师机冷启动清单.md')

const repo = read(README)
const stu = read(STUDENT_DOC)
const cold = read(COLD)

console.log('插件仓文档：')
console.log('  ' + README + (repo ? '' : '（缺）'))
console.log('  ' + STUDENT_DOC + (stu ? '' : '（缺）'))
console.log('  ' + COLD + (cold ? '' : '（缺）'))

// ── ① 事实类：三个包确实在仓库里（文档的包名要与真实目录一致）────────────
console.log('\n=== ① 文档说的包名，仓库里真有 ===')
{
  const pkgs = ['dsh-course-core', 'dsh-course-student', 'dsh-course-teacher']
  const real = pkgs.filter((p) => fs.existsSync(path.join(DIST, p, 'package.json')))
  check('三个包的目录都在', real.length === 3, real.join(', '))
  for (const p of pkgs) {
    check('  README 里出现了包名 ' + p, repo.indexOf(p) >= 0)
  }
  // 反向：文档里不该出现**不存在的**包名（复制粘贴另一个项目时最容易发生）。
  // ⚠️ 白名单要连**仓库名**一起放进来：`dsh-course-plugin` 是仓名、不是包名，
  //    而安装命令里必然出现它（`github:fadedfakers/dsh-course-plugin#path:...`）。
  //    第一版没放，于是这条断言对着**正确**的 README 报红 —— 又是探针太粗。
  const known = new Set([...pkgs, 'dsh-course-plugin'])
  const mentioned = new Set((repo.match(/dsh-course-[a-z]+/g) || []))
  const bogus = [...mentioned].filter((m) => !known.has(m))
  check('  README 里没有不存在的包名/仓名', bogus.length === 0, bogus.join(', ') || '')
}

// ── ② 事实类：`#path:` 这种对外分发形态必须写出来 ────────────────────────
console.log('\n=== ② 安装命令是「能直接跑」的那一种 ===')
{
  // 对外分发实际用的是 github:owner/repo#path:pkg —— 文档必须给这个，
  // 而不是本机开发用的 `add ./dsh-course-core`（新机器上没有那个目录）
  check('README 给了 github:…#path: 形态的安装命令',
    /dsh plugin --profile web add github:[\w.-]+\/[\w.-]+#path:dsh-course-core/.test(repo))
  check('  学生端那条指向 dsh-course-student',
    /dsh plugin --profile web add github:[\w.-]+\/[\w.-]+#path:dsh-course-student/.test(repo))
  check('  教师端那条指向 dsh-course-teacher',
    /dsh plugin --profile web add github:[\w.-]+\/[\w.-]+#path:dsh-course-teacher/.test(repo))
  check('  本地路径那种装法也留着（开发时要改代码）',
    /add \.\/dsh-course-core/.test(repo))
  // 仓库名要与真实远端一致（写错了命令直接 404）
  const slug = (/add github:([\w.-]+\/[\w.-]+)#path:/.exec(repo) || [])[1] || ''
  check('  仓库 slug 看起来是对的（owner/repo）', /^[\w.-]+\/dsh-course-plugin$/.test(slug), slug)
}

// ── ③ 顺序类：**先装插件、再连课程仓**（老师特意指出的一条）───────────────
console.log('\n=== ③ 两件事必须分开写，而且顺序固定 ===')
{
  const iInstall = repo.indexOf('## 二、安装插件')
  const iConnect = repo.indexOf('## 三、把课程仓连上')
  check('README 有「安装插件」与「连课程仓」两节', iInstall > 0 && iConnect > 0,
    'install@' + iInstall + ' connect@' + iConnect)
  check('【核心】「装插件」在「连课程仓」**之前**', iInstall > 0 && iConnect > iInstall)
  check('  明说了这两件事是分开的（不是一节里带过）',
    /装插件.*≠.*拿课程内容|装插件\*\* ≠ \*\*拿课程内容/.test(repo) || /两件事/.test(repo.slice(iInstall - 900, iInstall)))
  check('  连课程仓那一节说清了是**面板第一次打开时**问你',
    /第一次打开/.test(repo.slice(iConnect, iConnect + 400)))
  check('  学生文档里也写了同样的顺序（两份文档不能说两套话）',
    /先装插件，再连课程仓/.test(stu))
}

// ── ④ 事实类：**学生端只装两个包**（老师点名要声明的）────────────────────
console.log('\n=== ④ 学生机只装两个包（老师点名要声明的）===')
{
  const wrong = /三个包都要装|三个包必须一起装|需要 DSH（DeepSeek Harness）。三个包/
  check('【核心】README 里不再有「三个包都要装」这种说法', !wrong.test(repo),
    (wrong.exec(repo) || [''])[0])
  check('  明确说了学生机装两个包（内核 + 学生端）',
    /学生机[^\n]{0,40}内核 \+ 学生端/.test(repo) || /学生机：dsh-course-core \+ dsh-course-student/.test(repo))
  check('  明确说了学生**不要**装教师端', /学生[\s\S]{0,120}不要装|学生装它没有任何用途/.test(repo))
  check('  说明了两包必须一起装（只装一端会 exit=0 但起不来）',
    /exit=0/.test(repo) && /两个包必须一起装/.test(repo), '')
  check('  学生文档里也写了两条 add 命令（不是一句占位符）',
    (stu.match(/dsh plugin --profile web add/g) || []).length === 2,
    (stu.match(/dsh plugin --profile web add/g) || []).length + ' 条')
  check('  学生文档里没有把 `<面板插件地址>` 这种占位符留着（占位符等于没给）',
    !/add <面板插件地址>/.test(stu))
}

// ── ⑤ 承诺类：文档承诺的机制真的存在 ─────────────────────────────────────
console.log('\n=== ⑤ 文档承诺的机制在代码里真的存在 ===')
{
  const coreHost = read(path.join(WORKSPACE, '课程中心', 'course-plugin', 'dsh-course-core', 'src', 'host.js'))
  const coreSetup = read(path.join(WORKSPACE, '课程中心', 'course-plugin', 'dsh-course-core', 'src', 'setup.js'))
  check('文档说「面板第一次打开会问你」→ 内核真有 setup.info / setup.use',
    /'setup\.info'/.test(coreHost) && /'setup\.use'/.test(coreHost))
  check('文档说「会 clone 到 ~/DSH-<课程码>」→ 默认落点真是这个规则',
    /DSH-/.test(coreSetup) && /defaultTargetDir/.test(coreSetup))
  check('文档说「clone 时显示进度条」→ 内核真有 setup.progress',
    /'setup\.progress'/.test(coreHost))
  check('文档说「写 ~/.dsh/cip-workspace.txt」→ 内核真写这个文件路径',
    /cip-workspace\.txt/.test(coreHost))
  check('文档说「校验 课程结构索引.json」→ 判据真是它',
    /课程结构索引\.json/.test(coreHost))
  // 反向：文档不该承诺一件**不存在**的事
  check('文档没有承诺「自动帮你 commit / push」',
    !/自动.{0,6}(commit|push|提交)/.test(repo))
}

// ── ⑥ 索引一致：课程仓那边的学生文档与插件仓这份要同步 ────────────────────
console.log('\n=== ⑥ 课堂用的那份学生文档要跟着一起对 ===')
{
  // 公开仓发给学生的只有 docs/学生端接入.md（course-repo.mjs 的发布清单），
  // 所以它的副本必须跟着更新 —— 否则学生看到的是旧说法（两套话）
  const pubDoc = path.join(PUBLISH_DIR, 'public', 'docs', '学生端接入.md')
  if (!fs.existsSync(pubDoc)) {
    console.log('  · 公开仓还没发布过这份文档（跑 course-repo.mjs publish 后才会同步）')
  } else {
    const a = read(STUDENT_DOC)
    const b = read(pubDoc)
    check('公开仓里的那份与插件仓的一致（发布后才同步）', a === b,
      a === b ? '' : '不一致 —— 跑一次 node course-repo.mjs publish')
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail === 0 ? 0 : 1
setTimeout(() => process.exit(process.exitCode), 2000).unref()
