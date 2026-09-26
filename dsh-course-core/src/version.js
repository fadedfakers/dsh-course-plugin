/**
 * 版本控制信息 —— 「这套面板与课程内容是哪个版本发出去的」。
 *
 * ── 为什么需要它（老师提出的设计决定）────────────────────────────────────
 * 学生是把**公开仓 clone 到本机**当工作区用的。于是有一个很容易被忽略的问题：
 * **他 clone 到的那个版本，和面板期望的版本可能对不上。**
 * 面板与课程内容是一起发出去的（发布工具会把 panel/ 与课程数据写进公开仓），
 * 所以「学生该 clone 哪个 commit / 哪个 tag」这件事必须能被**看到**，
 * 而不是靠老师在群里说一句「你拉一下最新的」。
 *
 * 老师的原话：「在教师端应有版本控制信息，方便克隆到正确的版本」。
 * 这个模块就是那份信息的来源。
 *
 * ── 克制原则（与 repo.js 一致）─────────────────────────────────────────
 *   · **能读文件拿到的就不 spawn git**：分支名、commit SHA、tag、有没有远端，
 *     全都在 `.git` 里是明文（HEAD / refs / packed-refs / config）。
 *     spawn git 又慢又脆（本机 git 起子进程要小心管道，见 run.js 顶部）。
 *   · **只在需要"与远端差多少"时才调用 git**，而且失败不影响其它字段 ——
 *     「算不出落后几个提交」不该让整块信息消失。
 *   · **绝不回传可能内嵌 token 的原始 url**（与 repo.js 同一条纪律：
 *     判据要落在整个返回值上，所以这里复用它已经脱敏过的 remoteSafe）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { runCaptured } from './run.js'
import { readRepoState } from './repo.js'

/** 读 `.git` 里的一个 ref（先 refs/<name>，再 packed-refs） */
function readRef(gitDir, name) {
  const loose = path.join(gitDir, ...name.split('/'))
  try {
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim()
  } catch (e) { /* 落到 packed-refs */ }
  try {
    const packed = path.join(gitDir, 'packed-refs')
    if (!fs.existsSync(packed)) return ''
    for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
      if (!line || line[0] === '#' || line[0] === '^') continue
      const sp = line.indexOf(' ')
      if (sp < 0) continue
      if (line.slice(sp + 1).trim() === name) return line.slice(0, sp).trim()
    }
  } catch (e) { /* 读不到就算了 */ }
  return ''
}

/** 列出本地 tag（loose + packed），返回 [{tag, sha}] */
function listTags(gitDir) {
  const out = new Map()
  try {
    const dir = path.join(gitDir, 'refs', 'tags')
    if (fs.existsSync(dir)) {
      for (const t of fs.readdirSync(dir)) out.set(t, fs.readFileSync(path.join(dir, t), 'utf8').trim())
    }
  } catch (e) { /* 忽略 */ }
  try {
    const packed = path.join(gitDir, 'packed-refs')
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/)) {
        if (!line || line[0] === '#' || line[0] === '^') continue
        const sp = line.indexOf(' ')
        if (sp < 0) continue
        const ref = line.slice(sp + 1).trim()
        if (ref.indexOf('refs/tags/') === 0) out.set(ref.slice('refs/tags/'.length), line.slice(0, sp).trim())
      }
    }
  } catch (e) { /* 忽略 */ }
  return [...out.entries()].map(([tag, sha]) => ({ tag, sha })).sort((a, b) => a.tag.localeCompare(b.tag))
}

/**
 * 采集版本信息。
 *
 * @param {string} dirAbs 仓库目录（一般是工作区）
 * @param {object} [opts]
 * @param {object} [opts.repoState] 已经读好的 repo.js readRepoState() 结果（省一次读）
 * @param {boolean} [opts.withRemote] 是否 spawn git 去比对远端（默认 true；
 *        传 false 用于「只想要本地事实、不想起子进程」的场合，比如诊断页）
 * @returns {object} 全是**可以直接显示**的字段，外加一句给人看的话
 */
export function versionInfo(dirAbs, opts = {}) {
  const o = opts || {}
  const out = {
    dir: dirAbs || '',
    hasRepo: false,
    branch: '',
    commit: '',
    commitShort: '',
    tag: '',
    describe: '',
    refKind: '',          // 'tag' | 'branch' | 'none'
    recentTag: '',        // 当前 commit 不是 tag 时，最近的那个 tag
    commitsSinceTag: null,// 距最近 tag 几个提交
    cloneCommand: '',     // 学生该照抄的那条
    remoteName: '',       // 脱敏后的远端地址（不含 token）
    remoteChecked: false,
    remoteCommit: '',
    ahead: null,          // null = 没查（或查不了）
    behind: null,
    note: '',
  }
  if (!dirAbs || !fs.existsSync(dirAbs)) { out.note = '目录不存在'; return out }
  const gitDir = path.join(dirAbs, '.git')
  if (!fs.existsSync(gitDir)) { out.note = '还不是一个 git 仓库'; return out }
  out.hasRepo = true

  // 分支 / detached
  let head = ''
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim() } catch (e) { head = '' }
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (m) {
    out.branch = m[1].trim()
    out.commit = readRef(gitDir, 'refs/heads/' + out.branch)
  } else {
    out.branch = '(detached)'
    out.commit = head // detached 时 HEAD 里直接就是 SHA
  }
  out.commitShort = out.commit ? out.commit.slice(0, 7) : ''

  // tag：**优先**用指向当前 commit 的那个（学生该克隆的就是它）
  const tags = listTags(gitDir)
  const exact = tags.filter((t) => t.sha === out.commit)
  const chosen = exact.length ? exact[exact.length - 1] : null
  if (chosen) { out.tag = chosen.tag; out.refKind = 'tag' }
  else if (out.commit) { out.refKind = 'branch' }
  else { out.refKind = 'none' }

  // describe：v0.1.1-3-gabcdef 这种。只在有 tag 时才有意义，读不到就算了
  if (out.commit) {
    const gitOk = fs.existsSync('D:\\Git\\cmd\\git.exe')
    const r = runCaptured(gitOk ? 'D:\\Git\\cmd\\git.exe' : 'git',
      ['-C', dirAbs, 'describe', '--tags', '--always'], { timeout: 20000, hintDir: dirAbs })
    if (r.status === 0) out.describe = String(r.stdout || '').trim()
    // 从 describe 里拆出「最近的 tag」与「离它几个提交」。
    // 为什么需要：当前 commit **不是**任何 tag 时（正在开发中就是常态），
    // 只报一串 SHA 对学生没有意义；而 `v0.1.1-5-gcc12bc7` 明确告诉他
    // 「你比 v0.1.1 新 5 个提交」——这才是能用作判断的信息。
    const mm = /^(.*)-(\d+)-g[0-9a-f]+$/.exec(out.describe)
    if (mm) { out.recentTag = mm[1]; out.commitsSinceTag = Number(mm[2]) }
  }

  // 学生该照抄的命令。**优先 tag**（版本明确、可复现），没有 tag 就落到 branch。
  //
  // 调用方没传 repoState 就自己读一次 —— 刚开始这里只读 opts.repoState，
  // 结果直接调用（不走教师端那条路）时 cloneCommand 永远是空的。
  // 复用已经写对的 readRepoState（它读 .git/config 且**已经脱敏**），
  // 自己再解析一遍 config 只会多一处可能分叉的代码。
  const st = o.repoState || readRepoState(dirAbs)
  const remote = (st && st.remoteSafe) || ''
  if (remote) {
    out.cloneCommand = 'git clone ' + remote
      + (out.tag ? (' --branch ' + out.tag) : '')
    out.remoteName = remote
  }

  if (o.withRemote !== false && remote && out.branch && out.branch !== '(detached)') {
    const gitOk = fs.existsSync('D:\\Git\\cmd\\git.exe')
    const git = gitOk ? 'D:\\Git\\cmd\\git.exe' : 'git'
    const r = runCaptured(git, ['-C', dirAbs, 'ls-remote', 'origin', 'refs/heads/' + out.branch],
      { timeout: 30000, hintDir: dirAbs })
    if (r.status === 0) {
      const line = String(r.stdout || '').trim().split(/\s+/)[0] || ''
      if (/^[0-9a-f]{7,40}$/.test(line)) out.remoteCommit = line
      out.remoteChecked = true
      if (out.remoteCommit && out.commit && out.remoteCommit !== out.commit) {
        // 只有本地领先/落后一概说不清（没做图遍历），
        // 所以这里只报「跟远端不一致」，并把两边 SHA 都给出来 ——
        // 不假装知道差几个提交（那需要 fetch，代价与本机状态都不可控）。
        out.note = '本地 ' + out.commitShort + ' 与远端 ' + out.remoteCommit.slice(0, 7) + ' 不一致'
      }
    } else {
      // 「连不上远端」是**常态**（离线、代理没开、教室网络），不该写成错误。
      // 它只说明「没法替你确认远端有没有更新」，不影响「本地是哪个版本」这个结论。
      out.note = '未与远端比对'
    }
  } else if (!remote) {
    out.note = '还没配远端仓库'
  }
  return out
}

/** 把 versionInfo 的结果说成一句人话（面板上直接显示这一句） */
export function versionSummary(v) {
  if (!v) return '（读不到版本信息）'
  if (!v.hasRepo) return v.note || '还不是一个 git 仓库'
  const parts = []
  if (v.tag) parts.push('版本 ' + v.tag)
  else if (v.recentTag && v.commitsSinceTag) parts.push('比 ' + v.recentTag + ' 新 ' + v.commitsSinceTag + ' 个提交')
  parts.push('提交 ' + (v.commitShort || '?'))
  if (v.branch && v.branch !== '(detached)') parts.push('分支 ' + v.branch)
  if (v.remoteChecked && !v.note) parts.push('与远端一致')
  let s = parts.join(' · ')
  if (v.note && v.note !== '未与远端比对') s += '（' + v.note + '）'
  return s
}
