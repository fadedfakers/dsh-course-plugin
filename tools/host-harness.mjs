// 宿主端到端验证：不启动服务器，直接用假 ctx 调 apply()，捕获它注册的 HTTP 路由，
// 然后真的去请求它们。这样能验证「注册路径 → 处理函数 → 读文件」整条链路。
// 用法：node host-harness.mjs <工作区目录> [<插件包目录>]
const WS = process.argv[2]
const PKG = process.argv[3] || 'C:/Users/Administrator/Desktop/暑期课程/课程中心/course-panel-plugin'
if (!WS) { console.error('用法: node host-harness.mjs <工作区> [插件目录]'); process.exitCode = 1; process.exit() }

// 【测试隔离】不让宿主机器上的 ~/.dsh/cip-workspace.txt 抢走解析结果。
// 解析链会读那个文件，而它是**这台机器**的真实配置 —— 在配过的机器上（教师机就是）
// 它会先命中，本脚本自己的工作区反而被跳过，断言会集体变红而看起来像产品坏了。
// 指到一个必然不存在的文件 = 把它从候选里摘掉。同类事故已在 verify-media-fallback 发生过。
if (!process.env.CIP_WORKSPACE_FILE) {
  process.env.CIP_WORKSPACE_FILE = nodeOs.tmpdir() + nodePath.sep + 'cip-test-no-workspace-file.txt'
}process.env.CIP_WORKSPACE = WS
const mod = await import('file:///' + PKG.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:') + '/src/index.js')
const plugin = mod.default || mod

import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'

// ── 假 ctx：记录注册了哪些路由，effect 立即执行 ──
// fs 必须给真的实现：插件的读写全走 ctx.get('fs')，给 null 会让
// tree/slides 全部静默返回 null，看起来像插件坏了，其实是脚手架没搭好。
const fsShim = {
  resolve: async (p, opts) => nodePath.resolve(opts && opts.cwd ? opts.cwd : '.', p),
  readText: async (p) => nodeFs.readFileSync(p, 'utf8'),
  writeText: async (p, c) => { nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true }); nodeFs.writeFileSync(p, c, 'utf8') },
  readBytes: async (p) => nodeFs.readFileSync(p),
  stat: async (p) => nodeFs.statSync(p),
  listDir: async (p) => nodeFs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: () => e.isDirectory() })),
}
const routes = []
const disposers = []
const fakeCtx = {
  get: (n) => (n === 'fs' ? fsShim : undefined),
  effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
  webServer: {
    register: (r) => { routes.push(r); return () => {} },
  },
}
plugin.apply(fakeCtx)

console.log(`注册路由 ${routes.length} 个：`)
for (const r of routes) console.log('  ' + r.kind + '  ' + r.path)

// ── 假 req/res ──
function call(pathname, body) {
  return new Promise((resolve) => {
    const chunks = []
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      end(data) { resolve({ status: this.statusCode, headers: this.headers, body: data }) },
      getHeader(k) { return this.headers[k.toLowerCase()] },
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = {
      url: pathname, method: payload ? 'POST' : 'GET', headers: {},
      on(ev, cb) {
        if (ev === 'data' && payload) cb(payload)
        if (ev === 'end') cb()
        if (ev === 'error') { /* 不触发 */ }
        return req
      },
      destroy() {},
    }
    for (const r of routes) {
      if (pathname.startsWith(r.path)) {
        Promise.resolve(r.handler(req, res)).catch((e) => {
          res.statusCode = 500; res.end('handler threw: ' + (e && e.message))
        })
        return
      }
    }
    resolve({ status: -1, headers: {}, body: 'no route matched: ' + pathname })
  })
}

const asText = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b))
let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

console.log('\n=== /cip-api/info ===')
{
  const r = await call('/cip-api/info', {})
  check('HTTP 200', r.status === 200, 'status=' + r.status)
  let j = null
  try { j = JSON.parse(asText(r.body)) } catch (e) { }
  if (!j) { check('返回合法 JSON', false, asText(r.body).slice(0, 120)) }
  else {
    check('返回合法 JSON', true, `${asText(r.body).length} 字节`)
    check('workspace 指向传入的工作区', j.workspace === WS.replace(/\\/g, '\\'), j.workspace)
    check('workspaceLooksValid', j.workspaceLooksValid === true)
    check('katexCssOk（包内自带 katex）', j.katexCssOk === true, j.katexDir)
    check('panelCssBundled（包内自带样式表）', j.panelCssBundled === true)
    // 角色相关断言按「本进程设了什么」自适应：
    // 不设 CIP_ROLE 时必须落到 student（fail-closed），设了 teacher 就必须是 teacher。
    const wantRole = (process.env.CIP_ROLE || '').toLowerCase() === 'teacher' ? 'teacher' : 'student'
    check('role = ' + wantRole, j.role === wantRole, String(j.role))
    if (wantRole === 'student') check('学生不能批改/审计', j.canGrade === false && j.canAudit === false)
    else check('教师可以批改/审计', j.canGrade === true && j.canAudit === true)
    check('workspaceHow 有说明', typeof j.workspaceHow === 'string' && j.workspaceHow.length > 0, j.workspaceHow)
  }
}

console.log('\n=== /cip-api/tree（课程结构）===')
{
  const r = await call('/cip-api/tree', {})
  check('HTTP 200', r.status === 200, 'status=' + r.status)
  let j = null; try { j = JSON.parse(asText(r.body)) } catch (e) { }
  if (!j || j.error) check('拿到课程树', false, j && j.error)
  else check('拿到课程树', true, `${(j.modules || []).length} 模块 / ${j.totalLessons} 课时`)
}

console.log('\n=== /cip-api/slides（每章课件）===')
for (const ch of ['第一章', '第二章', '第三章']) {
  const r = await call('/cip-api/slides', { chapter: ch })
  let j = null; try { j = JSON.parse(asText(r.body)) } catch (e) { }
  if (!j || j.error) { check(ch, false, (j && j.error) || asText(r.body).slice(0, 80)); continue }
  // 拿第一页的第一张图，真的去请求它
  let first = null
  for (const s of (j.slides || [])) { if (s.media && s.media.length) { first = { s, m: s.media[0] }; break } }
  check(ch + ' slides', true, `${j.slides.length} 页, slideCount=${j.slideCount}`)
  if (first) {
    // 契约：宿主返回的 m.file 是**裸文件名**（JSON 里原样），媒体路由由客户端拼。
    // 这里模拟客户端的行为：/cip-media/<章>/<文件名>
    const isBare = first.m.file.indexOf('/') < 0
    check(ch + ' m.file 是裸文件名（契约）', isBare, JSON.stringify(first.m.file))
    const mediaUrl = '/cip-media/' + ch + '/' + first.m.file
    const mr = await call(mediaUrl, {})
    const ct = String(mr.headers['content-type'] || '')
    const isImg = ct.startsWith('image/')
    check(ch + ' 首图可取', mr.status === 200 && isImg,
      `${first.m.file} → ${mr.status} ${ct} ${Buffer.isBuffer(mr.body) ? mr.body.length : 0}B`)
  }
  // mp4：学生包里没有（返回 SVG 说明牌），老师工作区里有（直接发视频）。
  // 两种都要判，不能写死一种 —— 否则换个工作区跑就会误报。
  let mp4 = null
  for (const s of (j.slides || [])) for (const m of (s.media || [])) if (/\.mp4$/i.test(m.file)) mp4 = m
  if (mp4) {
    const vr = await call('/cip-media/' + ch + '/' + mp4.file, {})
    const vt = String(vr.headers['content-type'] || '')
    const body = asText(vr.body)
    if (vt.indexOf('svg') >= 0) {
      check(ch + ' mp4 返回说明牌', vr.status === 200 && body.indexOf('未随课程包分发') > 0, vt)
    } else {
      check(ch + ' mp4 直发视频', vr.status === 200 && vt.indexOf('video/') === 0,
        `${mp4.file} → ${vr.status} ${vt} ${Buffer.isBuffer(vr.body) ? vr.body.length : 0}B`)
    }
  }
}

console.log('\n=== 静态资源 ===')
{
  const css = await call('/cip-panel.css', {})
  check('面板样式表可取', css.status === 200 && String(css.headers['content-type']).includes('text/css'),
    `${css.status} ${Buffer.isBuffer(css.body) ? css.body.length : 0}B`)
  check('样式表含角色徽标类', asText(css.body).includes('.k9b'))
  for (const f of ['katex.min.js', 'katex.min.css']) {
    const r = await call('/cip-katex/' + f, {})
    check('katex ' + f, r.status === 200, `${r.status} ${String(r.headers['content-type'] || '')} ${Buffer.isBuffer(r.body) ? r.body.length : 0}B`)
  }
  const bad = await call('/cip-katex/../../etc/passwd', {})
  check('katex 路径穿越被拒', bad.status !== 200, 'status=' + bad.status)
}

console.log('\n=== 教师专属动作的角色门禁 ===')
{
  const r = await call('/cip-api/audit', { path: 'x', decision: 'shared' })
  const body = asText(r.body)
  const isTeacher = (process.env.CIP_ROLE || '').toLowerCase() === 'teacher'
  if (isTeacher) {
    // 教师：应当**通过**门禁，然后因为路径不存在而失败 —— 不能因角色被拒
    check('教师不被角色拦截', body.indexOf('学生端') < 0, `${r.status} ${body.slice(0, 70)}`)
  } else {
    check('学生被拒', r.status !== 200 || body.includes('学生端'), `${r.status} ${body.slice(0, 70)}`)
  }
}

console.log('\n' + '='.repeat(58))
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail ? 1 : 0
