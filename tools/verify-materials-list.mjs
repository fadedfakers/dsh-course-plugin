/**
 * 验「资料」这一层：**课件原件 / 讲义 PDF 怎么发给学生、怎么在线看**。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────
 * 老师的原话：「教师课件、ppt、资料放哪，学生从哪连接到该仓库？」
 * 以及「学生端需要对照 ppt 截图提问，所以插件中应该要给下载链接也能够在线预览」。
 *
 * 这一条路上每一环出错都是**静默**的，而且都表现为"老师以为发了、学生看不到"：
 *   · 清单里某项写错（缺 title / file 指向仓外）→ 那一项消失，界面不报错
 *   · 引用的文件不在仓里 → 学生点开 404，老师本机毫无异常
 *   · pptx 没有配套 PDF → 学生能下载但**在线看不了**（浏览器没有 pptx 渲染器）
 *   · 文件路由的路径校验松一格 → **任意文件读取**（它读的是磁盘上的真实文件）
 *   · 两端的"资料"页只有一端接线 → 另一端点了没反应
 *
 * ── 分四层验 ────────────────────────────────────────────────────────────
 *   ① 纯函数（core/src/resources.js）：清单规整 / 类型判定 / 预览方式 / 体积话术
 *   ② file:// 路由：能取到、取不到给 404、**路径穿越必须拒**
 *   ③ materials.list 动作：本地文件大小以磁盘为准、缺文件时 `ok:false` 并给理由、
 *      坏项单列（不静默丢）
 *   ④ 两端客户端：都渲染了资料页、都调了 materials.list、动作名与宿主一致
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

const res = await import(pathToFileURL(path.join(CORE_SRC, 'resources.js')).href)
const { createCore } = await import(pathToFileURL(path.join(CORE_SRC, 'host.js')).href)

let pass = 0, fail = 0
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + n + (extra !== undefined ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + n + (extra !== undefined ? '  ' + extra : '')) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-mat-'))
const savedEnv = {}
for (const k of ['CIP_WORKSPACE', 'CIP_COURSE_DIR', 'CIP_COURSE_CODE', 'CIP_WORKSPACE_FILE']) {
  savedEnv[k] = process.env[k]
}

// ── ① 纯函数 ──────────────────────────────────────────────────────────
console.log('=== ① 清单规整：能收哪些、必须拒哪些 ===')
{
  const ok = res.normalizeItem({ title: '第一章 课件原件', file: '第一章.pptx', kind: 'slides' }, 0)
  check('正常一项 → ok', ok.ok === true, ok.why || ok.item.title)
  check('  仓内项的目标是 资料/ 下的相对路径', ok.item.target === '资料/第一章.pptx', ok.item.target)

  // 反斜杠要归一：老师在 Windows 上写清单一定会写反斜杠
  const bs = res.normalizeItem({ title: 'x', file: '讲义\\第3讲.pdf' }, 0)
  check('  file 里的反斜杠被归一成正斜杠', bs.ok && bs.item.target === '资料/讲义/第3讲.pdf', bs.ok ? bs.item.target : bs.why)
  check('  类型按扩展名猜出来（老师少写 kind 也不该丢项）', bs.item.kind === 'pdf', bs.item.kind)

  const bad = [
    [{ file: 'a.pdf' }, '缺 title'],
    [{ title: 'a' }, '缺 file'],
    [{ title: 'a', file: '../../secret.txt' }, 'file 含 ..'],
    [{ title: 'a', file: '/etc/passwd' }, 'file 是绝对路径'],
    [{ title: 'a', file: 'a.pdf', url: 'file:///C:/Windows' }, 'url 不是 http(s)'],
    [{ title: 'a', file: 'a.pdf', url: 'C:\\tmp\\a.pdf' }, 'url 是本机路径'],
  ]
  for (const [raw, why] of bad) {
    const r = res.normalizeItem(raw, 0)
    check('拒绝（' + why + '）', r.ok === false && !!r.why, r.ok ? ('居然通过了：' + JSON.stringify(r.item.target)) : r.why.slice(0, 70))
  }
  const url = res.normalizeItem({ title: '原件', file: '第一章.pptx', url: 'https://github.com/o/r/releases/download/v1/a.pptx' }, 0)
  check('写 url 的项 → remote:true 且 target 就是那个 url',
    url.ok && url.item.remote === true && url.item.target.indexOf('https://') === 0, url.item && url.item.target)
}

console.log('\n=== ② 预览方式：浏览器能看什么、不能看什么 ===')
{
  check('pdf → iframe（浏览器自带阅读器）', res.previewMode('pdf') === 'iframe')
  check('image → img', res.previewMode('image') === 'img')
  check('video → video', res.previewMode('video') === 'video')
  // ★ 这一条是整个「在线预览」的关键：**浏览器没有 pptx 渲染器**
  check('【关键】slides（pptx 原件）→ 不是可内嵌的预览器', res.previewMode('slides') === 'slides')
  check('file（未知类型）→ 不假装能预览', res.previewMode('file') === 'none')

  const withPdf = res.previewTarget({ kind: 'slides', target: '资料/a.pptx', slides: { pdf: '资料/a.pdf' } })
  check('pptx 有配套 PDF 时 → 用那个 PDF 内嵌', withPdf.mode === 'iframe' && withPdf.src === '资料/a.pdf', JSON.stringify(withPdf))
  const noPdf = res.previewTarget({ kind: 'slides', target: '资料/a.pptx', slides: { pdf: '' } })
  check('pptx 没有 PDF 时 → 不给内嵌（界面只给下载 + 去课件页）', noPdf.mode === 'slides', JSON.stringify(noPdf))

  const jump = res.slidesJump({ kind: 'slides', slides: { chapter: '第一章', from: 1, to: 58 } })
  check('课件项带章节 → 能生成「去课件页」跳转参数', jump && jump.chapter === '第一章' && jump.to === 58, JSON.stringify(jump))
  check('非课件项 → 不给跳转（按钮不该出现）', res.slidesJump({ kind: 'pdf' }) === null)

  check('体积话术：字节 / KB / MB / GB',
    res.sizeText(512) === '512 B' && res.sizeText(2048) === '2 KB'
    && res.sizeText(4 * 1048576) === '4.0 MB' && res.sizeText(3 * 1073741824) === '3.00 GB',
    [res.sizeText(512), res.sizeText(2048), res.sizeText(4 * 1048576), res.sizeText(3 * 1073741824)].join(' / '))
  check('size=0（不知道）→ 空串，不显示 "0 B"', res.sizeText(0) === '', JSON.stringify(res.sizeText(0)))
}

console.log('\n=== ③ 坏项不许静默消失 ===')
{
  const m = res.normalizeManifest({
    items: [
      { title: '好的', file: 'a.pdf' },
      { title: '', file: 'b.pdf' },            // 缺 title
      { title: '坏路径', file: '../c.pdf' },   // 越界
    ],
  })
  check('好的留下、坏的进 bad（**不丢**）', m.items.length === 1 && m.bad.length === 2,
    'items=' + m.items.length + ' bad=' + m.bad.length)
  check('  bad 里说清了是哪一项、为什么', m.bad[0].indexOf('第 2 项') >= 0 && /\.\./.test(m.bad[1]), m.bad.join(' | ').slice(0, 90))
  check('清单不是对象 / items 不是数组时不抛错', (() => {
    try { return res.normalizeManifest(null).items.length === 0 && res.normalizeManifest({ items: 'x' }).items.length === 0 } catch (e) { return false }
  })())
}

// ── ④ 端到端：真写一份清单 + 文件，走真路由与真动作 ──────────────────────
console.log('\n=== ④ 端到端（真文件、真路由、真动作）===')
const wsRoot = path.join(tmp, 'ws')
fs.mkdirSync(path.join(wsRoot, '课程中心', '预览数据'), { recursive: true })
fs.mkdirSync(path.join(wsRoot, '资料'), { recursive: true })
fs.writeFileSync(path.join(wsRoot, '课程中心', '课程结构索引.json'),
  JSON.stringify({ course: '探针课程', modules: [{ name: '模块一' }] }), 'utf8')
const PDF_BYTES = Buffer.from('%PDF-1.4\n' + 'x'.repeat(500))
fs.writeFileSync(path.join(wsRoot, '资料', '第一章-原件.pdf'), PDF_BYTES)
fs.mkdirSync(path.join(wsRoot, '资料', '讲义'), { recursive: true })
fs.writeFileSync(path.join(wsRoot, '资料', '讲义', '第3讲.pdf'), PDF_BYTES)
// 一个**放在资料目录之外**的敏感文件：用来验路径穿越
fs.writeFileSync(path.join(wsRoot, '秘密.txt'), '这是不该被读到的内容', 'utf8')
fs.writeFileSync(path.join(wsRoot, '资料.json'), JSON.stringify({
  updated: '2026-09-27',
  items: [
    { title: '第一章 课件原件', kind: 'slides', file: '第一章.pptx', slides: { chapter: '第一章', from: 1, to: 58, pdf: '资料/第一章-原件.pdf' } },
    { title: '第一章 课件（PDF）', kind: 'pdf', file: '第一章-原件.pdf' },
    { title: '第 3 讲讲义', kind: 'pdf', file: '讲义/第3讲.pdf' },
    { title: '远端原件', kind: 'slides', file: '第一章.pptx', url: 'https://github.com/o/r/releases/download/v1/第一章.pptx' },
    { title: '仓里没有的东西', kind: 'pdf', file: '不存在.pdf' },
    { title: '', file: 'x.pdf' },
  ],
}, null, 2), 'utf8')

delete process.env.CIP_WORKSPACE_FILE
process.env.CIP_WORKSPACE = wsRoot
delete process.env.CIP_COURSE_DIR

const routes = []
const core = createCore({
  get: () => undefined, effect: (fn) => fn(),
  webServer: { register: (r) => { routes.push(r); return () => { } } },
}, { prefix: '/cip-mat', role: 'student', pkgRoot: CORE_SRC, label: '资料探针' })
core.mount()

const matRoute = routes.filter((r) => r.path === '/cip-mat-mat')[0]
check('注册了资料文件路由 /cip-mat-mat', !!matRoute, routes.map((r) => r.path).join(' '))

const get = (rel) => new Promise((resolve) => {
  const r2 = {
    statusCode: 0, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(d) { resolve({ status: this.statusCode, headers: this.headers, body: Buffer.isBuffer(d) ? d : Buffer.from(String(d)) }) },
  }
  const req = { url: '/cip-mat-mat/' + rel, method: 'GET', on() { return req }, destroy() { } }
  Promise.resolve(matRoute.handler(req, r2)).catch((e) => resolve({ status: -1, headers: {}, body: Buffer.from(String(e && e.message)) }))
})

{
  const r1 = await get(encodeURIComponent('第一章-原件.pdf'))
  check('取仓内 PDF → 200 且字节一致', r1.status === 200 && r1.body.equals(PDF_BYTES), 'HTTP ' + r1.status)
  check('  Content-Type 是 application/pdf（否则浏览器会下载而不是内嵌显示）',
    r1.headers['content-type'] === 'application/pdf', r1.headers['content-type'])
  const r2 = await get(encodeURIComponent('讲义') + '/' + encodeURIComponent('第3讲.pdf'))
  check('子目录里的文件也能取（任意相对路径都支持）', r2.status === 200 && r2.body.equals(PDF_BYTES), 'HTTP ' + r2.status)
  const r3 = await get('nope.pdf')
  check('不存在的文件 → 404（不假成功）', r3.status === 404, 'HTTP ' + r3.status)
  // ★ 安全：这条路由读的是磁盘上的真实文件，校验松一格就是任意文件读取
  const attacks = ['..%2F%E7%A7%98%E5%AF%86.txt', '..%5C%E7%A7%98%E5%AF%86.txt', '%2E%2E/%E7%A7%98%E5%AF%86.txt',
    '....//%E7%A7%98%E5%AF%86.txt', 'C%3A%5CWindows%5Cwin.ini']
  for (const a of attacks) {
    const ra = await get(a)
    check('【安全】拒绝路径穿越：' + a, ra.status !== 200, 'HTTP ' + ra.status + ' ' + ra.body.toString().slice(0, 20))
  }
}

console.log('\n=== ⑤ materials.list 动作：界面拿到的东西对不对 ===')
{
  const s = await core.coreHandlers['materials.list']({})
  check('动作返回 ok 且有 items', s && s.ok === true && Array.isArray(s.items), 'items=' + (s.items || []).length)
  check('坏项被单列出来（不静默丢）', s.bad.length === 1 && /title/.test(s.bad[0]), JSON.stringify(s.bad))
  const byTitle = (t) => s.items.filter((x) => x.title === t)[0]
  check('本地文件的大小**以磁盘为准**（清单没写 size 也有值）',
    byTitle('第一章 课件（PDF）').size === PDF_BYTES.length && byTitle('第一章 课件（PDF）').sizeText === (PDF_BYTES.length + ' B'),
    JSON.stringify(byTitle('第一章 课件（PDF）').size) + ' / ' + byTitle('第一章 课件（PDF）').sizeText)
  check('仓里没有的那一项 → ok:false 且给了理由（界面据此不给下载按钮）',
    byTitle('仓里没有的东西').ok === false && /没有这个文件/.test(byTitle('仓里没有的东西').missingWhy),
    byTitle('仓里没有的东西').missingWhy)
  check('外部直链项 → ok:true（可达性由学生的网络决定，不该在这里判死）',
    byTitle('远端原件').ok === true && byTitle('远端原件').remote === true)
  check('课件项带 jump（「去课件页框选提问」要用它）',
    byTitle('第一章 课件原件').jump && byTitle('第一章 课件原件').jump.chapter === '第一章',
    JSON.stringify(byTitle('第一章 课件原件').jump))
  check('课件项的预览目标是那份 PDF（不是 pptx —— 浏览器打不开 pptx）',
    byTitle('第一章 课件原件').preview.mode === 'iframe' && /\.pdf$/.test(byTitle('第一章 课件原件').preview.src),
    JSON.stringify(byTitle('第一章 课件原件').preview))
  check('PDF 项也是可内嵌预览', byTitle('第一章 课件（PDF）').preview.mode === 'iframe')
}

console.log('\n=== ⑥ 清单缺失 / 坏掉时都不能把面板弄挂 ===')
{
  fs.rmSync(path.join(wsRoot, '资料.json'))
  const routes2 = []
  const core2 = createCore({ get: () => undefined, effect: (fn) => fn(), webServer: { register: (r) => { routes2.push(r); return () => { } } } },
    { prefix: '/cip-mat2', role: 'student', pkgRoot: CORE_SRC, label: '资料探针2' })
  core2.mount()
  const s2 = await core2.coreHandlers['materials.list']({})
  check('没有 资料.json → 空清单、hasManifest:false、不抛错',
    s2.ok === true && s2.hasManifest === false && s2.items.length === 0, JSON.stringify({ has: s2.hasManifest, n: s2.items.length }))

  fs.writeFileSync(path.join(wsRoot, '资料.json'), '{ 这不是合法 JSON', 'utf8')
  const routes3 = []
  const core3 = createCore({ get: () => undefined, effect: (fn) => fn(), webServer: { register: (r) => { routes3.push(r); return () => { } } } },
    { prefix: '/cip-mat3', role: 'student', pkgRoot: CORE_SRC, label: '资料探针3' })
  core3.mount()
  const s3 = await core3.coreHandlers['materials.list']({})
  check('资料.json 坏了 → 不抛错，且把原因说出来（readError）',
    s3.ok === true && !!s3.readError && s3.items.length === 0, s3.readError.slice(0, 70))
}

console.log('\n=== ⑦ 两端客户端都接线了 ===')
{
  const CLIENTS = [
    ['学生端', path.resolve(CORE_SRC, '..', '..', 'dsh-course-student', 'lib', 'client.js')],
    ['教师端', path.resolve(CORE_SRC, '..', '..', 'dsh-course-teacher', 'lib', 'client.js')],
  ]
  for (const [who, f] of CLIENTS) {
    const t = fs.readFileSync(f, 'utf8')
    check(who + '：有 Materials 组件', /function Materials\(/.test(t))
    check(who + '：调的动作名与宿主一致（materials.list）', /api\('materials\.list'/.test(t))
    check(who + '：预览用宿主算好的 preview.mode（不自己按扩展名推断）', /it\.preview|\.preview\.mode/.test(t))
    // ⚠️ 两端都要在渲染时就检查清单新鲜度 —— 否则老师改完 资料.json 得整页刷新才看到
    check(who + '：切到对应页时读一次清单（不是只在启动时读）', /materials\.list/.test(t) && /loadMaterials|materials: await/.test(t))
  }
  const stu = fs.readFileSync(CLIENTS[0][1], 'utf8')
  check('学生端：视图列表里有「资料」页', /id: 'materials'/.test(stu))
  check('学生端：资料页渲染了 Materials', /view === 'materials' \? h\(PanelBoundary, \{ label: '资料' \}/.test(stu))
  check('学生端：有「去课件页框选提问」的跳转（对着 PPT 截图提问那条路）',
    /goMaterialsJump/.test(stu) && /view: 'slides'/.test(stu))
  // 学生端要**下载**仓内文件，所以必须知道文件路由前缀；且不能写死 ——
  // 写死会让"换前缀就整块坏掉"，这个项目为写死前缀吃过一次亏（教师面板
  // 去请求学生端路由，满屏「未知动作」）。
  check('学生端：资料文件前缀从 info.prefixes.mat 取（不写死路由）', /prefixes\.mat/.test(stu))
  const tea = fs.readFileSync(CLIENTS[1][1], 'utf8')
  check('教师端：发布页有资料清单那一块（老师要看学生能拿到什么）',
    /TeacherMaterials/.test(tea) && /资料（学生能下载/.test(tea))
  check('教师端：把「清单里有文件不在仓里」标出来（否则老师本机看不出异常）',
    /项引用的文件不在仓里/.test(tea))
  check('教师端：把「清单里没有 PDF」标出来（否则"在线看原件"是空承诺）',
    /浏览器看不了 pptx/.test(tea))
  // 两份 MaterialCard/Materials **不要求逐字一致**：两端渲染的上下文不同
  // （学生是整页、老师是发布页一块）。但要保证**判据一致** —— 都由宿主给。
}

// ── 收尾 ──────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true })
for (const k of Object.keys(savedEnv)) {
  if (savedEnv[k] === undefined) delete process.env[k]
  else process.env[k] = savedEnv[k]
}
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail === 0 ? 0 : 1
// 不调 process.exit：本机 Node v24 用了 fetch 之后 process.exit 会撞 libuv 断言
setTimeout(() => process.exit(process.exitCode), 3000).unref()
