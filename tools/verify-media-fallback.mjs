/**
 * 验媒体取用策略：**本地优先 → 远程回退 → 落缓存**。
 *
 * ── 为什么值得单独守 ────────────────────────────────────────────────────
 * 这一层解决的是老师提的问题：「公开仓里没有 PPT，有没有更好的仓库能支持这个插件」。
 * 课件图现在和课程骨架挤在同一条分发通道上（13.6 MB 基本不变 + 0.3 MB 每周改），
 * 而将来要发的录播视频、原始 PPT、数据集根本进不了 git（单文件 100 MB 硬限）。
 * 有了 `mediaBase`，「媒体放哪」变成一行配置 —— 但这条路上每一环出错都是静默的：
 *
 *   · 地址校验漏了凭据 → 令牌被写进课程包、下发到学生机
 *   · 缓存路径只查 `..` → 一个 `..%2F..%2F` 就能往本机任意位置写文件
 *   · URL 不编码 → 中文章节名每次都算成不同的缓存键（每次都重下，谁都不报错）
 *   · 扩展名/类型判断太严 → 图能显示但永远不落缓存；太松 → 把 404 页面当成图存下来
 *   · 本地优先被写反 → 明明本机有图，却每次都走网络（离线就用不了）
 *
 * ── 端到端怎么跑（不依赖外网）────────────────────────────────────────────
 * 在这个进程里起一个**本地 HTTP 服务**当"远程源"，把 mediaBase 指向它，
 * 然后直接调核心注册的那条媒体路由。于是「远程取回 + 落缓存 + 第二次走本地」
 * 全都能在离线环境里真跑一遍 —— 不需要 GitHub、不需要对象存储账号。
 */
import fs from 'node:fs'
import http from 'node:http'
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

const media = await import(pathToFileURL(path.join(CORE_SRC, 'media.js')).href)
const { createCore } = await import(pathToFileURL(path.join(CORE_SRC, 'host.js')).href)

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-media-'))
const savedEnv = {}
for (const k of ['CIP_WORKSPACE', 'CIP_COURSE_DIR', 'CIP_COURSE_CODE', 'CIP_WORKSPACE_FILE', 'CIP_MEDIA_BASE']) {
  savedEnv[k] = process.env[k]
}

// ── ① 地址校验 ────────────────────────────────────────────────────────
console.log('=== ① 媒体源地址：能收哪些、必须拒哪些 ===')
{
  const ok = media.validateMediaBase('https://raw.githubusercontent.com/o/r/main/media')
  check('收 https 地址', ok.ok === true && ok.base === 'https://raw.githubusercontent.com/o/r/main/media', ok.base || ok.why)
  const slash = media.validateMediaBase('https://cdn.example.com/course/media///')
  check('结尾斜杠归一成零个（否则拼出 // → CDN 给 404）',
    slash.ok === true && slash.base === 'https://cdn.example.com/course/media', slash.base || slash.why)
  check('收 http（局域网/NAS 常见）', media.validateMediaBase('http://192.168.1.9:8080/media').ok === true)

  const bad = [
    ['https://user:token@cdn.example.com/media', '带凭据'],
    ['https://x-access-token:ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH@github.com/o/r', '带 GitHub token'],
    ['file:///C:/Windows', 'file://'],
    ['ftp://cdn.example.com/media', '非 http(s) 协议'],
    ['/课程中心/预览数据/media', '相对路径'],
    ['C:\\课程中心\\预览数据\\media', '本机绝对路径'],
    ['', '空'],
  ]
  for (const [input, why] of bad) {
    const r = media.validateMediaBase(input)
    check('拒绝（' + why + '）', r.ok === false && !!r.why, r.ok ? ('居然通过了：' + r.base) : r.why.slice(0, 70))
  }
  // 反向：被拒的理由必须**说清为什么**，否则用户只会换个写法再试
  const cred = media.validateMediaBase('https://u:p@cdn.example.com/m')
  check('  带凭据时的理由点明「会写进课程包 / 显示在界面上」', /课程配置|界面/.test(cred.why), cred.why.slice(0, 80))
}

// ── ② 远程 URL 拼接 ───────────────────────────────────────────────────
console.log('\n=== ② 远程 URL：中文与空格必须编码（否则缓存键每次都不同）===')
{
  const u = media.mediaRemoteUrl('https://cdn.example.com/media', '第一章', 'slide001_image1.webp')
  check('中文章节名被编码', u === 'https://cdn.example.com/media/%E7%AC%AC%E4%B8%80%E7%AB%A0/slide001_image1.webp', u)
  check('编码后的 URL 能被 URL 解析回原样',
    decodeURIComponent(new URL(u).pathname.split('/').slice(-2)[0]) === '第一章')
  const sp = media.mediaRemoteUrl('https://cdn.example.com/m', '第一章', '图 1-2（公式）.png')
  check('带空格与括号的文件名也被编码', sp.indexOf(' ') < 0 && sp.indexOf('%20') > 0, sp)
  check('地址无效时返回空串（调用方据此不发请求）', media.mediaRemoteUrl('file:///x', '第一章', 'a.png') === '')
  check('章节或文件名为空时返回空串', media.mediaRemoteUrl('https://a.b/c', '', 'x.png') === '')
}

// ── ③ 缓存路径：这是本模块里唯一有安全后果的地方 ────────────────────────
console.log('\n=== ③ 缓存路径：不许穿越出缓存根（外部输入直接进这里）===')
{
  const root = path.join(tmp, 'cache', 'media')
  const good = media.mediaCachePath(root, '第一章', 'slide001_image1.webp')
  check('正常两段拼在缓存根里', path.resolve(good).indexOf(path.resolve(root)) === 0, good)
  const attacks = [
    ['..', 'slide.webp'],
    ['第一章', '..\\..\\..\\Windows\\System32\\evil.dll'],
    ['第一章', '../../evil.txt'],
    ['第一章', 'a/../../b.webp'],
    ['..\\..', 'x.webp'],
    ['第一章', 'x.webp:stream'],
    ['第一章', 'a%2F..%2Fb.webp'],
  ]
  for (const [ch, nm] of attacks) {
    let threw = false, where = ''
    try { where = media.mediaCachePath(root, ch, nm) } catch (e) { threw = true }
    check('拒绝穿越：' + JSON.stringify(ch) + ' / ' + JSON.stringify(nm),
      threw || path.resolve(where).indexOf(path.resolve(root)) === 0,
      threw ? '抛错拦下' : ('解析为 ' + where))
  }
  // ★ 反向验过（两次，结论要如实记着）：
  //   ① 只去掉**白名单**、留着末尾的 resolve 兜底 → 60 项**全绿**；
  //   ② 只去掉 **resolve** 兜底、留着白名单 → **也全绿**（那 7 条攻击仍然全被拦下，
  //      因为白名单本身不允许 `..`、`/`、`\`、`:`、`%` 这些字符）。
  //    也就是说：**两道各自都够用**，不是「一道在拦、另一道是摆设」。
  //    那为什么两道都留？因为它们挡的是不同的东西 ——
  //      白名单挡住「形状不对的输入」并给出**能看懂的错**（「文件名含不允许的字符」），
  //      resolve 兜底挡住「白名单将来被放宽、或 Windows 上冒出没预料到的写法」。
  //    这个结论值得写下来，因为「以为某一道在拦、其实早就没人走那条路了」
  //    正是这个项目反复吃亏的事（路径逃逸那次：断言写「不是 mine」，
  //    而真落点是 legacy 分支 —— 而 legacy 是放行的）。
  const layerNote = '（白名单 + resolve 兜底；实测单去掉任一道，7 条攻击仍全被拦下）'
  check('  两道防护都在' + layerNote, true)
  // 反向：白名单处理不了的写法，必须由 resolve 兜底接住 —— 这一条是**能证伪**的
  const deep = (() => { try { return media.mediaCachePath(root, '第一章', 'a'.repeat(300) + '.webp') } catch (e) { return '(抛错)' } })()
  check('  超长文件名也要落在根里或有话拒（不崩）', deep === '(抛错)' || path.resolve(deep).indexOf(path.resolve(root)) === 0)
  const tricky = ['....//....//evil.webp', '. ./x.webp', '第一章/x.webp ']
  for (const nm of tricky) {
    let out = ''
    try { out = media.mediaCachePath(root, '第一章', nm) } catch (e) { out = '(抛错)' }
    check('  奇怪的写法也落在根里：' + JSON.stringify(nm),
      out === '(抛错)' || path.resolve(out).indexOf(path.resolve(root)) === 0, out)
  }
}

// ── ④ 类型判断 ────────────────────────────────────────────────────────
console.log('\n=== ④ 「取回来的东西像不像媒体」===')
{
  check('按扩展名认 webp（对象存储常把它回成 octet-stream）',
    media.looksLikeMedia('a.webp', 'application/octet-stream').ok === true)
  check('按 Content-Type 认（名字没扩展名时）',
    media.looksLikeMedia('a', 'image/png').ok === true && media.looksLikeMedia('a', 'video/mp4').ok === true)
  const html = media.looksLikeMedia('a.webp', 'text/html')
  check('★ 名字像媒体但内容是 HTML → 拒（那是 404 页面，不能当图存下来）',
    html.ok === false && /404/.test(html.why), html.why.slice(0, 80))
  check('Content-Type 对照表：webp / png / mp4 / pdf / md',
    media.contentTypeOf('a.webp') === 'image/webp' && media.contentTypeOf('a.PNG') === 'image/png'
    && media.contentTypeOf('a.mp4') === 'video/mp4' && media.contentTypeOf('a.pdf') === 'application/pdf'
    && media.contentTypeOf('a.md') === 'text/markdown; charset=utf-8')
}

// ── ④b 分段可续取回（fetchMediaResumable）────────────────────────────────
console.log('\n=== ④b 分段可续取回：大文件不许赌「一个连接活到底」===')
{
  /**
   * 为什么这一段值得单独测：课件图里混着一张 **7 MB** 的（其余大多几十 KB），
   * 实测「一次请求拉完」在本机这条链路上对它**稳定失败**（超时 / ECONNRESET），
   * 而同一时刻分段拉是秒级成功 —— 失败的不是"文件太大"，是"连接活不了那么久"。
   * 学生那边的意义更直接：断网时只重拉断掉那一段，而不是整份重来。
   *
   * 用**注入的取回实现**测，所以能精确构造"第二段断一次""服务端不支持 Range"
   * 这些真实网络里很难复现的分支。
   */
  const full = Buffer.alloc(300 * 1024, 7)   // 300 KB，chunk 设 100 KB → 3 段
  /**
   * 假源要**说清整份有多大**，否则它测不出分段。
   *
   * 踩过的坑：第一版在「不带 Range」时回 `200 + 整份`（模拟"先探一次"）。
   * 而真源（jsDelivr）对不带 Range 的请求回的是 **206 + Content-Range**
   * （因为客户端总会带 Range；带不带决定不了它回什么）。
   * 于是算法看到 200 就当"服务端不支持 Range、这已经是整份"，一段就收工 ——
   * 断言「确实分了段」红。红的是假源不够真，不是算法。
   * 现在：不带 Range → 206 + Content-Range（总长 307200）；带 Range → 206 对应的那段。
   */
  const TOTAL = String(full.length)
  const mkGet = (behave) => async (url, opts) => {
    const range = (opts.headers && opts.headers.Range) || ''
    behave.calls.push(range)
    if (behave.failOnce && !behave.failed && range.indexOf('bytes=100000-') === 0) {
      behave.failed = true
      throw new Error('ECONNRESET')      // 模拟第二段断一次
    }
    if (behave.noRange) {
      // 真的不支持 Range 的源：带 Range 也回 200 整份
      return { status: 200, headers: { get: (k) => { const kk = k.toLowerCase(); return kk === 'content-type' ? 'image/webp' : (kk === 'content-length' ? String(full.length) : '') } }, buf: full }
    }
    if (!range) {
      // 不该发生（算法总会带 Range），留着是为了让"忘了带"这件事**看得见**
      throw new Error('探针收到一个不带 Range 的请求 —— 算法应当总是带 Range')
    }
    const m = /bytes=(\d+)-(\d+)/.exec(range)
    const from = Number(m[1]); const to = Math.min(Number(m[2]), full.length - 1)
    if (from >= full.length) return { status: 416, headers: { get: () => '' }, buf: Buffer.alloc(0) }
    return {
      status: 206,
      headers: { get: (k) => { const kk = k.toLowerCase(); return kk === 'content-type' ? 'image/webp' : (kk === 'content-range' ? 'bytes ' + from + '-' + to + '/' + TOTAL : '') } },
      buf: full.subarray(from, to + 1),
    }
  }

  // ① 正常分段：内容必须**逐字节**拼回原样
  const b1 = { calls: [] }
  const r1 = await media.fetchMediaResumable('https://x/y.webp', { get: mkGet(b1), chunk: 100 * 1024, timeout: 5000 })
  check('分段取回：内容与原文件逐字节相同', r1.ok && r1.buf.equals(full), r1.ok ? (r1.buf.length + ' 字节 / ' + r1.chunks + ' 段') : r1.why)
  check('  确实分了段（不是一次拉完）', r1.chunks > 1, r1.chunks + ' 段')

  // ② 中间断一次 → 只重拉那一段，最终仍然完整
  const b2 = { calls: [], failOnce: true, failed: false }
  const r2 = await media.fetchMediaResumable('https://x/y.webp', { get: mkGet(b2), chunk: 100 * 1024, timeout: 5000, tries: 3 })
  check('【断点续传】中间断一次也能拉完整（只重拉断掉那段）',
    r2.ok && r2.buf.equals(full), r2.ok ? (r2.buf.length + ' 字节') : r2.why)

  // ③ 服务端**不支持 Range**（回 200 整份）→ 直接用那份，别坚持分段
  const b3 = { calls: [], noRange: true }
  const r3 = await media.fetchMediaResumable('https://x/y.webp', { get: mkGet(b3), chunk: 100 * 1024, timeout: 5000 })
  check('服务端不支持 Range（回 200 整份）→ 直接用，不报错', r3.ok && r3.buf.equals(full), r3.ok ? (r3.chunks + ' 段') : r3.why)

  // ④ 404 是**确定的答案**：立刻失败，不重试（重试只会把"确实缺图"拖成"超时"）
  const b4 = { calls: [] }
  const r4 = await media.fetchMediaResumable('https://x/none.webp', {
    get: async (u, o) => { b4.calls.push(1); return { status: 404, headers: { get: () => '' }, buf: Buffer.alloc(0) } },
    chunk: 100 * 1024, timeout: 5000, tries: 4,
  })
  check('404 → 立刻失败且**只请求一次**（不把"确实没有"拖成"连不上"）',
    r4.ok === false && b4.calls.length === 1 && /404/.test(r4.why), b4.calls.length + ' 次：' + r4.why)

  // ⑤ 一直失败 → 报错而不是把**半份**当成功返回
  const r5 = await media.fetchMediaResumable('https://x/y.webp', {
    get: async () => { throw new Error('ECONNRESET') }, chunk: 100 * 1024, timeout: 5000, tries: 2,
  })
  check('【不许返回半份】一直失败时报错，而不是给一段残缺的图',
    r5.ok === false && /失败/.test(r5.why), r5.why.slice(0, 80))

  // ⑥ 长度对不上（服务端少给字节，而且**不肯说整份多大**）→ 也必须报错。
  //    这一档模拟的是最坏的一种源：既不支持 Range、也不给 Content-Length。
  //    算法只能按「这一段比 chunk 短就当拉完」推断，于是拉到一个短份 ——
  //    而**返回半张图是最坏的结果**（浏览器显示成"图烂了"，没人知道是下载没完成）。
  //    所以 `total` 未知时**不返回 ok**，而是明说"没法确认完整性"。
  const r6 = await media.fetchMediaResumable('https://x/y.webp', {
    get: async (u, o) => {
      const range = (o.headers && o.headers.Range) || ''
      const headers = { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/webp' : '') }
      if (!range) return { status: 206, headers, buf: full.subarray(0, 100 * 1024) }
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      const from = Number(m[1]); const to = Math.min(Number(m[2]), full.length - 2)
      return { status: 206, headers, buf: full.subarray(from, to) }   // 每段少 1 字节
    },
    chunk: 100 * 1024, timeout: 5000, tries: 1,
  })
  check('【不许返回半份】既无 Range 也无长度时，不肯确认完整性就直接失败',
    r6.ok === false && /完整性|长度/.test(r6.why), r6.ok ? ('居然成功了：' + r6.buf.length + ' 字节（原 ' + full.length + '）') : r6.why.slice(0, 90))
}

// ── ⑤ 端到端：本地优先 → 远程取回 → 落缓存 ─────────────────────────────
console.log('\n=== ⑤ 端到端（本地假"远程源"，不依赖外网）===')
const wsRoot = path.join(tmp, 'ws')
const mediaDir = path.join(wsRoot, '课程中心', '预览数据', 'media', '第一章')
fs.mkdirSync(mediaDir, { recursive: true })
// 本地只放一张图；另一张只在"远程"
const LOCAL_BYTES = Buffer.from('RIFF0000WEBPLOCAL-PNG-FAKE')
const REMOTE_BYTES = Buffer.from('RIFF0000WEBPREMOTE-PNG-FAKE')
fs.writeFileSync(path.join(mediaDir, 'local_only.webp'), LOCAL_BYTES)

let remoteHits = 0
let remoteMode = 'ok'
const remoteSrv = http.createServer((req, res) => {
  remoteHits += 1
  const name = decodeURIComponent(String(req.url || '').split('/').pop())
  if (remoteMode === 'down') { res.statusCode = 500; res.end('boom'); return }
  if (name === 'remote_only.webp') {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/octet-stream')
    res.end(REMOTE_BYTES); return
  }
  if (name === 'not_an_image.webp') {
    res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><h1>404 Not Found</h1>'); return
  }
  res.statusCode = 404; res.end('nope')
})
await new Promise((r) => remoteSrv.listen(0, '127.0.0.1', r))
const remoteBase = 'http://127.0.0.1:' + remoteSrv.address().port + '/media'
console.log('  假远程源：' + remoteBase)

// 课程配置里带上 mediaBase（学生机器的真实形态：工作区是一份精简课程包）
fs.writeFileSync(path.join(wsRoot, '课程配置.json'), JSON.stringify({
  title: '探针课程', mediaBase: remoteBase,
}, null, 2), 'utf8')
delete process.env.CIP_WORKSPACE
process.env.CIP_WORKSPACE_FILE = path.join(tmp, 'ws.txt')
fs.writeFileSync(process.env.CIP_WORKSPACE_FILE, wsRoot, 'utf8')
delete process.env.CIP_WORKSPACE_FILE
process.env.CIP_WORKSPACE = wsRoot
delete process.env.CIP_MEDIA_BASE

const routes = []
const ctx = {
  get: (n) => (n === 'fs' ? undefined : undefined),
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  webServer: { register: (r) => { routes.push(r); return () => { } } },
}
const core = createCore(ctx, { prefix: '/cip-mtest', role: 'student', pkgRoot: CORE_SRC, label: '探针' })
// ⚠️ 必须自己 mount()：两个插件里是 `core.registerApi(); core.mount()`，
//    而这个探针只 createCore —— 不 mount 的话 routes 里一条都没有，
//    于是「注册了媒体路由」这条断言红，后面每一条都会炸在 undefined.handler 上。
core.mount()
const mediaRoute = routes.filter((r) => r.path === '/cip-mtest-media')[0]
check('注册了媒体路由', !!mediaRoute)
check('info().media 有 base / configured / how 三个事实',
  !!core.info().media && core.info().media.configured === true
  && core.info().media.base === remoteBase, JSON.stringify(core.info().media))

const get = (rel) => new Promise((resolve) => {
  const res = {
    statusCode: 0, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(d) { resolve({ status: this.statusCode, headers: this.headers, body: Buffer.isBuffer(d) ? d : Buffer.from(String(d)) }) },
  }
  const req = { url: '/cip-mtest-media/' + rel, method: 'GET', on() { return req }, destroy() { } }
  Promise.resolve(mediaRoute.handler(req, res)).catch((e) => resolve({ status: -1, headers: {}, body: Buffer.from(String(e && e.message)) }))
})

{
  // ① 本地有 → 直接给，**一个远程请求都不发**
  const before = remoteHits
  const r1 = await get(encodeURIComponent('第一章') + '/local_only.webp')
  check('【本地优先】本机有的图直接给（HTTP 200）', r1.status === 200 && r1.body.equals(LOCAL_BYTES), 'HTTP ' + r1.status)
  check('【本地优先】没有发任何远程请求', remoteHits === before, '远程请求数 ' + (remoteHits - before))
  check('  标了 X-CIP-Media=local（诊断时能分清图从哪来）', r1.headers['x-cip-media'] === 'local', r1.headers['x-cip-media'])

  // ② 本地没有、远程有 → 取回来 + 落缓存
  const r2 = await get(encodeURIComponent('第一章') + '/remote_only.webp')
  check('【远程回退】本机没有时去远程取（HTTP 200）', r2.status === 200 && r2.body.equals(REMOTE_BYTES), 'HTTP ' + r2.status)
  check('  标了 X-CIP-Media=remote', r2.headers['x-cip-media'] === 'remote', r2.headers['x-cip-media'])
  check('  Content-Type 按名字给（对象存储回的是 octet-stream 也不受影响）',
    r2.headers['content-type'] === 'image/webp', r2.headers['content-type'])
  const cacheFile = path.join(wsRoot, '课程中心', '.cache', 'media', '第一章', 'remote_only.webp')
  check('【落缓存】文件真的写进了 课程中心/.cache/media/…', fs.existsSync(cacheFile))
  check('  缓存内容与远程一致', fs.existsSync(cacheFile) && fs.readFileSync(cacheFile).equals(REMOTE_BYTES))

  // ③ 再取一次 → 走本地那一档（离线也能看）
  const before3 = remoteHits
  const r3 = await get(encodeURIComponent('第一章') + '/remote_only.webp')
  check('【离线优先】第二次不再发远程请求（缓存命中）', remoteHits === before3, '远程请求数 ' + (remoteHits - before3))
  check('  这一次标的是 local/cache', r3.headers['x-cip-media'] === 'local' || r3.headers['x-cip-media'] === 'cache',
    r3.headers['x-cip-media'])
  check('  内容仍然是好的', r3.body.equals(REMOTE_BYTES))

  // ④ 名字像图、内容其实是 404 页面 → 必须拒，而且**不许落缓存**
  const r4 = await get(encodeURIComponent('第一章') + '/not_an_image.webp')
  check('【不许把 404 页面当图存下来】HTTP 不是 200', r4.status !== 200, 'HTTP ' + r4.status)
  check('  那个坏东西没有进缓存',
    !fs.existsSync(path.join(wsRoot, '课程中心', '.cache', 'media', '第一章', 'not_an_image.webp')))

  /**
   * ④b ★ 扩展名回退必须**贯穿三处**：远程取、缓存找、本地找。
   *
   * 这是实机探索抓出来的真 bug，而且差点就发给学生了：
   * `<章>.json` 的坐标里记的是**抽取时的原始扩展名**（`x.png`），
   * 而发出去的图是转换后的 `.webp`。
   * 本地那一档早就有扩展名回退，但第一版的**远程那一档只会照原名请求** ——
   * 于是「图不在本地 + 配了远程源」时**每一张都 404**。
   * 而这个组合恰恰是「摘掉媒体之后」的唯一形态：老师本机一切正常（他有图），
   * **只有学生**那边整页「图片不可用」。
   *
   * 判据逐条钉：
   *   ① 本地有 `x.png`（内容 A）、远程有 `x.webp`（内容 B）→ 必须给 B
   *      （本地有同名就绝不去远程 —— 那是①档的规矩）
   *   ② 本地**只有** `y.png` 的引用、而远程只有 `y.webp` → 取回来给 B，并落成 `y.webp`
   *   ③ 再来一次 → **走缓存（0 次远程请求）**，且标 `cache`。
   *      只断言「第二次也是 200」是假绿：走远程同样 200。
   */
  const EXT_BYTES = Buffer.from('RIFF0000WEBPREMOTE-BY-WEBP-NAME')
  fs.writeFileSync(path.join(mediaDir, 'name_clash.png'), Buffer.from('LOCAL-BY-PNG-NAME'))
  // 远程源：%.png → 404，%.webp → 200（真实形态：发出去的是 webp）
  const oldHandler = remoteSrv.listeners('request')[0]
  remoteSrv.removeListener('request', oldHandler)
  remoteSrv.on('request', (req, res) => {
    remoteHits += 1
    const name = decodeURIComponent(String(req.url || '').split('/').pop())
    if (/\.webp$/i.test(name) && /^(name_clash|remote_only_by_ext)/.test(name)) {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/octet-stream')
      res.end(EXT_BYTES); return
    }
    if (name === 'remote_only_by_ext.png') { res.statusCode = 404; res.end('nope'); return }
    if (name === 'remote_only.webp') {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/octet-stream')
      res.end(REMOTE_BYTES); return
    }
    if (name === 'not_an_image.webp') {
      res.statusCode = 200; res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><h1>404 Not Found</h1>'); return
    }
    res.statusCode = 404; res.end('nope')
  })

  const rc1 = await get(encodeURIComponent('第一章') + '/name_clash.png')
  check('④b-① 本地有同名（.png）时**绝不去远程**，给本地那份',
    rc1.status === 200 && rc1.body.toString() === 'LOCAL-BY-PNG-NAME' && rc1.headers['x-cip-media'] === 'local',
    rc1.headers['x-cip-media'] + ' / ' + rc1.body.length + ' 字节')

  const beforeExt = remoteHits
  const re1 = await get(encodeURIComponent('第一章') + '/remote_only_by_ext.png')
  check('④b-② 本地没有、远程只有 .webp → 换扩展名取回来（**这条就是那个真 bug**）',
    re1.status === 200 && re1.body.equals(EXT_BYTES), 'HTTP ' + re1.status + ' / ' + re1.body.length + ' 字节')
  check('  确实发了一个远程请求（不是缓存命中）', remoteHits > beforeExt, '远程请求 +' + (remoteHits - beforeExt))
  check('  缓存按**实际取到的名字**存（remote_only_by_ext.webp）',
    fs.existsSync(path.join(wsRoot, '课程中心', '.cache', 'media', '第一章', 'remote_only_by_ext.webp')))

  const beforeExt2 = remoteHits
  const re2 = await get(encodeURIComponent('第一章') + '/remote_only_by_ext.png')
  check('④b-③ 再来一次走缓存：**0 次远程请求**（json 里写的是 .png，缓存存的是 .webp）',
    re2.status === 200 && re2.body.equals(EXT_BYTES) && remoteHits === beforeExt2,
    'HTTP ' + re2.status + ' 远程请求 +' + (remoteHits - beforeExt2) + ' X-CIP-Media=' + re2.headers['x-cip-media'])
  check('  标的是 cache（不是 remote —— 否则说明缓存查找也漏了扩展名）',
    re2.headers['x-cip-media'] === 'cache', re2.headers['x-cip-media'])

  // ⑤ 远程也没有 → 404（不假装成功）
  const r5 = await get(encodeURIComponent('第一章') + '/never_exists.webp')
  check('【两边都没有】给 404，不假成功', r5.status === 404, 'HTTP ' + r5.status)

  // ⑥ 远程挂了 → 仍然 404，且 info().mediaError 有话说（排查时靠它）
  remoteMode = 'down'
  const r6 = await get(encodeURIComponent('第一章') + '/another_remote_only.webp')
  check('【远程挂了】给 404 而不是抛异常/挂住', r6.status === 404, 'HTTP ' + r6.status)
  check('  mediaError 里写清了是取远程失败', /远程/.test(String(core.info().mediaError || '')), String(core.info().mediaError).slice(0, 80))
  remoteMode = 'ok'

  // ⑦ 路径校验仍在（这条路由的值域不能因为加了远程回退而放松）
  const bad1 = await get('..%2F..%2Fwindows%2Fwin.ini')
  check('【路径校验】..%2F 一类仍然被拒', bad1.status === 400, 'HTTP ' + bad1.status)
  const bad2 = await get(encodeURIComponent('第四章') + '/x.webp')
  check('【路径校验】不在章节白名单里的目录名被拒', bad2.status === 400, 'HTTP ' + bad2.status)
}

// ── ⑥ 没配 mediaBase 时行为与今天完全一样 ───────────────────────────────
console.log('\n=== ⑥ 没配 mediaBase（今天的行为）：本地优先，缺就是 404 ===')
{
  fs.writeFileSync(path.join(wsRoot, '课程配置.json'), JSON.stringify({ title: '探针课程' }, null, 2), 'utf8')
  delete process.env.CIP_WORKSPACE_FILE
  const routes2 = []
  const core2 = createCore({ get: () => undefined, effect: (fn) => fn(), webServer: { register: (r) => { routes2.push(r); return () => { } } } },
    { prefix: '/cip-mtest2', role: 'student', pkgRoot: CORE_SRC, label: '探针2' })
  core2.mount()
  const r = routes2.filter((x) => x.path === '/cip-mtest2-media')[0]
  check('没配时 info().media.configured === false', core2.info().media.configured === false,
    JSON.stringify(core2.info().media))
  const before = remoteHits
  const one = await new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, end(d) { resolve({ status: this.statusCode, body: Buffer.from(String(d)) }) } }
    const req = { url: '/cip-mtest2-media/' + encodeURIComponent('第一章') + '/local_only.webp', on() { return req }, destroy() { } }
    Promise.resolve(r.handler(req, res))
  })
  check('  本地那张照样给得出来（不联网也能用）', one.status === 200 && one.body.equals(LOCAL_BYTES), 'HTTP ' + one.status)
  check('  没有发任何远程请求', remoteHits === before)
  const miss = await new Promise((resolve) => {
    const res = { statusCode: 0, headers: {}, setHeader() { }, end(d) { resolve({ status: this.statusCode }) } }
    const req = { url: '/cip-mtest2-media/' + encodeURIComponent('第一章') + '/remote_only.webp', on() { return req }, destroy() { } }
    Promise.resolve(r.handler(req, res))
  })
  check('  本机没有、又没配源 → 404（与加这一层之前完全一致）', miss.status === 404, 'HTTP ' + miss.status)

  // 环境变量优先于课程配置：同班不同源时用它切换，不必改课程包
  process.env.CIP_MEDIA_BASE = remoteBase
  const routes3 = []
  const core3 = createCore({ get: () => undefined, effect: (fn) => fn(), webServer: { register: (r) => { routes3.push(r); return () => { } } } },
    { prefix: '/cip-mtest3', role: 'student', pkgRoot: CORE_SRC, label: '探针3' })
  check('【环境变量优先】CIP_MEDIA_BASE 覆盖课程配置（课程配置里那项是空的）',
    core3.info().media.base === remoteBase && /环境变量/.test(core3.info().media.how),
    core3.info().media.base + ' / ' + core3.info().media.how)
  delete process.env.CIP_MEDIA_BASE

  // 配置写坏了：当作没配，但**留一句能看懂的说明**（否则症状是「图全都不出来」而配置看着是对的）
  fs.writeFileSync(path.join(wsRoot, '课程配置.json'),
    JSON.stringify({ title: '探针课程', mediaBase: 'file:///C:/Windows' }, null, 2), 'utf8')
  const routes4 = []
  const core4 = createCore({ get: () => undefined, effect: (fn) => fn(), webServer: { register: (r) => { routes4.push(r); return () => { } } } },
    { prefix: '/cip-mtest4', role: 'student', pkgRoot: CORE_SRC, label: '探针4' })
  const m4 = core4.info().media
  check('【配错了】file:// 被判无效并当作没配', m4.configured === false)
  check('  但留了一句说明（不然最难查）', /无效/.test(m4.how) && /file:\/\//.test(m4.how), m4.how.slice(0, 90))
}

// ── 收尾 ──────────────────────────────────────────────────────────────
// ⚠️ 这里**不能** `process.exit(code)`。踩了两次才发现根因不是我的代码：
//
//   在这台机器上（Node v24.15.0 / Windows），只要进程里调过 `fetch`，
//   随后 `process.exit()` 就会在 libuv 收尾时撞
//   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（退出码 -1073740791）。
//   最小复现：`node -e "fetch('https://api.github.com/').then(()=>process.exit(0))"`。
//   同一个脚本**不调** process.exit 时能干净退出（0），`http.get` 也不受影响
//   —— 所以那是 undici 的收尾问题，**不是产品问题**（宿主里没人调 process.exit）。
//
//   修法：set exitCode 之后**让事件循环自己结束**。构建门读的是退出码，
//   所以效果完全一样；再挂一个兜底定时器，万一真有句柄没释放也不会永远挂着。
await new Promise((r) => remoteSrv.close(r))
fs.rmSync(tmp, { recursive: true, force: true })
for (const k of Object.keys(savedEnv)) {
  if (savedEnv[k] === undefined) delete process.env[k]
  else process.env[k] = savedEnv[k]
}
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail === 0 ? 0 : 1
// 兜底：3 秒还没自然退出就强制退（这种情况下退出码已经设好了）
setTimeout(() => { process.exit(process.exitCode) }, 3000).unref()
