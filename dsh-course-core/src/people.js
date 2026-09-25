/**
 * 人的身份 —— 学号、姓名、名册
 *
 * ── 为什么需要这个模块 ────────────────────────────────────────────────
 * 原来学生身份就是一行：`process.env.CIP_STUDENT || process.env.USERNAME`。
 * 于是老师打开教师端，看到的提问者叫 **Administrator** —— 那不是学生，
 * 那是这台 Windows 机器的用户名。老师原话：「谁提问的，便于更好教学」，
 * 而 `Administrator` 这个答案对教学一点用都没有。
 *
 * 三个人（机器、学生、老师）各有一份信息，不能混：
 *
 *   · **这台机器是谁的**   → `~/.dsh/cip-student.json`（不在仓库里，
 *                            换仓库、重新 clone 都还在；也不会被推给别人）
 *   · **学生自报的身份**   → `课程问题池/学生/<学号>/学生信息.json`
 *                            （跟着学号走，老师能看到）
 *   · **老师维护的名册**   → `<课程目录>/学生名册.json`
 *                            （老师是权威：学号对不上人名时，以名册为准）
 *
 * 显示名的优先级：**名册 > 学生自报 > 学号**。
 * 为什么名册最高：学号是学生自己填的，填错、重号、写昵称都可能；
 * 而老师手里的名册来自教务，是这门课唯一的事实来源。
 *
 * ── 一条硬规则：学号一旦有数据就不许随便改 ─────────────────────────────
 * 学号是**目录名**（`课程问题池/学生/<学号>/`）。改了学号等于把这个人
 * 之前的所有提问和作业丢在原地。所以改学号必须**搬迁**（见 moveStudent），
 * 而且要先告诉调用方「有 N 条提问、M 份提交会跟着搬」，由人确认。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { oneLine, safeId } from './host.js'

/**
 * 本机身份文件。
 *
 * ⚠️ 最初写在 `~/.dsh/cip-student.json`（和 cip-workspace.txt 一个地方），
 *    跑起来直接 EPERM —— DSH 的文件沙箱按「工作区」授权，工作区之外**只读**。
 *    所以身份文件必须在工作区里；而它又绝不能进公开仓（那是学生本人的信息），
 *    于是放在**课程私有目录**根部，并进 .gitignore。
 *
 * 读的时候仍然兼容 `~/.dsh/cip-student.json`：那是只读路径，
 * 手动放一份就能在多台机器间保持一致（或做测试夹具）。
 */
export const IDENTITY_REL = '我的身份.json'
export const LEGACY_IDENTITY_FILE = path.join(os.homedir(), '.dsh', 'cip-student.json')
/** @deprecated 仅用于「读得到但写不了」的说明文案；写入一律走 IDENTITY_REL */
export const IDENTITY_FILE = LEGACY_IDENTITY_FILE
/** 每门课一份的老师名册（课程私有：见 host.js 的 PRIVATE_RELS） */
export const ROSTER_REL = '学生名册.json'
/** 学生自报信息的文件名（放在他自己的目录里） */
export const STUDENT_INFO_FILE = '学生信息.json'
/** 学生可填的字段。少即是好 —— 每多一个字段，学生就多一步不想填的表。 */
export const IDENTITY_FIELDS = [
  { key: 'sid', title: '学号', need: '必填。它决定你的提问与作业放在哪个目录下，填了之后不要改。' },
  { key: 'name', title: '姓名', need: '建议填。老师看到的提问者就是这个名字；不填只显示学号。' },
  { key: 'klass', title: '班级', need: '选填。同名的两个人靠它区分。' },
]

function readJson(abs, fallback) {
  try {
    if (!fs.existsSync(abs)) return fallback
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'))
    return (j && typeof j === 'object') ? j : fallback
  } catch (e) { return fallback }
}

// ── 本机身份 ────────────────────────────────────────────────────
/**
 * 读「这台机器是谁的」。读不到返回 null，绝不猜。
 * 先看课程目录里的那份（唯一可写的位置），再看 ~/.dsh 那份（手工放置/夹具）。
 */
export function readIdentity(core) {
  const cands = []
  if (core) cands.push({ abs: core.courseAbs(IDENTITY_REL), how: IDENTITY_REL })
  cands.push({ abs: LEGACY_IDENTITY_FILE, how: LEGACY_IDENTITY_FILE })
  for (const c of cands) {
    const j = readJson(c.abs, null)
    if (!j) continue
    const sid = safeId(j.sid) || ''
    if (!sid) continue
    return {
      sid,
      name: oneLine(j.name).slice(0, 24),
      klass: oneLine(j.klass).slice(0, 24),
      code: oneLine(j.code).slice(0, 32),
      at: j.at || '',
      file: c.abs,
      rel: c.how,
      writable: c.how === IDENTITY_REL,
    }
  }
  return null
}

/**
 * 写本机身份。写不进去要**明确报错**，不要静默失败 ——
 * 静默失败的症状是「填了学号，重启后又变回 Administrator」，
 * 而学生会以为是自己填错了。
 */
export function writeIdentity(core, o) {
  const sid = safeId(o && o.sid) || ''
  if (!sid) throw new Error('学号不能为空')
  const body = {
    _note: '这台机器是谁的。由课程面板写入 —— 只在本机，不进公开仓（已在 .gitignore 里）。',
    sid,
    name: oneLine(o && o.name).slice(0, 24),
    klass: oneLine(o && o.klass).slice(0, 24),
    code: oneLine(o && o.code).slice(0, 32),
    at: new Date().toISOString(),
  }
  try {
    core.writeText(IDENTITY_REL, JSON.stringify(body, null, 2) + '\n')
  } catch (e) {
    throw new Error('写身份文件失败（' + IDENTITY_REL + '）：' + oneLine(e && e.message)
      + ' —— 它是课程目录里的文件，确认这个目录可写。')
  }
  return Object.assign({}, body, { file: core.courseAbs(IDENTITY_REL), rel: IDENTITY_REL, writable: true })
}

/**
 * 解析「这台机器」的学号。
 * 优先级：环境变量（多开/测试用）> 本机身份文件 > 系统用户名。
 * 最后那档是**兜底而不是默认** —— 面板会因此提示「你还没填学号」。
 */
export function resolveStudentId(core, env) {
  const e = env || {}
  const fromEnv = safeId(e.CIP_STUDENT) || ''
  if (fromEnv) return { sid: fromEnv, how: '环境变量 CIP_STUDENT' }
  const id = readIdentity(core)
  if (id) return { sid: id.sid, how: '本机身份文件 ' + id.rel, identity: id }
  return {
    sid: safeId(e.USERNAME || e.USER || '') || 'anonymous',
    how: '系统用户名（兜底，不是你的学号）',
    fallback: true,
  }
}

// ── 老师名册 ────────────────────────────────────────────────────
export function readRoster(core) {
  const j = readJson(core.courseAbs(ROSTER_REL), null)
  const out = { students: {}, source: '' }
  if (!j) return out
  out.source = ROSTER_REL
  const src = (j.students && typeof j.students === 'object') ? j.students : j
  for (const k of Object.keys(src)) {
    if (k === '_note' || k === 'students') continue
    const v = src[k]
    if (!v || typeof v !== 'object') continue
    const sid = safeId(k) || ''
    if (!sid) continue
    out.students[sid] = {
      name: oneLine(v.name).slice(0, 24),
      klass: oneLine(v.klass).slice(0, 24),
      note: oneLine(v.note).slice(0, 200),
      at: v.at || '',
    }
  }
  return out
}

export function writeRoster(core, students) {
  const body = {
    _note: '老师维护的学生名册。显示名以这里为准 —— 学号是学生自己填的，'
      + '可能填错、重号或写昵称，而老师手里的名册来自教务。'
      + '这份文件是课程私有数据（在课程目录下），不会进公开仓。',
    students: students || {},
  }
  core.writeText(ROSTER_REL, JSON.stringify(body, null, 2) + '\n')
  return body
}

// ── 学生自报信息 ────────────────────────────────────────────────
export function readStudentInfo(core, sid, rel) {
  const base = rel || (core.STUDENT_ITEMS_REL + '\\' + sid)
  const j = readJson(core.courseAbs(base + '\\' + STUDENT_INFO_FILE), null)
  if (!j) return null
  return {
    name: oneLine(j.name).slice(0, 24),
    klass: oneLine(j.klass).slice(0, 24),
    at: j.at || '',
  }
}

export function writeStudentInfo(core, sid, o) {
  const base = core.STUDENT_ITEMS_REL + '\\' + sid
  core.writeText(base + '\\' + STUDENT_INFO_FILE, JSON.stringify({
    _note: '学生自己填的身份。老师名册里有记录时以名册为准。',
    sid,
    name: oneLine(o && o.name).slice(0, 24),
    klass: oneLine(o && o.klass).slice(0, 24),
    at: new Date().toISOString(),
  }, null, 2) + '\n')
}

/**
 * 显示名。三名册 > 自报 > 空。
 * `label` 是「张三（S001）」这种给界面用的完整写法 ——
 * 只显示姓名会让两个同名学生分不清，只显示学号则老师根本不认识。
 */
export function nameOf(sid, roster, info) {
  const r = roster && roster.students ? roster.students[sid] : null
  if (r && r.name) return r.name
  if (info && info.name) return info.name
  return ''
}

export function labelOf(sid, roster, info) {
  const n = nameOf(sid, roster, info)
  return n ? (n + '（' + sid + '）') : sid
}

/**
 * 把学生从旧学号挪到新学号。
 *
 * 为什么必须搬而不是「改个字段」：学号是**目录名**。不搬的后果是
 * 「他的历史提问和作业留在旧目录里，从此谁也看不见」——
 * 数据没丢，但等于丢了，而且不报错。
 */
export function moveStudent(core, fromSid, toSid) {
  const from = safeId(fromSid)
  const to = safeId(toSid)
  if (!from || !to) throw new Error('学号不合法')
  if (from === to) return { moved: [], from, to }
  const moved = []
  const plans = [
    { rel: core.STUDENT_ITEMS_REL + '\\' + from, toRel: core.STUDENT_ITEMS_REL + '\\' + to, kind: '提问' },
    { rel: core.SUBMIT_ROOT_REL + '\\' + from, toRel: core.SUBMIT_ROOT_REL + '\\' + to, kind: '提交' },
  ]
  for (const p of plans) {
    const src = core.courseAbs(p.rel)
    const dst = core.courseAbs(p.toRel)
    if (!fs.existsSync(src)) { moved.push({ kind: p.kind, count: 0, skipped: '旧目录不存在' }); continue }
    if (fs.existsSync(dst)) {
      // 目标已存在：**不合并、不覆盖**。合并两个学生的数据是件必须由人决定的事，
      // 猜错的后果是把别人的作业算到这个人头上。
      moved.push({ kind: p.kind, count: 0, conflict: true, dst: p.toRel })
      continue
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.renameSync(src, dst)
    let n = 0
    try { n = fs.readdirSync(dst).filter((f) => /\.md$/.test(f)).length } catch (e) { n = 0 }
    moved.push({ kind: p.kind, count: n, to: p.toRel })
  }
  return { moved, from, to }
}
