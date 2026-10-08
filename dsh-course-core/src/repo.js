/**
 * 仓库管理（发布页的后端）
 *
 * ── 这一页是给谁用的 ──────────────────────────────────────────────────
 * **不懂 git 的老师**。他需要人帮的只有三件事：
 *   1. 这门课还没有仓库 → 帮我建
 *   2. 有仓库了 → 帮我发（生成内容）
 *   3. 发完了 → 帮我推（推上去学生才拿得到）
 * 分支、PR、rebase 这些一概不做 —— 那是给会 git 的人用的，做了只会让这一页变吓人。
 *
 * ── 一个刻意的分工 ────────────────────────────────────────────────────
 * **「发布」和「推送」必须分开显示**，因为它们是两种失败：
 *   · 发布失败 = 插件的问题（找不到清单、文件被占用）
 *   · 推送失败 = 凭据/网络的问题（要老师自己动手）
 * 混成一句「发布失败」，老师不知道该找谁。
 *
 * ── 为什么状态直接从 .git/config 读 ──────────────────────────────────
 * 不调用 git 命令：插件里 spawn 一个 git 进程会带来「找不找得到 git」
 * 「不同版本输出格式不一样」两类问题，而我们只想知道三件事 ——
 * 有没有仓库、remote 指向哪、当前在哪个分支。这些 .git/config 里就是明文。
 * 真要推送时再把命令交给老师（或让 git 自己报错），那时才需要 git 本体。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 课程码 → 仓库名。
 *
 * 规则：只留 `[a-z0-9-]`，其余折成 `-`，最多 60 字。
 * 为什么不用中文课程名：GitHub 仓名虽允许，但 URL、clone 命令、CI 全都会变难用，
 * 而这三样恰恰是学生每天要碰的。**课程名放仓库简介**。
 */
export function repoSlug(code, fallback) {
  const s = String(code || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return s || String(fallback || 'course').replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'course'
}

/** 带 token 的 https remote。**只在内存里拼，绝不落盘到仓库里。** */
export function remoteUrl(owner, name, token) {
  const o = String(owner || '').trim()
  const n = String(name || '').trim()
  if (!o || !n) return ''
  const t = String(token || '').trim()
  return t
    ? ('https://x-access-token:' + t + '@github.com/' + o + '/' + n + '.git')
    : ('https://github.com/' + o + '/' + n + '.git')
}

/** 从任何形式的 remote url 里取出 `owner/name`（带不带 token、ssh 还是 https 都要认） */
export function parseRemote(url) {
  const s = String(url || '').trim()
  if (!s) return { owner: '', name: '' }
  let m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s)
  if (!m) return { owner: '', name: '' }
  return { owner: m[1], name: m[2] }
}

/**
 * 把一个 remote URL 变成**可以显示**的形式：凭据一律砍掉，其余原样保留。
 *
 * 为什么需要它（这条是被测试逼出来的，不是先想出来的）：
 *   原来 `readRepoState` 只认 GitHub 形状的 URL，别的形状一律算成"没有远端"。
 *   于是老师把私有仓放在**局域网共享盘 / 自建 git / GitLab** 上时，
 *   同步卡会说「仓库在本机，但还没有连到远端 —— 提问只在你这台机器上」——
 *   而他的远端明明配着、`git push` 也一直能用。**界面在说假话。**
 *   对「两台教师机互通」这件事来说，远端在哪一家托管**根本不重要**：
 *   我们要的只是"能不能推上去"，而那是 git 的事。
 *
 * ⚠️ 同时它必须比原来更严：原来只在 GitHub 形状上做脱敏，
 *    别的形状直接落成空串 —— 空串当然不漏，但也把"有远端"这个事实一起丢了。
 *    现在保留原样，所以凭据必须在这里砍干净：
 *      `https://user:token@host/x.git` → `https://host/x.git`
 *      `https://token@host/x.git`     → `https://host/x.git`
 *    本地路径 / `file://` / scp 形式（`git@host:path`）里没有密码段
 *    （scp 里的用户名不是秘密，密钥不在 URL 里），原样返回即可读。
 */
export function sanitizeRemoteUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  // 本地路径：Windows 盘符、UNC、POSIX 绝对/相对路径。里面不可能有凭据。
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || s[0] === '/' || s[0] === '.') return s
  if (/^file:\/\//i.test(s)) return s
  // 带 scheme 的：`scheme://[凭据@]余下` —— 整段凭据砍掉，其余保留
  const m = /^([A-Za-z][\w+.-]*:\/\/)(?:[^/@]*@)?(.*)$/.exec(s)
  if (m) return m[1] + m[2]
  // scp 形式 `git@host:path`：用户名不是秘密，原样
  return s
}

/**
 * 读一个目录的仓库状态。**不调用 git**。
 * 读不到就返回 hasRepo:false —— 「不是仓库」是正常状态（老师还没建），不是错误。
 */
export function readRepoState(dirAbs) {
  const out = {
    dir: dirAbs, hasRepo: false, branch: '', remotes: {}, remote: '', owner: '', name: '',
    // remoteAny：**任意形状**的远端（脱敏后的可读形式）；remote 只认 GitHub。
    // 两个都给，是因为用途不同：发布页要的是 GitHub（它用 API 建仓），
    // 而「两台教师机同步」只要有个远端就行（推送是 git 的事，不是 GitHub 的事）。
    remoteAny: '', remoteCount: 0,
    ahead: 0, dirty: 0, note: '',
  }
  if (!dirAbs || !fs.existsSync(dirAbs)) { out.note = '目录不存在'; return out }
  const gitDir = path.join(dirAbs, '.git')
  if (!fs.existsSync(gitDir)) { out.note = '还不是一个 git 仓库'; return out }
  out.hasRepo = true
  // 分支名：HEAD 里是 `ref: refs/heads/main`
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    out.branch = m ? m[1].trim() : '(detached)'
  } catch (e) { out.branch = '' }
  // remote：.git/config 里是明文
  try {
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8')
    let cur = ''
    for (const raw of cfg.split(/\r?\n/)) {
      const line = raw.trim()
      const sec = /^\[remote "(.+)"\]$/.exec(line)
      if (sec) { cur = sec[1]; out.remotes[cur] = out.remotes[cur] || { url: '' }; continue }
      if (/^\[/.test(line)) { cur = ''; continue }
      const kv = /^url\s*=\s*(.+)$/.exec(line)
      if (kv && cur) {
        // ⚠️ 这里也必须脱敏。第一版只脱敏了 out.remote，却把**原始 url**
        //    留在 out.remotes 里 —— 于是整个对象一旦被 JSON 化或打印，
        //    token 照样漏出去。测试查的是「返回对象里任何位置都没有 token」，
        //    所以它抓到了。判据要落在**整个返回值**上，不是某一个字段。
        const raw = kv[1].trim()
        const p0 = parseRemote(raw)
        out.remotes[cur] = {
          url: p0.owner ? ('https://github.com/' + p0.owner + '/' + p0.name + '.git') : '',
          // ⚠️ 非 GitHub 形状也要**留一份脱敏后的可读形式**。原来这里给空串，
          //    于是「远端是局域网共享盘 / 自建 git」被算成"没连远端"（见 sanitizeRemoteUrl 注释）。
          any: sanitizeRemoteUrl(raw),
          hadToken: /x-access-token:|:[^/@]+@github\.com/.test(raw),
        }
      }
    }
    const origin = out.remotes.origin || out.remotes[Object.keys(out.remotes)[0]]
    out.remoteCount = Object.keys(out.remotes).length
    // 任意形状的远端：优先 origin，其次任何一个
    out.remoteAny = (origin && (origin.any || origin.url)) || ''
    if (origin && origin.url) {
      const p = parseRemote(origin.url)
      out.owner = p.owner; out.name = p.name
      // ⚠️ **绝不把原始 url 回传。** 它可能内嵌 token，而回传之后它就会出现在
      //    界面上、日志里，也可能被老师截图发出去。
      //    这一条我第一次就写错了 —— 算出了 remoteSafe，却仍然把原始的 out.remote
      //    原样带着走，等于白算。测试把它抓出来了（断言明确查 token 不在返回里）。
      //    现在只回**脱敏形式**；要带 token 推送时由调用方用
      //    remoteUrl(owner, name, token) 现拼，token 不经过这里。
      out.remote = p.owner ? ('https://github.com/' + p.owner + '/' + p.name + '.git') : ''
      out.remoteSafe = out.remote
      out.hadToken = !!origin.hadToken
    }
  } catch (e) { out.note = '读 .git/config 失败：' + String((e && e.message) || e).slice(0, 60) }
  return out
}

/** 状态 → 一句人话。老师看的不是 `ahead 3`，是「有 3 个文件还没推上去」。 */
export function repoSummary(state) {
  const s = state || {}
  if (!s.hasRepo) return { level: 'none', text: '这门课还没有仓库 —— 学生在等你建一个', canPublish: false }
  // ⚠️ 判据用 remote || remoteAny：远端只要**存在**就不能说"没有远端"。
  //    原来只看 remote（GitHub 形状），于是自建 git / 局域网共享盘 / GitLab
  //    上的仓被说成「还没有连到 GitHub —— 连上之前学生拿不到任何东西」，
  //    而老师的 push 一直好好的。**宁可少说一句，也不能说假话。**
  const anyRemote = s.remote || s.remoteAny || ''
  if (!anyRemote) {
    return { level: 'no-remote', text: '仓库在本机，但还没有连远端 —— 连上之前学生拿不到任何东西', canPublish: true }
  }
  const where = s.owner ? (s.owner + '/' + s.name) : anyRemote
  return { level: 'ok', text: '已连到 ' + where + '，分支 ' + (s.branch || '?'), canPublish: true }
}

/**
 * `git rev-list --left-right --count <本地>...<远端>` 的输出 → 领先/落后几个提交。
 *
 * ── 为什么必须让 git 去数，不能自己读文件 ────────────────────────────────
 * 「本地比远端多几个提交」是**图上的可达性**问题：要沿 commit 的 parent 边
 * 双向走一遍才算得准。自己数 refs 只能得到一个唬人的数字，而它恰好会
 * 说错在最需要它对的场合（分叉、本地 rebase 过、远端被别人推过）。
 *
 * git 的输出是 `左<TAB>右`：左边 = 本地独有（ahead）、右边 = 远端独有（behind）。
 *
 * ⚠️⚠️ 两条纪律，都是被真事故逼出来的：
 *
 *   ① **必须是 `rev-list`，不能是 `log`。** `git log --count` 里那个 `--count`
 *      **被 git 静默忽略** —— 它照常把对称差里的提交打出来。而这一行输出随后
 *      被下面这个正则去抓数字，抓到的是提交里的 **日期**：
 *        `Date:   Thu Oct 8 19:10:52 2026 +0800`  →  抓出 `8` 和 `19`
 *      于是界面上那句人话变成「已经提交但还没推上去的有 8 个提交；远端有 19 个
 *      提交你还没拉下来」—— **两个数字都是编出来的，而且看起来完全合理。**
 *      教师机上当时显示 `22/19`，我还拿它当"真实状态"写进了验收断言。
 *      这个坑极难发现：命令 exit 0、输出非空、数字像模像样。
 *      真正对的 `rev-list` 在两边一致时给 `0\t0`、`log` 在那时给**空**。
 *
 *   ② **解析必须严格锚定到"整段只有两个数字"**，绝不"在输出里找两个数"。
 *      宽松匹配正是 ① 能骗过所有人的原因 —— 它让**任何**含两个数字的胡言乱语
 *      都变成一句可信的话。宁可返回 null（界面说"读不到"），也不许猜。
 */
export function parseAheadBehind(stdout) {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(stdout || ''))
  if (!m) return null
  return { ahead: Number(m[1]), behind: Number(m[2]) }
}

/**
 * `git status --porcelain=v1` 的原始输出 → 改动过的路径列表。
 *
 * 为什么这块要单独看：两位老师协作最常出的岔子是
 * 「我这边看着有 5 条新提问，推上去对面却看不到」—— 因为那 5 条
 * **根本没进提交**（工作区改了、没 commit）。而 porcelain 的原始输出
 * 对不懂 git 的老师是一串天书，所以要变成"哪几个文件"。
 */
export function parseChangedPaths(porcelain) {
  const out = []
  for (const line of String(porcelain || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    // porcelain=v1：`XY <path>`；重命名是 `XY <old> -> <new>`
    let p = line.slice(3).trim()
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) p = p.slice(arrow + 4).trim()
    if (p.length > 1 && p[0] === '"' && p[p.length - 1] === '"') p = p.slice(1, -1)
    out.push(p)
  }
  return out
}

/**
 * 哪些路径算「课程数据」（两位老师之间要同步的东西）。
 *
 * ⚠️ 必须有个白名单，不能把 `git status` 里所有东西都算进来：
 *    老师的仓库里同时躺着**一大堆源码改动**（这个项目自己就是插件开发树，
 *    实测有几百个改动文件）。全算进来的话这一块会永远显示"有 200 个文件没提交"，
 *    老师很快就会学会无视它 —— 而那时真的漏了 5 条提问也看不出来了。
 */
export const COURSE_DATA_RE = /^(课程问题池|作业提交|教案草稿|课程配置\.json|学生名册\.json|资料\.json|资料\/|课程中心\/预览数据|课程中心\/课程结构索引\.json)/

/**
 * 没有 Token 时的**两条命令**。
 *
 * 为什么保留这条路：Token 不是人人都有（企业账号可能禁止 PAT），
 * 而没有 Token 就不让发布是过分的 —— 老师手动建两个空仓，其余全自动。
 * 命令必须**照抄即可**：所以带上完整 URL，不写 `<你的仓库>` 这种占位符。
 */
export function manualSteps(owner, name, opts) {
  const o = opts || {}
  const priv = o.privateName || (name + '-privated')
  const lines = [
    '# ① 先在 GitHub 上建两个空仓（不要勾选 Add README）：',
    '#    ' + (owner ? (owner + '/') : '') + name + '        （公开：学生 clone 这个）',
    '#    ' + (owner ? (owner + '/') : '') + priv + '   （私有：放提问、作业、教案草稿）',
    '',
    '# ② 建完回来后把这几个 remote 配好（把 <你的用户名> 换成你自己的）：',
    'cd 课程发布\\public',
    'git init',
    'git remote add origin https://github.com/<你的用户名>/' + name + '.git',
    'git add -A',
    'git commit -m "首次发布"',
    'git branch -M main',
    'git push -u origin main',
  ]
  if (!o.skipPrivate) {
    lines.push('', '# 课程工作区根目录（私有仓）：')
    lines.push('cd ..\\..')
    lines.push('git init')
    lines.push('git remote add origin https://github.com/<你的用户名>/' + priv + '.git')
  }
  return lines.join('\n')
}

/**
 * 版本比对 → 一句**结论**：学生照那条 clone 命令，现在会拿到哪一份。
 *
 * 为什么抽成纯函数（而不是留在教师端动作体内、看着返回值现场拼）：
 * 它是这一整块里唯一「说错了也没人发现」的东西 —— 说「一致」而实际不一致，
 * 表现是学生 clone 到旧面板、只报一些莫名其妙的「未知动作」；
 * 说「不一致」而实际一致，老师会白推一次。两种都不报错。
 * 写成纯函数，各种组合（没查过 / 连不上 / 远端是空的 / 一致 / 不一致）
 * 就能在构建门里逐条钉死。
 *
 * `checked` 这个入参是**必须**的：不能靠 `remoteCommit` 为空来推
 * 「没查过」还是「远端是空的」—— 那是两件完全不同的事，
 * 前者应该说「点按钮去比一下」，后者应该说「学生 clone 会拿到空目录」。
 *
 * @param {object|null} pub  versionInfo() 在公开仓上的返回
 * @param {boolean} checked  到底有没有真的和远端比对过（= 调用方传了 withRemote:true 且 ls-remote 成功）
 * @returns {{level:string,text:string}|null} null = 没有额外结论可说（本机事实已在摘要里）
 */
export function versionVerdict(pub, checked) {
  const v = pub || {}
  if (!v.hasRepo) return { level: 'none', text: '公开仓还没在这台机器上准备好，暂时没有能给学生克隆的东西。' }
  if (!v.remoteName) return { level: 'warn', text: '公开仓还没连到 GitHub，学生现在没有可克隆的地址。' }
  if (!checked) return null
  if (!v.remoteCommit) {
    return { level: 'warn', text: 'GitHub 上的公开仓还是空的（没有推送过任何提交）—— 学生照这条命令会 clone 到一个空目录。' }
  }
  if (v.remoteCommit === v.commit) {
    return { level: 'ok', text: 'GitHub 上的内容与本机一致：学生照那条命令克隆，拿到的就是这个版本。' }
  }
  return {
    level: 'warn',
    text: 'GitHub 上是 ' + String(v.remoteCommit).slice(0, 7) + '，这台机器上是 '
      + (v.commitShort || '?') + ' —— 两边不一样：学生现在克隆会拿到 GitHub 上那一份。',
  }
}

/**
 * 建仓请求体。纯函数 —— 真正发请求的那一步在宿主里，
 * 但请求体长什么样必须能单独看、单独测（写错了 GitHub 会回一句很含糊的错）。
 */
export function createRepoBody(name, opts) {
  const o = opts || {}
  return {
    name: String(name || '').trim(),
    private: !!o.private,
    // 课程名放简介：仓名用 ASCII，人话放这里 —— 这就是「仓名不用中文」的补偿
    description: String(o.description || '').slice(0, 300),
    // 不自动初始化：我们要自己 push 一份有内容的首次提交，
    // 让 GitHub 建一个带 README 的仓会和首推打架（要先 pull --rebase）。
    auto_init: false,
    has_issues: false,
    has_wiki: false,
    has_projects: false,
  }
}
