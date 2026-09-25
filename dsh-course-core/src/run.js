/**
 * 起一个子进程并把它的输出**收回来**。
 *
 * ── 为什么不直接用 spawnSync 的 `encoding:'utf8'` ────────────────────────
 * 这是本机实测出来的，不是推测：
 *
 *     spawnSync('git',   ['--version'], { encoding: 'utf8' })  →  status=null  error=EPERM
 *     spawnSync('node',  ['--version'], { encoding: 'utf8' })  →  status=null  error=EPERM
 *     spawnSync('git',   ['--version'], { stdio: 'inherit' })  →  status=0     "git version 2.55..."
 *     spawnSync('git',   ['--version'], { stdio: ['ignore', fd, fd] }) → status=0  同样能拿到输出
 *
 * 规律很清楚：**一给管道就 EPERM，给「什么都不捕获」或「重定向到文件描述符」就正常。**
 * 原因是 DSH 的沙箱不允许进程打开命名管道，而 `encoding`/默认 stdio 走的就是管道。
 * 所以这不是「git 装错了」也不是「路径不对」—— 换成任何可执行文件都一样，
 * 连 `node --version` 都 EPERM。
 *
 * ── 症状为什么特别难查 ──────────────────────────────────────────────────
 * `spawnSync` 在这里**不抛异常**：它返回 `{status:null, error:EPERM, stdout:''}`。
 * 于是调用方拿到的是「退出码 null + 没有输出」，
 * 界面上就变成一句「（没有输出）」或者「git 失败了」——
 * 而真实原因是「这个环境不让插件起带管道的子进程」。
 * 老师照着这句话去查，会一路查到「git 是不是没装」，方向全错。
 *
 * ── 做法 ────────────────────────────────────────────────────────────────
 * 把 stdout/stderr 重定向到两个**临时文件**，跑完再读回来，然后删掉。
 * 与管道相比只多了一次文件读写，但在这个沙箱下是唯一能既拿到输出、
 * 又拿到真实退出码的写法。
 *
 * ⚠️ 任何一步失败都必须**原样把 error 交出去**（`code` 字段）。
 *    上面那个「EPERM 静默变成空输出」的坑，就是靠调用方读 error 才能避免的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * 找一个能写临时文件的目录。
 *
 * 优先系统临时目录；被沙箱挡住时回落到工作区里的一个点目录
 * （工作区是明确可写的，插件本来就往这里写数据）。
 * 两个都不能写就只能不捕获输出 —— 见下面的降级。
 */
function pickTmpDir(hintDir) {
  const candidates = [os.tmpdir(), hintDir ? path.join(hintDir, '课程中心', '.cache', 'run') : ''].filter(Boolean)
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, '.write-probe-' + process.pid)
      fs.writeFileSync(probe, '')
      fs.unlinkSync(probe)
      return dir
    } catch (e) { /* 试下一个 */ }
  }
  return ''
}

let seq = 0

/**
 * 跑一个子进程，返回 `{ status, stdout, stderr, error }`。
 *
 * @param {string} cmd   可执行文件
 * @param {string[]} argv 参数
 * @param {{cwd?:string, timeout?:number, hintDir?:string, env?:object}} opts
 *        hintDir：系统临时目录不可写时的落点（一般是工作区）
 *        env：整份环境变量。**给了就整份用它，不做合并** —— 合不合并是调用方的意思，
 *             由被调方猜哪一种都会猜错一半（「在原有环境上加一个」和「只要这几个」）。
 */
export function runCaptured(cmd, argv, opts) {
  const o = opts || {}
  const timeout = Number(o.timeout) > 0 ? Number(o.timeout) : 60000
  const tmpDir = pickTmpDir(o.hintDir)
  const spawnOpts = { cwd: o.cwd, timeout, windowsHide: true }
  if (o.env) spawnOpts.env = o.env

  // 连临时文件都建不了：只能不捕获。输出会直接进宿主的控制台，
  // 我们至少还能拿到退出码与 error —— 比拿一句「没有输出」强。
  if (!tmpDir) {
    const r = spawnSync(cmd, argv, Object.assign({}, spawnOpts, { stdio: 'inherit' }))
    return {
      status: r.status, stdout: '', stderr: '',
      error: r.error || new Error('这个环境不允许捕获子进程输出（管道被拒），已改为不捕获；请在宿主控制台查看'),
    }
  }

  seq += 1
  const stamp = process.pid + '-' + Date.now() + '-' + seq
  const outPath = path.join(tmpDir, 'run-' + stamp + '.out')
  const errPath = path.join(tmpDir, 'run-' + stamp + '.err')
  let ofd = -1
  let efd = -1
  try {
    ofd = fs.openSync(outPath, 'w')
    efd = fs.openSync(errPath, 'w')
    // stdio[0] 给 'ignore'：我们不喂 stdin，而给管道同样会被沙箱拒。
    const r = spawnSync(cmd, argv, Object.assign({}, spawnOpts, { stdio: ['ignore', ofd, efd] }))
    fs.closeSync(ofd); ofd = -1
    fs.closeSync(efd); efd = -1
    const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch (e) { return '' } }
    return { status: r.status, stdout: read(outPath), stderr: read(errPath), error: r.error || null }
  } catch (e) {
    // openSync 本身失败（目录权限变了等）：退回不捕获，同上。
    const r = spawnSync(cmd, argv, Object.assign({}, spawnOpts, { stdio: 'inherit' }))
    return { status: r.status, stdout: '', stderr: '', error: r.error || e }
  } finally {
    if (ofd >= 0) { try { fs.closeSync(ofd) } catch (e) { /* 已关 */ } }
    if (efd >= 0) { try { fs.closeSync(efd) } catch (e) { /* 已关 */ } }
    try { fs.unlinkSync(outPath) } catch (e) { /* 没建成 */ }
    try { fs.unlinkSync(errPath) } catch (e) { /* 没建成 */ }
  }
}

/**
 * 把 `{status, stdout, stderr, error}` 拼成一段给人看的文本。
 *
 * ⚠️ error **必须**并进去。只拼 stdout/stderr 的话，
 *    「进程压根没起来」会显示成「（没有输出）」—— 这正是上面那个 EPERM 坑的成因。
 */
export function runOutput(r) {
  const text = ((r.stdout || '') + (r.stderr || '')
    + (r.error ? ('（没能启动子进程：' + (r.error.message || r.error.code || r.error) + '）') : '')).trim()
  return text
}

/** 退出码：起不来算 -1，跑完了用真实码（0 以外一律当失败）。 */
export function runExitCode(r) {
  if (r.error) return -1
  return r.status === 0 ? 0 : (r.status == null ? -1 : r.status)
}
