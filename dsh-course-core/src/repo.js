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
 * 读一个目录的仓库状态。**不调用 git**。
 * 读不到就返回 hasRepo:false —— 「不是仓库」是正常状态（老师还没建），不是错误。
 */
export function readRepoState(dirAbs) {
  const out = {
    dir: dirAbs, hasRepo: false, branch: '', remotes: {}, remote: '', owner: '', name: '',
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
          hadToken: /x-access-token:|:[^/@]+@github\.com/.test(raw),
        }
      }
    }
    const origin = out.remotes.origin || out.remotes[Object.keys(out.remotes)[0]]
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
  if (!s.remote) return { level: 'no-remote', text: '仓库在本机，但还没有连到 GitHub —— 连上之前学生拿不到任何东西', canPublish: true }
  return { level: 'ok', text: '已连到 ' + (s.owner ? (s.owner + '/' + s.name) : '远程仓库') + '，分支 ' + (s.branch || '?'), canPublish: true }
}

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
