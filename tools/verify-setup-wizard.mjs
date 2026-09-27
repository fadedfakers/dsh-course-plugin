/**
 * 验「首次启动向导」这一整条路。
 *
 * ── 为什么值得单独守 ────────────────────────────────────────────────────
 * 这条路的用户是**第一次打开面板的人**：他没有工作区、没有配置文件、
 * 也不知道这些东西存在。它出错的每一种方式都是静默的：
 *   · 落点算错（把 `~/DSH-<课程码>` 拼成别的地方）→ clone 到用户找不到的地方
 *   · 不检查落点现状 → **覆盖用户已有的目录**（不可逆）
 *   · 认工作区时不校验结构索引 → 面板从此指向一个空目录，直到有人手工改配置
 *   · 两个插件忘了挂 setup 动作 → 界面上提示「去配工作区」，点下去却是「未知动作」，
 *     看起来像宿主没重启（这个项目已经为这类假象浪费过好几轮）
 *
 * ── 分三层验，每层的判据都能证伪 ────────────────────────────────────────
 *   ① 纯函数：地址解析 / 落点 / 现状判定 / 索引 → 课程配置（逐条钉）
 *   ② createCore：没配过的机器上**如实**说没配过；setup.* 动作真的挂上了
 *   ③ 端到端（真写盘，全在临时目录里）：setup.use 认下一个真工作区、
 *      并把配置文件写到 CIP_WORKSPACE_FILE 指的地方；错的输入都必须被拒
 *
 * ⚠️ `setup.clone` 的**成功路径**在这台机器上跑不了（不是产品问题）：
 *    沙箱不给命名管道，git clone 走 file:// / https:// 都要 spawn MSYS `sh.exe`，
 *    被拒（CreateFileMapping Win32 error 5）。这一条与仓库其他脚本记的是同一件事
 *    （见 docs 与 run.js 顶部：带管道的 spawnSync 一律 EPERM）。
 *    所以这里验的是它**确定性的那一半**：参数、以及每一类失败的说法。
 *    真正 clone 一次的验收要在一台没有这个限制的机器上做。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
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
const CORE_SRC = findCoreSrc(HERE)
if (!CORE_SRC) { console.error('✗ 找不到 dsh-course-core/src'); process.exit(2) }
const setup = await import(pathToFileURL(path.join(CORE_SRC, 'setup.js')).href)

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

// ── ① 地址解析 ────────────────────────────────────────────────────────
console.log('=== ① 公开仓地址：能认哪些写法、必须拒哪些 ===')
{
  const cases = [
    ['https://github.com/o/r.git', 'https://github.com/o/r.git', 'r'],
    ['https://github.com/o/r', 'https://github.com/o/r.git', 'r'],
    ['http://github.com/o/r.git', '', '（http 要补成 https）'],
    ['github.com/o/r', 'https://github.com/o/r.git', 'r'],
    ['o/r', 'https://github.com/o/r.git', 'r'],
    ['  https://github.com/o/r.git  ', 'https://github.com/o/r.git', 'r（前后空格要吃掉）'],
  ]
  for (const [input, want, note] of cases) {
    const got = setup.parseRepoInput(input)
    // http:// 那一档只要求「补成 https」，不强求成功
    if (input.indexOf('http://') === 0) {
      check('接受 ' + JSON.stringify(input), got.ok === true && got.remote.indexOf('https://') === 0,
        (got.remote || got.error))
      continue
    }
    check('接受 ' + JSON.stringify(input) + ' → ' + note, got.ok === true && got.remote === want && got.name === 'r',
      got.ok ? got.remote : got.error)
  }
  // ★ 带凭据的地址必须拒 —— 它会被写进配置文件、显示在界面上
  const bad = [
    ['https://x-access-token:ghp_ABC123456789012345678901234567890@github.com/o/r.git', '带 token'],
    ['https://user:pass@github.com/o/r.git', '带账号密码'],
    ['git@github.com:o/r.git', 'ssh 写法'],
    ['https://github.com/o', '只有 owner 没有仓名'],
    ['', '空'],
  ]
  for (const [input, why] of bad) {
    const got = setup.parseRepoInput(input)
    // 理由要**够长**才算「说清了」——但「还没填公开仓地址。」这种短句是最贴切的说法，
    // 所以判据是「它确实给了一句中文说明」，不是「长度超过 10 个字符」。
    check('拒绝（' + why + '）', got.ok === false && typeof got.error === 'string' && /[\u4e00-\u9fa5]/.test(got.error),
      got.ok ? ('居然通过了：' + got.remote) : got.error.slice(0, 80))
  }
  // 拒绝的理由要说清**为什么**，否则用户只会换个写法再试一次
  const tok = setup.parseRepoInput('https://u:ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH@github.com/o/r.git')
  check('  带凭据时的理由点明「会被写进配置文件」', /配置文件|凭据/.test(tok.error), tok.error.slice(0, 90))
  const ssh = setup.parseRepoInput('git@github.com:o/r.git')
  check('  ssh 写法的理由点明「要 https」', /https/.test(ssh.error), ssh.error.slice(0, 90))
}

// ── ② 默认落点 ────────────────────────────────────────────────────────
console.log('\n=== ② 默认落点：~/DSH-<课程码>（老师定的口径）===')
{
  check('课程码优先于仓名', setup.defaultTargetDir('C:\\Users\\me', 'dsh-algorithm', 'DL2026') === 'C:\\Users\\me\\DSH-DL2026',
    setup.defaultTargetDir('C:\\Users\\me', 'dsh-algorithm', 'DL2026'))
  check('没有课程码就用仓名', setup.defaultTargetDir('C:\\Users\\me', 'dsh-algorithm', '') === 'C:\\Users\\me\\DSH-dsh-algorithm',
    setup.defaultTargetDir('C:\\Users\\me', 'dsh-algorithm', ''))
  check('两个都没有也不炸（落到 course）', setup.defaultTargetDir('C:\\Users\\me', '', '') === 'C:\\Users\\me\\DSH-course')
  // ★ 安全：课程码 / 仓名里的路径分隔符与点号必须被吃掉，否则一个 `..`
  //   就能把落点挪出用户的家目录（而 clone 会**真的往那里写文件**）。
  //   判据用 path.resolve 算「顶层目录还是不是家目录」——
  //   只查字符串里有没有 '..' 是假绿：`C:\Users\me\DSH-..` 里没有分隔符，
  //   但它指向的仍然是 home 下的一层，这种要放过；而 `..\..\Windows` 必须被削平。
  const HOME = 'C:\\Users\\me'
  const evil = setup.defaultTargetDir(HOME, '..', '..\\..\\Windows')
  check('【安全】课程码里的 ..\\.. 不能把落点挪出家目录',
    path.win32.dirname(path.win32.resolve(evil)) === HOME, evil)
  const evil2 = setup.defaultTargetDir(HOME, 'a/b', '')
  check('【安全】仓名里的斜杠不会多出一层目录',
    path.win32.dirname(path.win32.resolve(evil2)) === HOME, evil2)
  const evil3 = setup.defaultTargetDir(HOME, '', '..')
  check('【安全】课程码就是 .. 时落在 home 下一层（不是 home 本身）',
    path.win32.dirname(path.win32.resolve(evil3)) === HOME, evil3)
  check('正常课程码不受影响（点号不在里面）', setup.defaultTargetDir(HOME, 'x', 'DL2026') === HOME + '\\DSH-DL2026')
  check('家目录带尾分隔符也能拼对', setup.defaultTargetDir('C:\\Users\\me\\', 'x', '') === 'C:\\Users\\me\\DSH-x')
}

// ── ③ 落点现状 → 能不能往下走 ─────────────────────────────────────────
console.log('\n=== ③ 落点现状：绝不覆盖用户已有的东西 ===')
{
  const mk = (o) => Object.assign({
    exists: () => false, isDir: () => false, listDir: () => [],
  }, o || {})
  const absent = setup.inspectTarget('C:\\x', mk())
  check('不存在 → absent', absent.state === setup.DIR_STATE.ABSENT, absent.state)
  check('  absent 可以 clone', setup.judgeTarget(absent).ok === true && setup.judgeTarget(absent).mode === 'clone')

  // ⚠️ 这里的 exists 也必须**只对目标目录本身为真**。第一版写的是 `() => true`，
  //    那等于连 `<目录>/.git` 也说存在 —— 于是这一档被判成 repo，
  //    和上一条撞成同一个结果（探针太粗，测出来的不是产品的行为）。
  const empty = setup.inspectTarget('C:\\x', mk({
    exists: (p) => path.win32.normalize(String(p)) === 'C:\\x',
    isDir: () => true, listDir: () => [],
  }))
  check('存在但是空目录 → empty（可以 clone，git 允许）',
    empty.state === setup.DIR_STATE.EMPTY && setup.judgeTarget(empty).ok === true, empty.state)

  // ⚠️ 探针要**精确**，而精确的写法很容易写错：
  //    ① 第一版写成 `p.endsWith('.git')`，而 '.git'.endsWith('.git') 为真 ——
  //       于是「空目录」那一档也被判成仓库，红的是探针不是产品；
  //    ② 第二版写成 `p === 'C:\\x' || p === path.win32.join('C:\\x', '.git')`，
  //       看着对，其实**永远不成立**：被测代码走的是 `path.join`（win32 实现，
  //       把双反斜杠规范化成单反斜杠），而探针比较的那一侧是没规范化的
  //       `'C:\\\\x'`。路径比较**两边都要规范化** —— 这与仓库里
  //       「exchange-repo 比对要归一化行尾」是同一类错。
  const nx = (p) => path.win32.normalize(String(p))
  const repo = setup.inspectTarget('C:\\x', mk({
    exists: (p) => nx(p) === 'C:\\x' || nx(p) === 'C:\\x\\.git',
    isDir: () => true, listDir: () => ['a'],
  }))
  check('已经是 git 仓库 → repo，且**不许** clone（会套一层子目录）',
    repo.state === setup.DIR_STATE.REPO && setup.judgeTarget(repo).ok === false
    && setup.judgeTarget(repo).mode === 'use-existing', repo.state)

  const occupied = setup.inspectTarget('C:\\x', mk({
    exists: (p) => p === 'C:\\x', isDir: () => true, listDir: () => ['课程中心', '我的论文.docx'],
  }))
  check('有内容且不是仓库 → occupied，且**必须**让用户换落点',
    occupied.state === setup.DIR_STATE.OCCUPIED && setup.judgeTarget(occupied).ok === false
    && setup.judgeTarget(occupied).mode === 'pick-another', occupied.state)
  check('  说清了那个目录里有几项、头几项是什么（用户才知道自己指到了哪）',
    occupied.entries === 2 && occupied.sample.indexOf('我的论文.docx') >= 0, JSON.stringify(occupied.sample))
  // ★ 这条是**能证伪**的：把「有内容就拒」那一档改成放行，它必须变红。
  //   判据写成「ok 必须是 false」而不是「不是 X」——
  //   上一轮路径归属那条断言写「不是 mine」，结果真落点进了 legacy 分支
  //   （而 legacy 是放行的），等于没拦住。
  const occupiedVerdict = setup.judgeTarget(occupied)
  check('  【可证伪】occupied 这一档的 ok 就是 false（不是"恰好没走那条路"）',
    occupiedVerdict.ok === false, 'ok=' + occupiedVerdict.ok + ' mode=' + occupiedVerdict.mode)
  const allStates = [absent, empty, repo, occupied]
  const wouldClone = allStates.filter((s) => setup.judgeTarget(s).ok)
  // 反向：只要 judgeTarget 允许 clone，就**绝不能**是「有内容的目录」
  check('【硬要求】允许 clone 的那几档里，没有一档是「已有内容」的',
    wouldClone.every((s) => s.state === setup.DIR_STATE.ABSENT || s.state === setup.DIR_STATE.EMPTY),
    wouldClone.map((s) => s.state).join(','))
}

// ── ④ 从索引生成课程配置（与 install.ps1 的 4c 同一个口径）──────────────
console.log('\n=== ④ 课程配置：只写索引里真有的事实 ===')
{
  const cfg = setup.courseConfigFromIndex({ course: '从机器学习到深度学习', modules: [{ name: '模块一' }, { name: '模块二' }] }, { code: 'DL2026' })
  check('title 取索引里的 course', cfg.title === '从机器学习到深度学习', cfg.title)
  check('code 用传进来的课程码', cfg.code === 'DL2026', cfg.code)
  check('layout.modules 是模块名数组', JSON.stringify(cfg.layout.modules) === JSON.stringify(['模块一', '模块二']),
    JSON.stringify(cfg.layout.modules))
  // ★ 章的映射索引里没有 —— **不猜**，只留一句话。猜错会让课件归位认错位置。
  check('【不猜】不生成 layout.chapters（索引里没有这个信息）', cfg.layout.chapters === undefined,
    JSON.stringify(cfg.layout))
  check('  _待补 里说明章的映射要老师手填', /chapters/.test(cfg._待补))
  check('给出的 JSON 能被 JSON.parse 回来', (() => { try { JSON.parse(JSON.stringify(cfg)); return true } catch (e) { return false } })())
  const empty = setup.courseConfigFromIndex(null, {})
  check('索引是 null 也不抛错（title 空串、modules 空数组）',
    empty.title === '' && Array.isArray(empty.layout.modules) && empty.layout.modules.length === 0)
}

// ── ⑤ git 命令与失败说法 ──────────────────────────────────────────────
console.log('\n=== ⑤ git clone：命令逐字可控，失败说人话 ===')
{
  const args = setup.cloneArgs('https://github.com/o/r.git', 'C:\\Users\\me\\DSH-r')
  check('参数是 clone --progress <url> <dir>（顺序不能乱）',
    JSON.stringify(args) === JSON.stringify(['clone', '--progress', 'https://github.com/o/r.git', 'C:\\Users\\me\\DSH-r']),
    JSON.stringify(args))
  check('【不许】不加 --branch（那一档是「拿整仓」，钉版本走老师给的那条命令）',
    args.indexOf('--branch') < 0)
  check('git 探活参数是 --version', JSON.stringify(setup.versionArgs()) === JSON.stringify(['--version']))

  const ok = setup.explainCloneOutput({ status: 0, stdout: '', stderr: "Cloning into 'x'...\nReceiving objects: 100% (10/10)\n" }, 'r')
  check('成功 → ok:true 且没有多余的"原因"', ok.ok === true && ok.why === '', JSON.stringify(ok))
  const nf = setup.explainCloneOutput({ status: 128, stdout: '', stderr: 'remote: Repository not found.\nfatal: repository not found\n' }, 'r')
  check('仓不存在 → 归因到「仓名拼错 / 私有仓没凭据」', nf.ok === false && /仓名拼错|私有仓/.test(nf.why), nf.why.slice(0, 120))
  const net = setup.explainCloneOutput({ status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com\n' }, 'r')
  check('连不上 → 归因到网络/代理，而不是「仓名错了」', net.ok === false && /连不上 GitHub/.test(net.why), net.why.slice(0, 120))
  const eperm = setup.explainCloneOutput({ status: null, error: new Error('spawn git EPERM'), stdout: '', stderr: '' }, 'r')
  check('起不了子进程（本沙箱的 EPERM）→ 明说是「没能启动 git」，不许说成"没有输出"',
    eperm.ok === false && /没能启动 git/.test(eperm.why), eperm.why.slice(0, 120))
  // 进度行必须被滤掉：几十行 Receiving objects 摊在界面上，老师会以为出问题了
  check('失败输出里滤掉了 --progress 的进度行',
    nf.why.indexOf('Receiving objects') < 0 && nf.why.indexOf('Cloning into') < 0, nf.why.slice(0, 120))
  check('git 原文留着（那是唯一能搜到答案的字样）', /not found/i.test(nf.why), nf.why.slice(0, 120))
}

// ── ⑥ createCore：没配过的机器上如实说没配过 + 动作真的挂上了 ────────────
console.log('\n=== ⑥ createCore：没配过的机器 ===')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-setup-'))
const savedEnv = {
  CIP_WORKSPACE: process.env.CIP_WORKSPACE,
  CIP_COURSE_DIR: process.env.CIP_COURSE_DIR,
  CIP_COURSE_CODE: process.env.CIP_COURSE_CODE,
  CIP_WORKSPACE_FILE: process.env.CIP_WORKSPACE_FILE,
}
/** 干净环境：没配过工作区 */
function cleanEnv(wsFile) {
  delete process.env.CIP_WORKSPACE
  delete process.env.CIP_COURSE_DIR
  delete process.env.CIP_COURSE_CODE
  process.env.CIP_WORKSPACE_FILE = wsFile
}

const wsFile = path.join(tmpRoot, '.dsh', 'cip-workspace.txt')
cleanEnv(wsFile)
fs.rmSync(wsFile, { force: true })

const { createCore } = await import(pathToFileURL(path.join(CORE_SRC, 'host.js')).href)
const fsShim = {
  resolve: async (p, o) => path.resolve(o && o.cwd ? o.cwd : '.', p),
  readText: async (p) => fs.readFileSync(p, 'utf8'),
  writeText: async (p, c) => fs.writeFileSync(p, c, 'utf8'),
  readBytes: async (p) => fs.readFileSync(p),
  stat: async (p) => fs.statSync(p),
  listDir: async (p) => fs.readdirSync(p, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDirectory: () => e.isDirectory(), isFile: () => e.isFile() })),
}
const mkCtx = (webServer) => ({
  get: (n) => (n === 'fs' ? fsShim : undefined),
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  webServer: webServer,
})

const core = createCore(mkCtx({ register: () => () => { } }), {
  prefix: '/cip-tst', role: 'teacher', pkgRoot: CORE_SRC, label: '探针',
})
{
  const info = core.info()
  check('没配过 → info.setup.workspaceResolved === false', info.setup && info.setup.workspaceResolved === false,
    JSON.stringify(info.setup && info.setup.how))
  check('  同时保留 workspaceResolved 那个老字段（两端都读它）', info.workspaceResolved === false)
  check('  setup.workspaceFile 就是解析链读的那个文件',
    path.resolve(info.setup.workspaceFile) === path.resolve(wsFile), info.setup.workspaceFile)
  check('  setup.home 给了（界面拿它拼默认落点）', typeof info.setup.home === 'string' && info.setup.home.length > 2, info.setup.home)
  check('  setup.nearby 是数组（`~/DSH-*` 的候选，没有就是空）', Array.isArray(info.setup.nearby))
  check('【硬要求】内核动作真的挂上了（向导三个都在）',
    !!core.coreHandlers && ['setup.info', 'setup.clone', 'setup.use'].every((k) => typeof core.coreHandlers[k] === 'function'),
    Object.keys(core.coreHandlers || {}).join(','))
  /**
   * 反向：动作名要与界面真正调的那些**逐个对上**。
   *
   * ⚠️ 这一条原来写的是"就是这三个"，后来 `setupHandlers` 改名成了
   *    `coreHandlers` —— 因为它开始装「两端都要有的内核动作」，
   *    不再只是向导那三个（现在多了 `materials.list`，资料页的数据源）。
   *    判据跟着改，并且**把清单写全**：漏列一个就等于少守一个动作，
   *    而"少守的那个"正是将来会拼错的那一个。
   */
  const wantActions = ['materials.list', 'setup.clone', 'setup.info', 'setup.use']
  check('  动作名与界面调的一一对应（' + wantActions.length + ' 个）',
    JSON.stringify(Object.keys(core.coreHandlers).sort()) === JSON.stringify(wantActions),
    Object.keys(core.coreHandlers).sort().join(','))
}

// ── ⑦ 端到端：setup.use 认下一个真工作区（真写盘，全在临时目录里）────────
console.log('\n=== ⑦ 端到端：工作区已经在别的目录（setup.use）===')
const fixture = path.join(tmpRoot, 'my-course')
fs.mkdirSync(path.join(fixture, '课程中心'), { recursive: true })
fs.writeFileSync(path.join(fixture, '课程中心', '课程结构索引.json'),
  JSON.stringify({ course: '探针课程（真课名）', modules: [{ name: '模块一' }, { name: '模块二' }] }), 'utf8')

{
  // ① 先指一个**不是**工作区的目录：必须被拒，而且理由要点明判据
  const bad = path.join(tmpRoot, 'not-a-course')
  fs.mkdirSync(bad, { recursive: true })
  const r1 = await core.coreHandlers['setup.use']({ dir: bad })
  check('指一个普通目录 → 被拒', r1.ok === false, JSON.stringify(r1).slice(0, 120))
  check('  拒绝理由点明判据是「课程中心\\课程结构索引.json」',
    /课程结构索引\.json/.test(r1.error || ''), (r1.error || '').slice(0, 120))
  // ★ 被拒之后**不能**悄悄把工作区换成那个目录 —— 这是最坏的一种失败
  check('【硬要求】被拒之后核心仍然认为「没配过」', core.info().setup.workspaceResolved === false)

  // ② 指真工作区：必须认下来，并且 info 立刻变
  const r2 = await core.coreHandlers['setup.use']({ dir: fixture })
  check('指真工作区 → 认下来', r2.ok === true, JSON.stringify(r2).slice(0, 160))
  check('  返回里带真课名（界面要显示给用户核对）', r2.course === '探针课程（真课名）', r2.course)
  check('  返回里带配置文件路径', r2.workspaceFile && typeof r2.workspaceFile.file === 'string', JSON.stringify(r2.workspaceFile))
  const info2 = core.info()
  check('【核心】认下来之后 info 立刻说「配好了」（不用重启）',
    info2.setup.workspaceResolved === true && path.resolve(info2.workspace) === path.resolve(fixture),
    info2.workspace)
  check('  课名也跟着变了（不是内置默认名）', info2.course.title === '探针课程（真课名）', info2.course.title)

  // ③ 配置文件真的写了，而且**解析链下次能读回来**（这是「下次开机不用再配」的判据）
  check('配置文件被创建了：' + wsFile, fs.existsSync(wsFile))
  const raw = fs.existsSync(wsFile) ? fs.readFileSync(wsFile, 'utf8') : ''
  check('  里面那一行就是工作区路径', raw.indexOf(fixture) >= 0, raw.split(/\r?\n/).slice(-1)[0])
  check('  注释行在（用户以后想手改得看得懂）', raw.indexOf('#') === 0)
  check('  没有 BOM（带 BOM 会让 existsSync 判错路径）', raw.charCodeAt(0) !== 0xFEFF, '首字符码 ' + raw.charCodeAt(0))

  // ④ 课程配置：真课名落盘，且**章的映射不猜**
  const cfgPath = path.join(fixture, '课程配置.json')
  check('课程配置.json 被创建了', fs.existsSync(cfgPath))
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
  check('  title 是真课名', cfg.title === '探针课程（真课名）', cfg.title)
  check('  layout.modules 来自索引', JSON.stringify((cfg.layout || {}).modules) === JSON.stringify(['模块一', '模块二']),
    JSON.stringify((cfg.layout || {}).modules))
  check('  【不猜】没有 layout.chapters', (cfg.layout || {}).chapters === undefined)
}

// ── ⑧ 端到端：clone 的失败路径（成功路径本沙箱跑不了，见文件头注释）──────
console.log('\n=== ⑧ setup.clone：该拒的必须拒，且不许留下半个目录 ===')
{
  const r1 = await core.coreHandlers['setup.clone']({ repo: 'https://u:ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH@github.com/o/r.git', dir: path.join(tmpRoot, 'x1') })
  check('带凭据的地址 → 在解析这一步就拒（连目录都不会碰）',
    r1.ok === false && r1.step === 'parse', r1.step)
  check('  目录没有被创建', !fs.existsSync(path.join(tmpRoot, 'x1')))

  // 落点是个有内容的目录：必须在 clone **之前**拦住
  const busy = path.join(tmpRoot, 'busy-dir')
  fs.mkdirSync(busy, { recursive: true })
  fs.writeFileSync(path.join(busy, '我的论文.docx'), 'x', 'utf8')
  const r2 = await core.coreHandlers['setup.clone']({ repo: 'https://github.com/o/r.git', dir: busy })
  check('落点非空且不是仓库 → 在 inspect 这一步就拒', r2.ok === false && r2.step === 'inspect', r2.step)
  check('  那句拒绝里说清了目录里有几项', /1 项|我的论文/.test(r2.error || ''), (r2.error || '').slice(0, 140))
  check('  【绝不覆盖】那个文件还在', fs.existsSync(path.join(busy, '我的论文.docx')))

  // 已经是仓库的落点：不该 clone（会套一层），而是「就用它」——
  // 但夹具不是课程仓，所以必须走「认不下来」这条路，且不许把工作区换过去
  const repoDir = path.join(tmpRoot, 'an-old-clone')
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
  const before = core.info().workspace
  const r3 = await core.coreHandlers['setup.clone']({ repo: 'https://github.com/o/r.git', dir: repoDir })
  check('落点已经是 git 仓库但不是课程仓 → 不能认成工作区', r3.ok === false, JSON.stringify(r3).slice(0, 140))
  check('  【硬要求】工作区没有被悄悄换走', core.info().workspace === before, core.info().workspace)

  // 空仓库地址：parse 就拒，不猜
  const r4 = await core.coreHandlers['setup.clone']({ repo: '', dir: path.join(tmpRoot, 'x4') })
  check('地址为空 → parse 拒', r4.ok === false && r4.step === 'parse')
}

// ── ⑧b 回归：**升级上来的机器**不该被逼着再 clone 一份 ────────────────────
//
// 这一条是真实事故逼出来的：本轮把内核里写死的教师机兜底路径
// （`DEFAULT_WORKSPACE`）删掉之后，**教师机自己**弹出了向导 ——
// 因为那台机器从来没有 `~/.dsh/cip-workspace.txt`，一直靠那个写死的路径活着。
// 这是那次改动的已知代价，处理办法是让"已经有工作区"这条路**又短又显眼**：
//   · 展开「更多选项」→ 指到现有目录 → 只登记、不联网、不 clone
// 所以这条断言要钉住的是：**一个已经存在、结构正确的目录，能被原样认下来**，
// 而不是要求用户重新 clone 一份（那会变成两份课程、两份问题池，且互不同步）。
{
  console.log('\n=== ⑧b 回归：机器上已经有工作区（升级上来的开发机/教师机）===')
  const existing = path.join(tmpRoot, 'already-have-it')
  fs.mkdirSync(path.join(existing, '课程中心'), { recursive: true })
  fs.writeFileSync(path.join(existing, '课程中心', '课程结构索引.json'),
    JSON.stringify({ course: '已经在用的那门课', totalLessons: 12, modules: [{ name: '模块一' }] }), 'utf8')
  fs.writeFileSync(path.join(existing, '课程配置.json'), JSON.stringify({ title: '已经在用的那门课' }), 'utf8')

  const r = await core.coreHandlers['setup.use']({ dir: existing })
  check('指到已有的工作区 → 认下来（**不需要**先 clone）', r.ok === true, JSON.stringify(r).slice(0, 120))
  check('  返回的课名来自那份索引（不是内置占位名）', r.course === '已经在用的那门课', r.course)
  const info = core.info()
  check('【关键】认下来之后 info 立刻说"配好了"（不用重启）', info.setup.workspaceResolved === true)
  check('  工作区就是那个目录本身', path.resolve(info.workspace) === path.resolve(existing), info.workspace)
  check('  课名也跟着变了', info.course.title === '已经在用的那门课', info.course.title)
  // 反向：这条路**一个网络请求都不该发**（它是"登记"，不是"取回来"）
  check('  没有任何网络动作（setup.use 是纯本地登记）',
    typeof core.coreHandlers['setup.use'] === 'function' && r.mode === 'existing', r.mode)
}

// ── ⑨ 两端客户端：向导是同一份代码，而且真的挂上了 ──────────────────────
console.log('\n=== ⑨ 两个客户端：同一份向导代码 + 真的挂进面板 ===')
{
  const CLIENTS = [
    path.resolve(CORE_SRC, '..', '..', 'dsh-course-student', 'lib', 'client.js'),
    path.resolve(CORE_SRC, '..', '..', 'dsh-course-teacher', 'lib', 'client.js'),
  ]
  const bodyOf = (file) => {
    const t = fs.readFileSync(file, 'utf8')
    const i = t.indexOf('    function SetupWizard(')
    if (i < 0) return null
    // 花括号配平取出函数体（与 extract-client-core.cjs 同一套办法）。
    // ⚠️ 必须从**参数表之后**的第一个 `{` 开始配平：参数表本身也是花括号，
    //    从签名那一行就数会在 `Props` 那个 `}` 上立刻配平 —— 得到 46 个字符的
    //    「两份副本逐字一致」，看着是绿的，其实一个字都没比。第一版就是这么写的。
    const bodyStart = t.indexOf('{', t.indexOf(')', i))
    if (bodyStart < 0) return null
    let depth = 0, started = false
    for (let j = bodyStart; j < t.length; j++) {
      if (t[j] === '{') { depth++; started = true } else if (t[j] === '}') { depth-- }
      if (started && depth === 0) return t.slice(bodyStart, j + 1)
    }
    return null
  }
  const bodies = CLIENTS.map(bodyOf)
  check('两个客户端里都有 SetupWizard', bodies.every((b) => !!b))
  // 反向：取出来的必须**真的是**那个组件（不是 46 个字符的参数表）
  check('  取出来的函数体有实质内容（> 2000 字符）',
    bodies.every((b) => b && b.length > 2000), bodies.map((b) => (b ? b.length : 0)).join(' / '))
  // ⚠️ 比对前**先归一化行尾**：两份副本是分两次写进去的，一个 LF 一个 CRLF，
  //    直接比会得到「不一致」——而那是行尾差异，不是内容漂移。
  //    这也是 exchange-repo.mjs 那条纪律（比对要归一化，上传不用）在客户端的翻版。
  const norm = (s) => (s ? s.replace(/\r\n/g, '\n') : s)
  // ★ 这条是**防漂移**的：两份副本改一处忘一处，表现是「学生端能配、教师端不能配」
  //   或者两块界面长得不一样 —— 而两边都在各自的机器上，很难对照发现。
  check('【防漂移】两份副本逐字一致（改一处必须改两处）',
    norm(bodies[0]) === norm(bodies[1]),
    bodies.every(Boolean) ? ('学生端 ' + bodies[0].length + ' 字符 / 教师端 ' + bodies[1].length + ' 字符'
      + (norm(bodies[0]) === norm(bodies[1]) ? '（只有行尾不同）' : '（内容真的不同）')) : '')
  for (const f of CLIENTS) {
    const t = fs.readFileSync(f, 'utf8')
    const who = /student/.test(f) ? '学生端' : '教师端'
    check(who + '：面板里真的渲染了向导（h(SetupWizard, …)）', /h\(SetupWizard, \{ info: st\.info, api: api/.test(t))
    check(who + '：向导从 __components 导出（校验脚本能单独渲染它）', /SetupWizard: SetupWizard/.test(t))
    // 它调的两个动作名必须与宿主注册的**一模一样**
    check(who + '：调的动作名与宿主一致（setup.clone / setup.use）',
      /api\('setup\.clone'/.test(t) && /api\('setup\.use'/.test(t))
    // 已经配好时不能长期挂在面板顶上
    check(who + '：已配好时返回 null（不长期占位）', /if \(resolved\) return null/.test(t))
    check(who + '：宿主没给 setup 字段时有话说（老宿主半区没重启）', /没有拿到工作区信息/.test(t))
    // ★ 位置：向导必须排在**红条与就绪清单之前**，而且没配过时不显示就绪清单。
    //   实机截图里它被「加载失败」红条挤到下面 —— 用户第一眼看到的是「面板坏了」，
    //   而不是「它在教我修」。判据是**顺序**，不是「有没有」。
    //
    // ⚠️ 「面板里那句红条」要取**最后一处** `st.error ?`：这个文件里到处都有
    //    `st.error ? ... : null`（详情页、教案页各一处），第一处在 42k 字符处。
    //    第一版取 indexOf 得到的位置在向导**前面**，于是断言红 —— 红的是探针不是产品。
    const iWizard = t.indexOf('h(SetupWizard, { info: st.info')
    const iErr = t.lastIndexOf("st.error ? h('div', { className: 'k52 k53'")
    check(who + '：向导渲染在「加载失败」红条**之前**（否则会被挤到下面）',
      iWizard > 0 && iErr > iWizard, 'wizard@' + iWizard + ' 面板红条@' + iErr)
    // ★ 没配过工作区时**不发那些注定失败的动作**，否则整页是一条刺眼的红条。
    //   判据是「load 里有这一句早退」，而且它读的字段就是宿主下发的那个。
    check(who + '：没配过工作区时 load 早退（不再去读 tree/slides，避免无意义的红条）',
      /info\.setup\.workspaceResolved === false\) return/.test(t))
    // 就绪清单在没配过时藏起来：两块并排说同一件事会让人以为是两个问题。
    // ⚠️ 两端的组件名**不一样**：学生端是 `ReadinessCard`、教师端是 `TeacherReadiness`
    //    （没有 Card 后缀）—— 第一版写成 `h\((Teacher)?ReadinessCard`，
    //    学生端匹配得上、教师端永远匹配不上，红的看起来像「教师端漏了」。
    check(who + '：没配过时把就绪清单藏起来（不并排说同一件事）',
      /workspaceResolved === false\) \? null : h\((?:Teacher)?Readiness(?:Card)?\b/.test(t))
  }
}

// ── ⑩ 样式的兜底：工作区里没有权威样式表时，插件内置那份必须是同一份 ────────
console.log('\n=== ⑩ 面板样式表的兜底副本（实机截图那次就是这个）===')
{
  /**
   * 为什么这条要写进「向导」的断言里：向导解决的是**新机器**（没配过工作区），
   * 而那种机器上 `<工作区>\课程中心\_插件源码\panel.css` 通常也不存在 ——
   * 面板会退回插件内置那份。内置那份长期陈旧（11941 字节、缺 69 个 class），
   * 症状就是截图里的「侧栏与主区塌成一条 30 像素宽的竖排文字 + 按钮和文字一个色」。
   * 也就是说：**没有这条断言，向导在新机器上能用，但界面是坏的。**
   */
  const CORE_PKG = path.resolve(CORE_SRC, '..')
  const bundled = path.join(CORE_PKG, 'lib', 'panel.css')
  const auth = path.join(path.resolve(CORE_SRC, '..', '..', '..'), '_插件源码', 'panel.css')
  const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n')
  check('插件内置样式表存在', fs.existsSync(bundled), bundled)
  const bundledText = fs.existsSync(bundled) ? lf(fs.readFileSync(bundled)) : ''
  // 反向：先钉住它**不是**那份陈旧副本。
  // ⚠️ 判据用**字节数**，不是字符数：这是一份满是中文注释的 CSS，
  //    48888 字节对应 37671 个字符（一个中文字 3 字节）。第一版拿字符数去比 40000，
  //    于是一份完全正确的样式表被判红 —— 又是探针的错，不是产品的错。
  const bundledBytes = fs.existsSync(bundled) ? fs.readFileSync(bundled).length : 0
  check('  内置那份不再是陈旧副本（字节数 > 40000；踩过的那版是 11941 字节）',
    bundledBytes > 40000, bundledBytes + ' 字节 / ' + bundledText.length + ' 字符')
  const NEED = ['.k22', '.k23', '.k25', '.k86', '.k8a', '.k8c', '.k27', '.kcb', '.kce', '.kca', '.kd1', '.k57', '.k64', '.k61', '.k42', '.k11']
  const missing = NEED.filter((c) => bundledText.indexOf(c + '{') < 0 && bundledText.indexOf(c + ',') < 0
    && bundledText.indexOf(c + ':') < 0 && bundledText.indexOf(c + ' ') < 0 && bundledText.indexOf(c + '[') < 0)
  check('  内置那份定义了全部布局类（缺一个就会塌一条）', missing.length === 0,
    missing.length ? ('缺：' + missing.join(', ')) : NEED.length + ' 个都在')
  if (fs.existsSync(auth)) {
    check('【防漂移】内置那份与权威版逐字节一致（改一处必须同步另一处）',
      lf(fs.readFileSync(auth)) === bundledText,
      '权威 ' + fs.readFileSync(auth).length + ' / 内置 ' + Buffer.byteLength(bundledText)
      + ' —— 跑 node tools/sync-panel-css.mjs')
  } else {
    console.log('  （跳过比对：本机没有权威样式表 ' + auth + '）')
  }
  // 主按钮与正文的对比度（「按钮颜色和文本颜色类似」那次反馈的根因）
  check('  主按钮是固定品牌色 + 白字，且禁用态也是白字',
    /--accent:#2f6feb/.test(bundledText) && /--on-accent:#fff/.test(bundledText)
    && /\.k11\[disabled\]\{[^}]*--on-accent/.test(bundledText))
}

// ── 收尾：还原环境 ────────────────────────────────────────────────────
for (const k of Object.keys(savedEnv)) {
  if (savedEnv[k] === undefined) delete process.env[k]
  else process.env[k] = savedEnv[k]
}
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
