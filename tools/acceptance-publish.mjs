// 发布页的**真机验收**（只读）。
//
// 与 verify-repo.mjs 的分工：
//   verify-repo.mjs        纯函数 + 临时目录 → 验「算法对不对」
//   本脚本                  真实工作区      → 验「在这台机器上真的会显示什么」
//
// 为什么必须要有这一份：verify-repo.mjs 用的是自己造的 .git/config，
// 而老师看到的那一句人话是**真实仓库**喂出来的。真实 .git/config 里的
// url 常常带 `.git` 后缀、分支名可能是 master、owner 大小写也可能不一样 ——
// 这些差异只有拿真仓库跑才会露出来。
//
// ⚠️ 本脚本**只读**：
//   · 只调 `repo.status` 与 `version.info`（都不 spawn git、不联网、不写任何文件）
//   · 故意**不调** repo.init / audit / publish —— 它们会写盘
//     （repo.init 会 git init，audit 会在公共面留下副本）。
//     发布页的写动作在 verify-* 的临时工作区里验，不拿真工作区冒险。
//
// ⚠️ **`version.info` 只许用 `{remote:false}` 调**（第 8 节会反过来钉这一点）：
//    带 `remote:true` 会 spawn `git ls-remote` 去连 GitHub —— 那一步在
//    「连不上时整块信息为空」上是不可接受的，而且会让这个只读验收变成网络依赖。
//
// 用法：
//   node acceptance-publish.mjs                      # 用当前工作区（教师机默认）
//   node acceptance-publish.mjs <工作区>              # 指定工作区
//   node acceptance-publish.mjs <工作区> <包父目录>    # 指定插件位置
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 【测试隔离】不让宿主机器上的 ~/.dsh/cip-workspace.txt 抢走解析结果。
// 【测试隔离】解析链会读那个文件，而它是**这台机器**的真实配置 —— 在配过的机器上
// 【测试隔离】（教师机就是）它会先命中，本脚本自己的工作区反而被跳过。
// 【测试隔离】指到一个必然不存在的文件 = 把它从候选里摘掉，隔离才干净。
if (!process.env.CIP_WORKSPACE_FILE) {
  process.env.CIP_WORKSPACE_FILE = nodePath.join(nodeOs.tmpdir(), 'cip-test-no-workspace-file.txt')
}


// ⚠️ 必须用 fileURLToPath，不能自己截 import.meta.url 的 pathname：
// 工作区路径里有中文（暑期课程），pathname 会以 %E6%9A%91... 的形式给出，
// 拼出来的路径找不到文件 —— 而报错看起来像「插件没装」，很容易查错方向。
const HERE = nodePath.dirname(fileURLToPath(import.meta.url))
const WORKSPACE = nodePath.resolve(process.argv[2] || nodePath.resolve(HERE, '..', '..'))
const PACKS = process.argv[3] || nodePath.join(WORKSPACE, '课程中心', 'course-plugin')

process.env.CIP_WORKSPACE = WORKSPACE

let pass = 0, fail = 0
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) } else { fail++; console.log('  ✗ ' + name + '  ' + (extra || '')) }
}

// ── 假 ctx：插件全程只走 ctx.get('fs')，给真的实现 ──
const fsShim = {
  resolve: async (p, o) => nodePath.resolve(o && o.cwd ? o.cwd : '.', p),
  readText: async (p) => nodeFs.readFileSync(p, 'utf8'),
  writeText: async (p, c) => { throw new Error('验收脚本是只读的，不该写文件：' + p) },
  readBytes: async (p) => nodeFs.readFileSync(p),
  stat: async (p) => nodeFs.statSync(p),
  listDir: async (p) => nodeFs.readdirSync(p, { withFileTypes: true })
    .map((e) => ({ name: e.name, isDirectory: () => e.isDirectory(), isFile: () => e.isFile() })),
}
// llm 给一个「一被调用就报错」的桩：验收页面上任何一步都不该花钱。
// 真被调到就说明发布页的只读动作偷偷走了模型 —— 那就是 bug，要炸出来。
const llmStub = {
  listProviders: () => [],
  async listModels() { return [] },
  stream() { throw new Error('只读验收不该调用模型（发布页的任何一步都不花钱）') },
}

const routes = []
function makeCtx() {
  return {
    get: (n) => {
      if (n === 'fs') return fsShim
      if (n === 'llm') return llmStub
      if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) }
      return undefined
    },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
}

const entry = nodePath.join(PACKS, 'dsh-course-teacher', 'src', 'host.js')
if (!nodeFs.existsSync(entry)) { console.error('找不到教师端宿主：' + entry); process.exit(1) }
const mod = await import(pathToFileURL(entry).href)
await mod.apply(makeCtx())

const asText = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b))
function call(pathname, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      end(data) { resolve({ status: this.statusCode, headers: this.headers, body: asText(data) }) },
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = {
      url: pathname, method: payload ? 'POST' : 'GET',
      on(ev, cb) { if (ev === 'data' && payload) cb(payload); if (ev === 'end') cb(); return req },
      destroy() { },
    }
    for (const r of routes) {
      if (pathname.startsWith(r.path)) {
        // ⚠️ handler 抛错必须走这里，否则 Promise 悬着，脚本会静默挂住而不是报错。
        Promise.resolve(r.handler(req, res)).catch((e) => {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'handler 抛错：' + ((e && e.message) || e) }))
        })
        return
      }
    }
    resolve({ status: -1, headers: {}, body: '没有匹配的路由：' + pathname })
  })
}
async function api(action, body) {
  const r = await call('/cip-tea-api/' + action, body || {})
  let json = null
  try { json = JSON.parse(r.body) } catch (e) { }
  return { status: r.status, raw: r.body, json }
}

console.log('工作区：' + WORKSPACE)
console.log('插件：  ' + entry)

// ── 1. 真仓库的状态卡文案 ────────────────────────────────────
console.log('\n=== 1. 状态卡：两个真仓库各说了一句什么人话 ===')
const st = await api('repo.status')
ck('repo.status 返回 200', st.status === 200, 'HTTP ' + st.status)
if (st.status !== 200 || !st.json) {
  console.log('  原始返回：' + st.raw.slice(0, 400))
  console.log('\n通过 ' + pass + ' 项，失败 ' + (fail + 1) + ' 项')
  process.exit(1)
}
const rs = st.json
const pub = rs.publicRepo || {}
const priv = rs.privateRepo || {}
const pubSum = (pub.summary && pub.summary.text) || ''
const privSum = (priv.summary && priv.summary.text) || ''

ck('公开仓那句人话里有 owner/name', pubSum.indexOf('/') > 0, pubSum)
ck('公开仓那句人话里有「分支」而不是 ahead/behind',
  pubSum.indexOf('分支') >= 0 && !/\bahead\b|\bbehind\b/.test(pubSum), pubSum)
ck('公开仓认出了是 git 仓库', pub.hasRepo === true)
ck('公开仓 remote 指向 GitHub', !!pub.remote && String(pub.remote).indexOf('github.com') >= 0, String(pub.remote || ''))
ck('私有仓那句人话里带 -privated（验收清单要求）',
  privSum.indexOf('-privated') >= 0, privSum)

// 验收清单点名的两句：必须是「已连到 X，分支 main」的形状
console.log('    公开仓 → ' + pubSum)
console.log('    私有仓 → ' + privSum)

// ── 2. 建仓卡的默认值 ────────────────────────────────────────
console.log('\n=== 2. 建仓卡：默认值与 token 的边界 ===')
ck('给了 slug（仓名默认值不能是空的）', !!rs.slug, rs.slug)
ck('resolved.name 有值（Token 框旁边那几个默认值）', !!rs.resolved.name, JSON.stringify(rs.resolved))
ck('resolved.privateName 以 -privated 结尾（约定要守住）',
  /-privated$/.test(rs.resolved.privateName || ''), rs.resolved.privateName)
ck('分支名有值', !!rs.resolved.branch, rs.resolved.branch)

// 验收清单第 4 条：脱敏。整个返回对象序列化后不能出现任何 token 形状。
// 这里同时查两种：真实的 gh 前缀，以及「带凭据的 URL」这个形状本身
// （后者更重要 —— 老师自己的 token 不是 ghp_ 开头也一样危险）。
const blob = JSON.stringify(rs)
ck('【硬要求】返回对象里没有任何 ghp_/github_pat_ 形状的 token',
  !/gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/.test(blob))
ck('【硬要求】返回对象里没有「凭据@主机」形状的 URL',
  !/\/\/[^/\s@:]+:[^/\s@]+@/.test(blob))
ck('publicRepo.remote 不含凭据', !/\/\/[^/\s@:]+:[^/\s@]+@/.test(String(pub.remote || '')), String(pub.remote || ''))

// ── 3. 手动步骤（折叠块）────────��──────────────────────────
console.log('\n=== 3.「看两条手动步骤」折叠块：内容能不能照抄 ===')
const manual = String(rs.manual || '')
ck('折叠块有内容（不能是空的）', manual.length > 20, manual.length + ' 字符')
ck('里面有 git init', manual.indexOf('git init') >= 0)
ck('里面有 git remote add origin', manual.indexOf('git remote add origin') >= 0)
ck('里面有 git push', manual.indexOf('git push') >= 0)
ck('公开仓与私有仓两个名字都在', manual.indexOf(rs.resolved.name) >= 0 && manual.indexOf(rs.resolved.privateName) >= 0)
ck('没有 <你的仓库> 这种占位符（占位符等于没给）', manual.indexOf('<你的仓库>') < 0)
ck('【脱敏】手动步骤里也没有 token', !/gh[pousr]_[A-Za-z0-9]{10,}/.test(manual))

// ── 4. 推送命令常驻 ──────────────────────────────────────────
console.log('\n=== 4. 推送命令（常驻显示，不是跑完发布才出现）===')
const next = Array.isArray(rs.next) ? rs.next : []
ck('next 有内容', next.length > 0, next.length + ' 条')
ck('第一条是 cd 到公开仓工作区的绝对路径',
  next.length > 0 && /^cd "/.test(next[0]) && next[0].indexOf(WORKSPACE) >= 0, next[0] || '')
ck('有 git push -u origin <分支>', next.some((l) => /^git push -u origin /.test(l)), next[next.length - 1] || '')
ck('【脱敏】常驻的这组命令里不含 token（带 token 的那条只在 repo.init 里现拼）',
  !/gh[pousr]_[A-Za-z0-9]{10,}/.test(next.join('\n')))

// ── 5. 发布清单 ──────────────────────────────────────────────
console.log('\n=== 5. 发布清单 ===')
ck('manifestReady 是布尔（不是 undefined）', typeof rs.manifestReady === 'boolean', String(rs.manifestReady))
ck('给出了清单路径', !!rs.manifestPath, rs.manifestPath)

// ── 6. 发布动作真的能跑（这一步验的是「插件能不能起子进程」）──
// 为什么必须有这一条：DSH 沙箱不给管道，`spawnSync(..., {encoding:'utf8'})`
// 一律 EPERM —— 而它**不抛异常**，返回 {status:null, error:EPERM, stdout:''}。
// 于是「发布」按钮会静默变成「（没有输出）」，而真正的原因是环境限制。
// 所以这里真的把发布工具跑一遍（`check` 模式**只读**，不写任何文件）。
console.log('\n=== 6. 发布动作：插件能不能真的起子进程并拿回输出 ===')
{
  const pub = await api('publish', { mode: 'check' })
  ck('publish(check) 返回 200', pub.status === 200, 'HTTP ' + pub.status)
  const pr = pub.json || {}
  ck('发布工具真的跑起来了（不是「没能启动子进程」）',
    String(pr.output || '').indexOf('没能启动') < 0, String(pr.output || '').slice(0, 120).replace(/\n/g, ' '))
  ck('退出码是真实数字（EPERM 那条路会给 null）',
    typeof pr.exit === 'number', String(pr.exit))
  ck('check 模式跑成功', pr.ok === true, 'exit=' + pr.exit)
  ck('输出里有内容（证明 stdout 真的被收回来了）',
    String(pr.output || '').trim().length > 20, String(pr.output || '').trim().length + ' 字符')
}

// ── 7. 反向验收：换一门课的形状，界面该跟着变（L1 真的生效）──
// 验收清单第 3 条。做法上刻意**不动真工作区的 课程配置.json**：
// 它是被 git 跟踪的文件，改它等于给老师留一份未提交的改动，
// 而这一页又正好是「发布」页 —— 验收过程本身不该污染待发布的内容。
//
// 改用 CIP_COURSE_DIR 指一个**临时课程目录**，共享内容（课程中心/、结构索引）
// 放在它的父目录 —— 这正是设计文档里「多门课」的真实形态，
// 也走的是老师选文件夹后同一条解析路径（resolveWorkspace → readCourseConfig）。
//
// ⚠️ 踩过的坑：夹具必须让**共享内容在课程目录的上一层**。
//    解析器判定工作区的依据是「该目录里有 课程中心/课程结构索引.json」
//    （见 looksLikeWorkspace 的注释）。一开始把 课程配置.json 放进一个
//    光秃秃的临时目录，它就既不是工作区、上层也没有课程中心，
//    于是 CIP_COURSE_DIR 被跳过、静默回落到真工作区 ——
//    表现为 6 条断言全红，看起来像「L1 没生效」，其实是夹具造错了。
//    这个坑值得写下来：**它长得和真 bug 一模一样。**
console.log('\n=== 7. 反向验收：换一门课只改 课程配置.json（L1 是否真的生效）===')
{
  const realCfg = nodePath.join(WORKSPACE, '课程配置.json')
  const realCfgBefore = nodeFs.existsSync(realCfg) ? nodeFs.readFileSync(realCfg, 'utf8') : null

  const tmpRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cip-acc-'))
  // 共享内容层：拷贝真索引（只读用途），让这个临时根成为一个「像工作区」的目录
  nodeFs.mkdirSync(nodePath.join(tmpRoot, '课程中心'), { recursive: true })
  const realIndex = nodePath.join(WORKSPACE, '课程中心', '课程结构索引.json')
  if (nodeFs.existsSync(realIndex)) {
    nodeFs.copyFileSync(realIndex, nodePath.join(tmpRoot, '课程中心', '课程结构索引.json'))
  } else {
    nodeFs.writeFileSync(nodePath.join(tmpRoot, '课程中心', '课程结构索引.json'), '{}', 'utf8')
  }
  // 根目录也放一份配置：**故意与课程目录那份不同**，
  // 这样「课程目录的配置优先」这条才真的被测到（否则两份一样，测了等于没测）。
  nodeFs.writeFileSync(nodePath.join(tmpRoot, '课程配置.json'),
    JSON.stringify({ title: '根目录那份（不该生效）', code: 'ROOT' }), 'utf8')

  // 另一门形状完全不同的课：讲次 / 讲稿 / 答疑 / 作业 / 不同章节与词表
  const tmpCourse = nodePath.join(tmpRoot, '课程', 'DS01')
  nodeFs.mkdirSync(tmpCourse, { recursive: true })
  nodeFs.writeFileSync(nodePath.join(tmpCourse, '课程配置.json'), JSON.stringify({
    title: '数据结构', code: 'DS01',
    layout: {
      chapters: ['绪论', '线性表'], modules: ['第一部分'],
      planDir: '讲稿', questionsRel: '答疑', submitRel: '作业',
    },
    topics: ['复杂度分析', '指针与内存'],
    issueTypes: ['概念不清'],
  }, null, 2), 'utf8')

  const beforeWS = process.env.CIP_WORKSPACE
  const beforeDir = process.env.CIP_COURSE_DIR
  process.env.CIP_COURSE_DIR = tmpCourse
  try {
    // 重新 apply 一次（不能复用上面那个实例：工作区是 createCore 现算的，
    // 而已经挂载的实例还指向真工作区）。加 ?acc=2 是为了绕开模块缓存。
    const mod2 = await import(pathToFileURL(entry).href + '?acc=2')
    const routes2 = []
    const ctx2 = makeCtx()
    ctx2.webServer = { register: (r) => { routes2.push(r); return () => {} } }
    await mod2.apply(ctx2)
    const call2 = (pathname, body) => new Promise((resolve) => {
      const res = {
        statusCode: 0, headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = v },
        end(data) { resolve({ status: this.statusCode, body: asText(data) }) },
      }
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
      const req = {
        url: pathname, method: payload ? 'POST' : 'GET',
        on(ev, cb) { if (ev === 'data' && payload) cb(payload); if (ev === 'end') cb(); return req },
        destroy() { },
      }
      for (const r of routes2) {
        if (pathname.startsWith(r.path)) {
          Promise.resolve(r.handler(req, res)).catch((e) => {
            res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message) }))
          })
          return
        }
      }
      resolve({ status: -1, body: '没有匹配的路由' })
    })
    const info = JSON.parse((await call2('/cip-tea-api/info')).body)
    const lay = info.layout || {}
    console.log('    课程        → ' + info.course.title + '（' + info.course.code + '）')
    console.log('    章节        → ' + (lay.chapters || []).join('、'))
    console.log('    教案目录    → ' + lay.planDir + '　问题池 → ' + info.publicDir + '　提交 → ' + info.submitDir)
    console.log('    知识领域词表 → ' + ((info.defaults && info.defaults.topics) || []).join('、'))

    ck('先确认真的切到了那门临时课（否则下面几条测的是真工作区）',
      info.course.title === '数据结构', info.course.title)
    ck('课程码跟着配置走', info.course.code === 'DS01', info.course.code)
    ck('课程目录那份配置**优先于**根目录那份（两份不同才测得到）',
      info.course.title !== '根目录那份（不该生效）', info.course.title)
    ck('【验收清单点名】章节名跟着变（不再是写死的 第一章..三）',
      JSON.stringify(lay.chapters) === JSON.stringify(['绪论', '线性表']),
      (lay.chapters || []).join('、'))
    ck('【验收清单点名】目录名跟着变：教案目录 → 讲稿', lay.planDir === '讲稿', lay.planDir)
    ck('问题池目录也跟着变', info.publicDir === '答疑\\公共', info.publicDir)
    ck('提交目录也跟着变', info.submitDir === '作业', info.submitDir)
    ck('知识领域词表跟着变（否则会拿「视觉任务」分类一门文学课）',
      JSON.stringify(info.defaults.topics) === JSON.stringify(['复杂度分析', '指针与内存']),
      ((info.defaults && info.defaults.topics) || []).join('、'))
    ck('没配的项仍回落到默认值（老工作区零改动的保证）',
      JSON.stringify(info.defaults.planSections) === JSON.stringify(['目标', '推导', '实操', '验收标准', '当堂交付物']))
  } finally {
    if (beforeWS === undefined) delete process.env.CIP_WORKSPACE
    else process.env.CIP_WORKSPACE = beforeWS
    if (beforeDir === undefined) delete process.env.CIP_COURSE_DIR
    else process.env.CIP_COURSE_DIR = beforeDir
    nodeFs.rmSync(tmpRoot, { recursive: true, force: true })
  }

  // 反向验收最容易被忽略的一条：**验收过程本身有没有留下副作用**。
  // 发布页的验收尤其要查这个 —— 真配置被改了，老师下次发布就会带上别人的课程名。
  const realCfgAfter = nodeFs.existsSync(realCfg) ? nodeFs.readFileSync(realCfg, 'utf8') : null
  ck('【零副作用】真工作区的 课程配置.json 一个字节都没动',
    realCfgBefore === realCfgAfter, realCfgBefore === null ? '（原本就没有这个文件）' : (realCfgAfter || '').length + ' 字节')
}

// ══════════════════════════════════════════════════════════════════════════
// 8. 版本卡（老师要照抄给学生的克隆命令）—— 真机、真仓库、只读
// ══════════════════════════════════════════════════════════════════════════
//
// 为什么单独一节：这条命令是**要发到班级群里的**。它错了不会报错 ——
// 学生 clone 到旧版本，症状只是面板里几个动作「未知」。
//
// 这一节同时钉住两件上一轮踩过的事：
//   ① 版本信息**不许**并进 `repo.status`（那个动作是纯读盘的，被拖成网络依赖后
//      本脚本立刻打红：连不上 GitHub 时整块状态都空了）；
//   ② 版本信息自己**默认也不许联网** —— 打开这一页看一眼版本，不该等一次 git。
console.log('\n=== 8. 版本卡：这条命令能不能照抄，以及它联不联网 ===')
const ver = await api('version.info', { remote: false })
ck('version.info 返回 200（动作存在且参数可解析）', ver.status === 200, 'HTTP ' + ver.status)
const vj = ver.json || {}
const vpub = vj.public || {}
const vws = vj.workspace || {}
const verBlob = JSON.stringify(vj)
ck('公开仓的版本字段形状齐（hasRepo / commit / cloneCommand）',
  typeof vpub.hasRepo === 'boolean' && typeof vpub.commit === 'string' && typeof vpub.cloneCommand === 'string',
  JSON.stringify({ hasRepo: vpub.hasRepo, commit: vpub.commit, refKind: vpub.refKind }))
ck('课程工作区也报了一份（老师要能看出自己改的有没有发出去）',
  typeof vws.hasRepo === 'boolean' && typeof vj.workspaceSummary === 'string', vj.workspaceSummary)
ck('两句摘要都不是空的（退化情况下也要有话说）',
  String(vj.publicSummary || '').length > 0 && String(vj.workspaceSummary || '').length > 0,
  vj.publicSummary)
// ★ 本节的核心断言：**命令原文必须能对得上真仓库**。
//   只断言「有个 cloneCommand 字段」是假绿 —— 字段在、内容是空的也照样过。
if (vpub.hasRepo && vpub.remoteName) {
  ck('【核心】给的克隆命令与真仓库的 remote 对得上（老师照抄的这一条）',
    vpub.cloneCommand.indexOf(vpub.remoteName) === 0
    || vpub.cloneCommand === ('git clone ' + vpub.remoteName + (vpub.tag ? (' --branch ' + vpub.tag) : '')),
    vpub.cloneCommand)
  ck('  命令以 git clone 开头', /^git clone /.test(vpub.cloneCommand), vpub.cloneCommand)
  ck('  有 tag 时必须带 --branch（否则学生拿到的不是那个版本）',
    !vpub.tag || vpub.cloneCommand.indexOf('--branch ' + vpub.tag) > 0, vpub.cloneCommand)
} else {
  ck('【核心】公开仓还没准备好时，说的是实话而不是编一条命令',
    vpub.cloneCommand === '' && (!!vpub.note || !!vj.verdict), vpub.note || (vj.verdict && vj.verdict.text))
}
// ★ 反向断言：这一条才是「离线可用」的判据。
//   `note === '未与远端比对'` 只在**真的没去连远端**时才会被写出来
//   （见 core/src/version.js：只有 remote 存在 + branch 存在 + withRemote!==false 才走这条）。
//   换句话说：如果实现改回默认联网，这条断言会红 —— 它能证伪。
ck('【核心】默认这一档**不许联网**：没去比对远端（remoteChecked=false 且明说「未与远端比对」）',
  vpub.remoteChecked === false && vpub.note === '未与远端比对',
  'remoteChecked=' + vpub.remoteChecked + ' note=' + vpub.note)

// ★ 老师点「和 GitHub 比一下」的那一档：这一步是真的联网（spawn git ls-remote）。
//   为什么要在**只读**验收里也跑一次：它是界面上唯一会联网的按钮，
//   而「动作收到了 remote 但没往下传」这种错**只在这一档才现形** ——
//   错了的表现正是那句「连不上 GitHub，没法替你确认」，
//   而老师会以为是自己网不好。不跑这一档，就等于没验过那个按钮。
//   它只读（ls-remote 不改任何东西、不写盘），所以放这里不违反只读约定。
//
// ⚠️ 但「连不上 github.com」在这台机器上是**常态**（见交接文档：Connection was reset）。
//    所以这一档拆成两半：
//      · **一定**验的：`compare` 必须跟着入参变成 true。这是**代码路径**判断，
//        与网络无关 —— 「动作收到了 remote 但没往下传」这个真 bug 就死在这里；
//      · 只有网络通时才验的：真读到远端 SHA、并给出结论。网不通时**如实跳过并打印**，
//        不算失败。理由：一条会随网络时红时绿的断言等于没有断言 ——
//        它逼着人「为了让它变绿」去放宽别的东西（纪律 4 要防的正是这个）。
if (vpub.hasRepo && vpub.remoteName) {
  const cmp = await api('version.info', { remote: true })
  const cj = cmp.json || {}
  const cp = cj.public || {}
  ck('【核心】点「和 GitHub 比一下」走的是联网那一档（compare 跟着入参变 true）',
    cmp.status === 200 && cj.compare === true,
    'compare=' + cj.compare + ' remoteChecked=' + cp.remoteChecked + ' note=' + JSON.stringify(cp.note))
  if (cp.remoteChecked === true) {
    ck('  比完之后给出了结论（不许还是「没查过」那一档）',
      !!cj.verdict && ['ok', 'warn'].indexOf(cj.verdict.level) >= 0,
      cj.verdict ? (cj.verdict.level + '：' + cj.verdict.text) : 'verdict 缺失')
    ck('  远端 SHA 被读回来了（比对是真做了，不是只翻了个布尔）',
      /^[0-9a-f]{7,40}$/.test(String(cp.remoteCommit || '')), String(cp.remoteCommit || '').slice(0, 12))
    ck('  联网那一档也不含 token（判据落在整个返回值上）',
      !/gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/.test(JSON.stringify(cj))
      && !/\/\/[^/\s@:]+:[^/\s@]+@/.test(JSON.stringify(cj)))
  } else {
    console.log('  · 跳过 3 项：这台机器现在连不上 GitHub（note=' + JSON.stringify(cp.note) + '）。'
      + 'compare 那一半已经验过了；联网这一半等网络好时再跑一次。')
  }
} else {
  ck('【核心】公开仓没准备好时不去联网（也没什么可比）', true)
}

// 脱敏：判据落在**整个返回值**上（同第 1 节那条纪律，而不是只查某一个字段）
ck('【硬要求】版本信息里没有 token / 凭据 URL',
  !/gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}/.test(verBlob)
  && !/\/\/[^/\s@:]+:[^/\s@]+@/.test(verBlob))

// 上一轮那次打红的现场：版本信息**不许**出现在 repo.status 里。
// 只查字段名不够 —— versionInfo 会 spawn git，慢与脆是从行为上来的。
// 所以这里查的是「repo.status 的返回里根本没有版本那一组字段」，
// 界面要版本就得走 version.info（界面上也是独立一块，见 verify-clients 12c-2）。
ck('【不许回退】repo.status 的返回里没有混进版本信息（它必须保持纯读盘）',
  rs.publicVersion === undefined && rs.workspaceVersion === undefined && rs.version === undefined
  && rs.versionSummary === undefined,
  Object.keys(rs).filter((k) => /version/i.test(k)).join(',') || '干净')

// ── 7 收尾 ──
console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exitCode = fail ? 1 : 0
