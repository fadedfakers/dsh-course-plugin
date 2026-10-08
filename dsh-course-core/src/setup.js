/**
 * 首次启动向导：**让一台没配过的机器能自己把课程装起来**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 老师的决定是「通用插件：任意课程 / 任意仓」+「首次启动向导 + 自动 clone」。
 * 在这之前，一台新机器要能跑起来，得先有人手工跑 `templates/install.ps1`
 * （它写 `~/.dsh/cip-workspace.txt`）或者手工设 `CIP_WORKSPACE`。漏掉这一步的
 * 症状是**面板空着、一句话都没有** —— 因为解析链的兜底原来是教师机绝对路径，
 * 在别的机器上必然落空，落空时又不报错。
 *
 * 现在兜底留空了（见 host.js 的 DEFAULT_WORKSPACE），落空会**如实**变成
 * resolved:false，界面据此进这个向导。向导做四件事：
 *   ① 问清「从哪个公开仓 clone」或「工作区已经在哪」
 *   ② clone 到默认落点 `~/DSH-<课程码>`（**用户可改**）
 *   ③ 校验落点真的是课程工作区（判据只有一个：`课程中心/课程结构索引.json`）
 *   ④ 把落点写进配置文件 + 把真课名写进 `课程配置.json`
 *
 * ── 这个文件里只有**纯函数** ────────────────────────────────────────────
 * 真正的动作（起 git、写文件）在 host.js 的 `setup.*` 里，因为它们要用到
 * 「往哪写」「怎么跑子进程」这些运行时知识。这里放的是**判断**：
 * 地址解析、默认落点、目录现状、能不能往下走。理由很实际 ——
 * 「`~/DSH-<课程码>` 到底拼成什么」「目标目录有东西时算哪种情况」
 * 这两件事说错了都不会报错，只会在用户机器上做错事（覆盖别人的目录、
 * clone 到一半失败），所以必须能在构建门里逐条钉。
 */
import path from 'node:path'

/** 目标目录现状的四种情况。**分开命名**是因为四者对用户意味着完全不同的动作。 */
export const DIR_STATE = {
  ABSENT: 'absent',        // 不存在 —— 直接 clone，最顺的一档
  EMPTY: 'empty',          // 存在但是空目录 —— 可以 clone（git 允许 clone 进空目录）
  REPO: 'repo',            // 已经是一个 git 仓库 —— 不 clone，改为问「要不要就在用它」
  OCCUPIED: 'occupied',    // 存在、非空、且不是 git 仓库 —— **绝不覆盖**，必须换落点
}

/**
 * 解析用户填的仓库地址，给出**能直接给 git 用的** https 地址与仓名。
 *
 * 接受的写法（都是实际会遇到的）：
 *   · `https://github.com/owner/course.git`
 *   · `https://github.com/owner/course`（不加 .git）
 *   · `github.com/owner/course`
 *   · `owner/course`（GitHub 上那个短写）
 *
 * 拒绝的写法：带凭据的 URL（`https://token@github.com/...`）——
 * 插件从第一天起的口径是「不放任何人的密钥」，而这个地址会被**写进配置文件**、
 * 显示在界面上。用户从别处复制粘贴时很容易带上 token，所以这里直接拒掉并说清原因。
 *
 * @returns {{ok:boolean, remote?:string, name?:string, owner?:string, error?:string}}
 */
export function parseRepoInput(input) {
  const raw = String(input == null ? '' : input).trim()
  if (!raw) return { ok: false, error: '还没填公开仓地址。' }

  let s = raw
  // 短写 owner/name（只可能是这一种，因为它不含 : 也不含 /）
  if (!/[:@]/.test(s) && /^[^/\s]+\/[^/\s]+$/.test(s)) {
    const [o, n] = s.split('/')
    return finish('https://github.com/' + o + '/' + n + '.git', o, n)
  }
  // 没有协议头时补上 https://（`github.com/a/b` 这种写法极常见）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '')
  // http:// 也接受，但**归一成 https**：不归一的话这个地址会被写进配置文件、
  // 显示在界面上、发给学生照抄 —— 而 GitHub 对 http 一律跳转，
  // 多一次跳转就多一次「为什么我这台机器不行」的机会。
  if (/^http:\/\//i.test(s)) s = 'https://' + s.slice('http://'.length)

  if (!/^https:\/\//i.test(s)) {
    return {
      ok: false,
      error: '只支持 https 地址（现在填的是 ' + s.split('://')[0] + '://…）。'
        + 'ssh 地址要先配密钥，而这个向导要保证「填进去就能用」。',
    }
  }
  // 带凭据的地址：拒掉。判据落在「//」与第一个「/」之间有没有 `@`。
  const afterScheme = s.slice(s.indexOf('://') + 3)
  const hostPart = afterScheme.split('/')[0]
  if (hostPart.indexOf('@') >= 0) {
    return {
      ok: false,
      error: '地址里带了账号或 Token。这个地址会被写进配置文件、也会显示在界面上，'
        + '所以插件不收带凭据的写法 —— 请用不含凭据的 `https://github.com/<owner>/<仓名>.git`。',
    }
  }
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i.exec(s)
  if (!m) {
    return {
      ok: false,
      error: '这个地址看不懂：' + raw + '。要的是仓库首页地址，例如 '
        + 'https://github.com/fadedfakers/DSH-algorithm.git —— 注意不是某一节课、也不是分支页面。',
    }
  }
  return finish('https://' + m[1] + '/' + m[2] + '/' + m[3] + '.git', m[2], m[3])
}

function finish(remote, owner, name) {
  return { ok: true, remote, owner, name: String(name).replace(/[\/\\]/g, '') }
}

/**
 * 默认落点：`~/DSH-<课程码>`（老师的决定；用户可以在向导里改）。
 *
 * 为什么带 `DSH-` 前缀：这个目录是**面板自己 clone 下来的**，不是用户手建的。
 * 有统一前缀，用户以后在资源管理器里一眼能认出「这几个是课程仓」，
 * 卸载/换课时也敢删。
 *
 * 课程码的来源顺序（**不猜**）：
 *   ① 课程配置里的 code（老师填过就用老师的）
 *   ② 仓名（约定：仓名就是 ASCII 化的课程码，见 repo.js 的 repoSlug）
 * 都拿不到就用 `course` —— 这时候界面会提示用户自己改路径，不硬装聪明。
 */
export function defaultTargetDir(homeDir, repoName, courseCode) {
  const home = String(homeDir || '').replace(/[\/\\]+$/, '')
  const raw = String(courseCode || '').trim() || String(repoName || '').trim() || 'course'
  // 目录名里只留安全字符：中文课程码也允许（Windows 目录名支持中文），
  // 但要把路径分隔符与盘符用得上的字符去掉。
  // ⚠️ 点号也要去掉，不只是开头的：`..\..\Windows` 这种输入如果只削开头，
  //    中间的 `..` 会在别的地方被重新解释成「上一级」，落点就跑出去了。
  //    正常课程码里不会有点（`DL2026` / `v1-0`），所以这个代价是零。
  const safe = raw.replace(/[\\/:*?"<>|]/g, '-').replace(/\./g, '-').replace(/^-+/, '').trim() || 'course'
  return home ? (home + '\\DSH-' + safe) : ('DSH-' + safe)
}

/**
 * 落点目录的现状 —— 决定向导能不能往下走。
 *
 * 为什么必须分四种：`git clone` 对**非空目录**会直接失败，
 * 而对**空目录**可以；对**已经是仓库**的目录则会再套一层（`<dir>/<name>/`）——
 * 用户以为 clone 到了 <dir>，实际在 <dir>/<name>，而界面上看不出区别。
 * 所以「已存在且有内容」这一档必须**在 clone 之前**拦住并让用户选。
 *
 * @param {string} dirAbs 落点
 * @param {(p:string)=>{isDir:boolean,isFile:boolean}|null} statFn 注入的探测函数（便于测试）
 * @param {(p:string)=>string[]} listFn 列目录（便于测试）
 * @param {(p:string)=>boolean} existsFn
 */
export function inspectTarget(dirAbs, api) {
  const { exists, isDir, listDir } = api
  if (!dirAbs) return { state: DIR_STATE.ABSENT, entries: 0 }
  if (!exists(dirAbs)) return { state: DIR_STATE.ABSENT, entries: 0 }
  if (!isDir(dirAbs)) return { state: DIR_STATE.OCCUPIED, entries: 0, why: '这是一个文件，不是目录' }
  // path.join 而不是字符串拼：落点可能是 `C:\x` 也可能带尾分隔符，
  // 拼错了就会把「已经有仓库」判成「空目录」——而空目录是**允许 clone** 的一档。
  if (exists(path.join(dirAbs, '.git'))) return { state: DIR_STATE.REPO, entries: 0 }
  let entries = []
  try { entries = listDir(dirAbs) } catch (e) { entries = [] }
  if (!entries.length) return { state: DIR_STATE.EMPTY, entries: 0 }
  return { state: DIR_STATE.OCCUPIED, entries: entries.length, sample: entries.slice(0, 5) }
}

/**
 * 一个目录**是不是**一门课的课程工作区。
 *
 * 判据只有一个，而且必须与 host.js 的 looksLikeWorkspace() 完全一致：
 * `课程中心/课程结构索引.json` 存在。
 * 为什么不用「有 课程中心/ 目录」：踩过 —— 课程目录里也有一份 课程中心/，
 * 用目录当判据会把「课程目录」误判成「工作区」，于是共享内容全部找错地方。
 */
export const WORKSPACE_MARKER = ['课程中心', '课程结构索引.json']

/**
 * 从公开仓里读到的结构索引 → `课程配置.json` 的内容。
 *
 * ⚠️ 只写**索引里真有的事实**：课名、模块名。章的映射（"第一章 = 哪几个模块"）
 * 索引里没有这个信息，**不猜** —— 猜错会让按章节名匹配的功能（课件归位）认错位置。
 * 这条与 install.ps1 的 4c 步是同一个口径，两处必须一致：一个是「学生跑脚本」，
 * 一个是「学生点面板」，写出来的配置不能不一样。
 *
 * @param {object} idx 课程结构索引.json 解析结果
 * @param {{code?:string, sourceNote?:string}} [extra]
 */
export function courseConfigFromIndex(idx, extra) {
  const e = extra || {}
  const modules = Array.isArray(idx && idx.modules)
    ? idx.modules.map((m) => String((m && m.name) || '')).filter(Boolean)
    : []
  return {
    _说明: '课程标识。面板顶栏显示的就是这里的 title；换一门课只改这个文件，不需要改代码。',
    _来源: e.sourceNote || '由面板的首次启动向导从 课程中心\\课程结构索引.json 生成；改课名改这里。',
    title: String((idx && idx.course) || ''),
    code: String(e.code || (idx && idx.code) || ''),
    term: '',
    goal: '',
    note: '',
    // 媒体源：留空 = 只用课程包里那份（离线优先，今天的行为）。
    // 填了 = 本机没有的课件图/视频去这里取，并落进 课程中心\.cache\media\。
    // 为什么它必须出现在配置里：课件图**不该**和课程骨架挤在同一条分发通道上 ——
    // 一个十几兆基本不变、一个几百 K 每周改，混在一起就是「改个错别字全班重下」。
    // 将来发录播视频 / 原始 PPT 时，这一项是唯一的开关（见 core/src/media.js）。
    mediaBase: '',
    layout: { modules },
    _待补: 'layout.chapters 是"章 → 模块"的映射，索引里没有这个信息，需要老师确认后手填。留空则用内置默认值 第一章..三。',
  }
}

/**
 * 能不能接受用户选的落点 —— clone 之前最后一道判断。
 *
 * 单独抽出来是因为它要说**三种不同的话**，而这三句话对应三种完全不同的动作：
 *   · 路径是空的 / 不存在        → 可以，直接 clone
 *   · 已经是课程工作区           → 不用 clone，直接「就用它」（用户其实已经有课了）
 *   · 已经是别的 git 仓库        → 不 clone（会套一层），让用户换落点
 *   · 有内容但不是仓库           → 绝不覆盖，让用户换落点
 */
export function judgeTarget(state) {
  const s = state || {}
  switch (s.state) {
    case DIR_STATE.ABSENT:
    case DIR_STATE.EMPTY:
      return { ok: true, mode: 'clone', note: '' }
    case DIR_STATE.REPO:
      return {
        ok: false, mode: 'use-existing',
        note: '这个目录已经是一个 git 仓库了。直接在这里 clone 会套一层子目录'
          + '（变成 <目录>/<仓名>/），所以向导不替你动它 —— 如果它就是你想要的工作区，'
          + '用下面「工作区已经在别的目录」那一栏指过来即可。',
      }
    default:
      return {
        ok: false, mode: 'pick-another',
        note: '这个目录不是空的，而且不是 git 仓库（' + (s.entries || 0) + ' 项'
          + (s.sample && s.sample.length ? ('：' + s.sample.join('、')) : '')
          + '）。向导**不会**往里 clone，也不会覆盖它 —— 请换一个落点。',
      }
  }
}

/**
 * `git clone` 的参数。抽出来是为了能在断言里**逐字**看清要跑什么 ——
 * 这条命令会把一个仓写到用户的磁盘上，参数写错了后果不可逆。
 *
 * 刻意**不加 `--branch`**：这一档是「把整仓拿下来」，不是「钉到某个版本」。
 * 要钉版本的学生用老师给的那条 `--branch <tag>` 命令（见 version.js），
 * 两条路不要混 —— 混了会出现「向导 clone 了 main、老师以为大家在同一版」。
 */
export function cloneArgs(remote, dirAbs) {
  return ['clone', '--progress', remote, dirAbs]
}

/** `git --version` 用的参数（探活）。 */
export function versionArgs() {
  return ['--version']
}

/**
 * 把 git 的一行进度**解析成界面能画的东西**。
 *
 * ── 为什么值得单独一个函数 ──────────────────────────────────────────────
 * clone 一个 15 MB 的课程仓要几十秒，而界面在此之前只能说一句"处理中…"。
 * git 自己一直在往 stderr 写进度（`--progress` 就是为这个加的），
 * 我们不解析它，用户就只能干等 —— 老师这次提的就是「加一个进度条可视化」。
 *
 * git 的进度行长这样（实测）：
 *   `Receiving objects:  45% (1234/2871), 3.21 MiB | 1.2 MiB/s`
 *   `Resolving deltas: 100% (500/500), done.`
 *   `remote: Enumerating objects: 2871, done.`
 * 所以能拿到：**阶段名、百分比、已处理/总数、速率**。
 *
 * ⚠️ 三种情况都要给出"能有话说"的结果，而不是空：
 *   ① 有百分比 → 画进度条（这是绝大多数时候）
 *   ② 有阶段名没百分比（`remote: Enumerating objects: 2871, done.`）→ 只说阶段
 *   ③ 完全不是进度行（报错、`Cloning into ...`）→ `kind:'other'`，调用方自己决定
 * 界面**不许**自己解析这些字符串：正则只有一处（这里），
 * 两处各写一份的话，git 换个版本输出格式就会让进度条静默失效。
 *
 * @param {string} line git stderr 里的一行（**已去掉 \r**）
 * @returns {{kind:'progress'|'phase'|'other', phase:string, percent:number|null, counts:string, rate:string, raw:string}}
 */
export function parseGitProgress(line) {
  // git 用 `\r` 原地刷新，所以一行里可能塞了多段；调用方按 `[\r\n]` 切过之后，
  // 这里再兜一次（拿最后一段 = 最新的一段）。
  const raw = String(line == null ? '' : line).split('\r').filter((s) => s.trim()).pop() || ''
  const s = raw.trim()
  if (!s) return { kind: 'other', phase: '', percent: null, counts: '', rate: '', raw: '' }
  // 掐掉 `remote: ` 前缀（服务端说的话），保留后面的阶段名
  const body = s.replace(/^remote:\s*/i, '')
  const mPct = /^([A-Za-z][A-Za-z .\-]*?):\s+(\d{1,3})%\s*\((\d+)\/(\d+)\)(?:,\s*([^,]+?(?:\/s)?))?/.exec(body)
  if (mPct) {
    const pct = Math.max(0, Math.min(100, Number(mPct[2])))
    return {
      kind: 'progress',
      phase: mPct[1].trim(),
      percent: pct,
      counts: mPct[3] + '/' + mPct[4],
      rate: (mPct[5] || '').trim(),
      raw: s,
    }
  }
  // 没有百分比的阶段行：`Enumerating objects: 2871, done.` / `Compressing objects: 100% …` 之外的
  const mPhase = /^([A-Za-z][A-Za-z .\-]*?):\s*(.*)$/.exec(body)
  if (mPhase && !/^fatal|^error|^warning/i.test(body)) {
    return { kind: 'phase', phase: mPhase[1].trim(), percent: null, counts: mPhase[2].slice(0, 60), rate: '', raw: s }
  }
  return { kind: 'other', phase: '', percent: null, counts: '', rate: '', raw: s }
}

/** 阶段名 → 中文。**查不到就原样返回**（宁可显示英文，也不要显示"未知"） */
export function phaseLabel(phase) {
  const map = {
    'Enumerating objects': '正在清点对象',
    'Counting objects': '正在清点对象',
    'Compressing objects': '正在压缩',
    'Receiving objects': '正在接收',
    'Resolving deltas': '正在合并差异',
    'Updating files': '正在写入文件',
    'Checking out files': '正在检出文件',
    'Cloning into': '正在准备',
  }
  const k = Object.keys(map).find((x) => String(phase).toLowerCase().indexOf(x.toLowerCase()) === 0)
  return k ? map[k] : String(phase || '')
}

/**
 * 把一段 `git clone` 的输出说成人话。
 *
 * 为什么必须挑着说：`--progress` 会往 stderr 里刷几十行
 * `Receiving objects: 43% (1234/2871)` —— 那些行摊在界面上，老师会以为出了问题。
 * 而真正需要他看见的是**失败原因**（仓不存在 / 没权限 / 连不上），
 * git 那几句原文（`Repository not found` / `Could not resolve host`）必须原样留着：
 * 它们是全网唯一能搜到答案的字样，翻译成人话反而搜不到。
 */
export function explainCloneOutput(r, name) {
  const all = String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '')
  const code = r && r.status
  if (r && r.error) {
    return { ok: false, why: '没能启动 git：' + ((r.error && r.error.message) || String(r.error)) }
  }
  if (code === 0) return { ok: true, why: '' }
  const lines = all.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(remote:|Receiving|Resolving|Compressing|Updating|Cloning into)/i.test(l))
  const tail = lines.slice(-6).join(' / ').slice(0, 600)
  const hint = /not found|does not exist|404/i.test(all)
    ? '—— 多半是仓名拼错、或者这是个私有仓而你没配凭据。'
    // ⚠️ 措辞不许点名 GitHub：远端可能是局域网共享盘 / 自建 git（见 repo.js 的 sanitizeRemoteUrl）。
    //    说"连不上 GitHub"会让那类老师去查一个跟他无关的东西。
    //    `connect`（不带 ion）是给 `Failed to connect to <host> port <n>` 这种被拒的连接留的 ——
    //    原来那几个词都匹配不到它，于是"地址填错/服务没起"这类失败**一句提示都没有**。
    : (/could not resolve host|connection|connect|timed out|reset|refused/i.test(all)
      ? '—— 连不上远端。看看网络或代理，然后重试（重试是有用的）。'
      : '')
  return { ok: false, why: 'git clone 失败（exit ' + code + '）：' + (tail || '（没有输出）') + hint + '　仓名：' + name }
}
