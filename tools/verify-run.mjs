// 「起子进程并收回输出」的验证。
//
// 这一条必须常驻流水线，因为它守的是一个**静默**的坑：
// DSH 沙箱不给管道，`spawnSync(..., { encoding:'utf8' })` 一律 EPERM，
// 而它**不抛异常** —— 返回 {status:null, error:EPERM, stdout:''}。
// 调用方看到的是「退出码 null + 没有输出」，于是：
//   · 发布页把 git 判成「没装」，让老师去装一个他早就装好的 Git
//   · 学生端「拉取更新」永远报「本地有未提交的改动」
// 两句都是**与真实原因无关**的话，照着查会一路查错方向。
//
// 所以这里断言的不是「runCaptured 能跑」，而是**能跑、且能拿到真实输出与真实退出码** ——
// 后者才是上面那个坑里丢掉的东西。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 【测试隔离】不让宿主机器上的 ~/.dsh/cip-workspace.txt 抢走解析结果。
// 【测试隔离】解析链会读那个文件，而它是**这台机器**的真实配置 —— 在配过的机器上
// 【测试隔离】（教师机就是）它会先命中，本脚本自己的工作区反而被跳过。
// 【测试隔离】指到一个必然不存在的文件 = 把它从候选里摘掉，隔离才干净。
if (!process.env.CIP_WORKSPACE_FILE) {
  process.env.CIP_WORKSPACE_FILE = path.join(os.tmpdir(), 'cip-test-no-workspace-file.txt')
}


const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const C = await import(pathToFileURL(path.join(ROOT, '课程中心/course-plugin/dsh-course-core/src/run.js')).href)

let pass = 0, fail = 0
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n + (x ? '  ' + x : '')) } else { fail++; console.log('  ✗ ' + n + '  ' + (x || '')) } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-run-'))
// 工作区里的落点也要能写（hintDir 用它）
fs.mkdirSync(path.join(tmp, '课程中心'), { recursive: true })

/**
 * ⚠️ 必须自己保证 PATH 里有 git。
 *
 * 这台机器上 git 装在 D:\Git\cmd\git.exe，**没有进系统的 PATH** ——
 * 它平时能用，只是因为启动本脚本的那个 shell 自己加过 PATH。
 * 于是第 7 组「env 整份替换」一旦把 PATH 换掉，后面所有要跑 git 的断言
 * 就集体变成「没能启动子进程：ENOENT」——7 条红，而它们跟被测代码毫无关系。
 * 这正是本项目反复踩的那种坑：**测试的脚手架问题，长得和产品 bug 一模一样**。
 * 所以这里显式把它补进 PATH，让断言不依赖外部 shell 的心情。
 */
const GIT_DIR = 'D:\\Git\\cmd'
const PATH_WITH_GIT = process.env.PATH && process.env.PATH.indexOf(GIT_DIR) >= 0
  ? process.env.PATH
  : (GIT_DIR + ';' + (process.env.PATH || ''))
process.env.PATH = PATH_WITH_GIT

console.log('\n=== 1. 能起进程并拿回 stdout / stderr（管道那条路在本机是 EPERM）===')
{
  const script = path.join(tmp, 'child.mjs')
  fs.writeFileSync(script, [
    'console.log("到标准输出")',
    'console.error("到标准错误")',
    'process.exit(7)',
  ].join('\n'), 'utf8')
  const r = C.runCaptured(process.execPath, [script], { timeout: 30000, hintDir: tmp })
  ck('没有 error（管道被拒时这里会是 EPERM）', !r.error, r.error ? String(r.error.code || r.error.message) : '')
  ck('stdout 收得到', r.stdout.indexOf('到标准输出') >= 0, JSON.stringify(r.stdout.trim()))
  ck('stderr 收得到', r.stderr.indexOf('到标准错误') >= 0, JSON.stringify(r.stderr.trim()))
  ck('【关键】非零退出码是真的（不是 null）', r.status === 7, String(r.status))
  ck('runExitCode 如实反映', C.runExitCode(r) === 7, String(C.runExitCode(r)))
  ck('runOutput 把两股输出都拼上', C.runOutput(r).indexOf('到标准输出') >= 0 && C.runOutput(r).indexOf('到标准错误') >= 0)
}

console.log('\n=== 2. 真的能把 git 跑起来并读到版本 ===')
{
  const r = C.runCaptured('git', ['--version'], { timeout: 30000, hintDir: tmp })
  ck('git 起得来', !r.error && r.status === 0, r.error ? String(r.error.code) : '')
  ck('读到了版本号（证明输出没丢）', /git version/i.test(r.stdout), r.stdout.trim())
}

console.log('\n=== 3. cwd 真的生效（子进程在指定目录里跑）===')
{
  const sub = path.join(tmp, 'sub')
  fs.mkdirSync(sub, { recursive: true })
  const script = path.join(tmp, 'pwd.mjs')
  fs.writeFileSync(script, 'console.log(process.cwd())', 'utf8')
  const r = C.runCaptured(process.execPath, [script], { cwd: sub, timeout: 30000, hintDir: tmp })
  ck('子进程的 cwd 就是传入的那个', path.resolve(r.stdout.trim()) === path.resolve(sub), r.stdout.trim())
}

console.log('\n=== 4. 起不来的可执行文件：error 必须交出来（不能只是「没有输出」）===')
{
  const r = C.runCaptured('这个可执行文件不存在-xyz', ['--version'], { timeout: 10000, hintDir: tmp })
  ck('error 有值', !!r.error, r.error ? String(r.error.code || r.error.message) : '(空)')
  ck('runExitCode 给 -1（不假装成功）', C.runExitCode(r) === -1, String(C.runExitCode(r)))
  ck('runOutput 里说清了「没能启动」而不是「（没有输出）」',
    C.runOutput(r).indexOf('没能启动') >= 0, C.runOutput(r).slice(0, 80))
}

console.log('\n=== 5. 真仓库里跑 git：init / config / status 一条龙（发布页建仓走的就是这几条）===')
{
  const repo = path.join(tmp, 'public')
  fs.mkdirSync(repo, { recursive: true })
  const g = (argv) => C.runCaptured('git', argv, { cwd: repo, timeout: 60000, hintDir: tmp })
  const init = g(['init'])
  ck('git init 成功', C.runExitCode(init) === 0, C.runOutput(init).slice(0, 100))
  const add = g(['remote', 'add', 'origin', 'https://github.com/example/demo.git'])
  ck('git remote add 成功', C.runExitCode(add) === 0, C.runOutput(add).slice(0, 100))
  const remote = g(['remote', '-v'])
  ck('能读回 remote（证明输出真的收回来了）',
    remote.stdout.indexOf('github.com/example/demo.git') >= 0, remote.stdout.trim().split('\n')[0] || '')
  const status = g(['status', '--porcelain'])
  ck('空仓库的 status 是干净的（退出码 0、无输出）',
    C.runExitCode(status) === 0 && status.stdout.trim() === '', JSON.stringify(status.stdout.trim()))
  // 失败路径也要如实：重复 add 同一个 remote 应当非零退出
  const dup = g(['remote', 'add', 'origin', 'https://github.com/example/other.git'])
  ck('重复 remote add 报非零退出（错误没有被吞掉）', C.runExitCode(dup) !== 0, String(C.runExitCode(dup)))
  ck('  且 stderr 里有 git 自己的解释', /already exists|已存在/i.test(C.runOutput(dup)), C.runOutput(dup).slice(0, 100))
}

console.log('\n=== 6. 临时文件不残留（跑一次不该在临时目录里留垃圾）===')
{
  const before = fs.readdirSync(os.tmpdir()).filter((n) => /^run-\d+-\d+/.test(n)).length
  for (let i = 0; i < 3; i++) C.runCaptured(process.execPath, ['-e', 'console.log(1)'], { timeout: 20000, hintDir: tmp })
  const after = fs.readdirSync(os.tmpdir()).filter((n) => /^run-\d+-\d+/.test(n)).length
  ck('跑 3 次后没有留下 run-*.out/.err', after === before, '前 ' + before + ' → 后 ' + after)
}

console.log('\n=== 7. env 能整份传下去（发布工具靠 CIP_WORKSPACE 才知道该发哪个工作区）===')
{
  const script = path.join(tmp, 'env.mjs')
  fs.writeFileSync(script, [
    'console.log("CIP_WORKSPACE=" + (process.env.CIP_WORKSPACE || "(空)"))',
    'console.log("PATH_SET=" + (process.env.PATH ? "yes" : "no"))',
  ].join('\n'), 'utf8')
  // 只传两个变量：证明「给了 env 就整份用它」，不是往原环境上叠。
  // 这一条重要，因为发布工具必须拿到调用方指定的 CIP_WORKSPACE，
  // 否则它会按「自己所在目录的上一层」去猜工作区 —— 猜错不报错，只是发到别处。
  const r = C.runCaptured(process.execPath, [script], {
    timeout: 30000, hintDir: tmp,
    env: { CIP_WORKSPACE: 'C:\\some\\workspace', PATH: process.env.PATH },
  })
  ck('子进程读到了传入的 CIP_WORKSPACE',
    r.stdout.indexOf('CIP_WORKSPACE=C:\\some\\workspace') >= 0, (r.stdout.trim().split('\n')[0]) || '')
  ck('宿主有、但没传的变量不在（env 是整份替换，不是叠加）',
    r.stdout.indexOf('PATH_SET=yes') >= 0, (r.stdout.trim().split('\n')[1]) || '')

  // 不传 env 时应当继承宿主环境
  const r2 = C.runCaptured(process.execPath, [script], { timeout: 30000, hintDir: tmp })
  ck('不传 env 时继承宿主环境（PATH 还在）',
    r2.stdout.indexOf('PATH_SET=yes') >= 0, (r2.stdout.trim().split('\n')[1]) || '')

  // env 整份替换之后，git 仍然要能用 —— 这正是发布工具那条路径的真实形态：
  // 调用方传一份「原环境 + CIP_WORKSPACE」，而不是把环境清空。
  const r3 = C.runCaptured(process.execPath, [script], {
    timeout: 30000, hintDir: tmp,
    env: Object.assign({}, process.env, { CIP_WORKSPACE: 'C:\\ws2' }),
  })
  ck('env = 原环境 + 一个变量时，两者都在',
    r3.stdout.indexOf('CIP_WORKSPACE=C:\\ws2') >= 0 && r3.stdout.indexOf('PATH_SET=yes') >= 0,
    (r3.stdout.trim().split('\n')[0]) || '')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exitCode = fail ? 1 : 0
