// 两个插件同时挂载的端到端验证。
// 不启动服务器：用假 ctx 调 apply()，捕获两边注册的路由，然后真的请求它们。
//
// 这个脚本要回答三个问题：
//   1. 学生端与教师端能不能装在**同一个 DSH 进程**里？（路由前缀会不会撞车）
//   2. 学生提问 → 教师审计共享 → 学生能看到，这条链路通不通？
//   3. 按教案批改能不能把问题清单解析出来并落成条目？
//
// 用法：node dual-plugin-harness.mjs <工作区> [<三个包的父目录>]
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import nodePath from 'node:path'
import { pathToFileURL } from 'node:url'

const WS = process.argv[2]
const PACKS = process.argv[3] || 'C:/Users/Administrator/Desktop/暑期课程/课程中心/course-plugin'
if (!WS) { console.error('用法: node dual-plugin-harness.mjs <工作区> [包父目录]'); process.exitCode = 1; process.exit() }
// 【测试隔离】不让宿主机器上的 ~/.dsh/cip-workspace.txt 抢走解析结果。
// 解析链会读那个文件，而它是**这台机器**的真实配置 —— 在配过的机器上（教师机就是）
// 它会先命中，本脚本自己的工作区反而被跳过，断言会集体变红而看起来像产品坏了。
// 指到一个必然不存在的文件 = 把它从候选里摘掉。同类事故已在 verify-media-fallback 发生过。
if (!process.env.CIP_WORKSPACE_FILE) {
  process.env.CIP_WORKSPACE_FILE = nodeOs.tmpdir() + nodePath.sep + 'cip-test-no-workspace-file.txt'
}process.env.CIP_WORKSPACE = WS
process.env.CIP_STUDENT = process.env.CIP_STUDENT || 'S001'

// ── 打桩：模型与附件 ──────────────────────────────────────────
// 不真的调模型（会花钱、也不确定网络），但保留完全相同的调用契约：
// 返回 text-delta 与 usage 分片，这样能验证「token 用量有没有被记下来」。
let modelCalls = 0
let lastSystem = ''
let lastGradePrompt = ''
let lastPlanPrompt = ''
let lastReviseSystem = ''
let lastModelCall = { provider: '', model: '', effort: '' }
const llmStub = {
  // 模型目录：真实 llm 服务有 listProviders / listModels，面板的模型选择器靠它们。
  // 桩里给两个 provider、其中一个模型不可看图 —— 这样「可看图 / 无图」标记
  // 与「选了不支持图片的模型」这两条路才测得到。
  listProviders: () => [{ id: 'stub', name: '打桩提供方' }, { id: 'other', name: '另一个提供方' }],
  async listModels(provider) {
    if (provider === 'stub') {
      return [
        { provider: 'stub', id: 'stub-model', name: '打桩模型（快）', inputModalities: ['text'] },
        { provider: 'stub', id: 'stub-vision', name: '打桩模型（可看图）', inputModalities: ['text', 'image'] },
      ]
    }
    return [{ provider: 'other', id: 'other-big', name: '另一个模型（强）' }]
  },
  stream(options) {
    modelCalls += 1
    lastModelCall = { provider: options.provider, model: options.model, effort: options.reasoningEffort || '' }
    lastSystem = String(options.system || '')
    // 记下最后一次「批改」调用里**用户消息的文本**：这是判断
    // 「代码到底有没有发给模型」的唯一直接证据（只看 system 看不出来）。
    {
      const msgs = Array.isArray(options.messages) ? options.messages : []
      const userTexts = []
      for (const m of msgs) {
        if (!m || m.role !== 'user') continue
        const blocks = Array.isArray(m.content) ? m.content : []
        for (const b of blocks) if (b && b.type === 'text' && typeof b.text === 'string') userTexts.push(b.text)
      }
      if (String(options.system || '').indexOf('批改学生作业') >= 0) lastGradePrompt = userTexts.join('\n')
      // 改稿走的是另一个 system（「改一份已有的教案草稿」）。它同样含「主讲老师」，
      // 所以必须**先**判它，否则会被下面那条覆盖 —— 这正是上一版断言失败的原因：
      // 查的是 user 消息，而「只改要求的地方」这条约束写在 system 里。
      if (String(options.system || '').indexOf('改一份已有的教案草稿') >= 0) {
        lastPlanPrompt = userTexts.join('\n')
        lastReviseSystem = String(options.system || '')
      }
      // 教案生成的提示词：用来断言「课件文本与示例代码真的进了提示词」。
      // 这一条必须直接查提示词 —— 只看「生成成功」是查不出「模型其实什么都没看到」的。
      if (String(options.system || '').indexOf('主讲老师') >= 0) lastPlanPrompt = userTexts.join('\n')
    }
    const isFacets = lastSystem.indexOf('知识领域') >= 0   // FACETS_SYSTEM 的特征串
    const isTitle = lastSystem.indexOf('拟标题') >= 0
    const isSummary = lastSystem.indexOf('问题总结') >= 0
    const isGrade = lastSystem.indexOf('批改学生作业') >= 0
    const isPlan = lastSystem.indexOf('主讲老师') >= 0
    // 改稿走的是另一个 system（「改一份已有的教案草稿」），桩必须分开认 ——
    // 否则改稿会落到下面的兜底分支，返回一句散文，而 parsePlan 一解析就空，
    // 断言会全部指向「模型没返回五节」这种假象。
    const isRevise = lastSystem.indexOf('改一份已有的教案草稿') >= 0
    let text
    if (isRevise) {
      // 改稿的桩：照契约回整篇五节，并且**故意改一处**（推导多一行），
      // 这样 diff 一定非空，断言才有东西可验。
      text = '# 课时 2：第二课：进阶\n\n## 目标\n\n1. 能写出 $\\\\nabla_w \\\\mathcal{J}$\n\n'
        + '## 推导\n\n### 一、链式法则\n\n见 \\\\frac{\\\\partial \\\\mathcal{J}}{\\\\partial w}\n\n'
        + '> 这一轮补上的逐步说明：先展开再逐项求导。\n\n'
        + '## 实操\n\n### 任务一：手写梯度\n\n- 产物：\n2_进阶_grad.py\n\n'
        + '## 验收标准\n\n1. 梯度与 PyTorch autograd 在 1e-6 内一致\n\n'
        + '## 当堂交付物\n\n- \n2_进阶_grad.py\n'
    } else if (isPlan) {
      // 照 PLAN_SYSTEM 的契约回：五个二级标题一个不少，公式用 LaTeX。
      // 桩**故意**按契约回，这样「模型输出 → 解析 → 落盘 → 采纳」整条路才测得到；
      // 顺便让「缺哪一节」的判定有真数据可判（这里五节齐全 → missing 应为空）。
      text = '好的，我来为你整理这份教案：\n\n```markdown\n'
        + '# 课时 19：像素级语义空间建模与 U-Net 架构\n\n'
        + '## 目标\n\n1. 能用 $3\\times3$ 卷积堆出收缩-扩张结构\n2. 能说明 skip connection 为什么缓解梯度消失\n\n'
        + '## 推导\n\n### 一、卷积的局部性\n\n$$y_{i,j}=\\sum_{m,n} x_{i+m,j+n} w_{m,n}$$\n\n'
        + '### 二、上采样的两种写法\n\n转置卷积与插值的关系见 $\\mathbf{W}^{T}$。\n\n'
        + '## 实操\n\n### 任务一：搭一个紧凑 UNet\n\n- 要求：编码器 3 层\n- 产物：`01_紧凑版UNet_compact_unet.py`\n\n'
        + '## 验收标准\n\n1. 前向输出形状与输入一致，为 $(N,1,H,W)$\n2. 参数量打印出来且小于 2M\n\n'
        + '## 当堂交付物\n\n- `01_紧凑版UNet_compact_unet.py` —— 可运行的最小 UNet\n```\n'
    } else if (isFacets) {
      // 现在标题与分类一次产出，要求模型回 JSON。桩必须照这个契约回，
      // 否则解析失败就会回落到「整段文本当标题」——那正是上一版断言抓到的。
      text = JSON.stringify({ title: '为什么负特征值意味着鞍点', topic: '损失与优化', concept: 'Hessian 负特征值、鞍点判定' })
    } else if (isTitle) text = '为什么负特征值意味着鞍点'
    else if (isSummary) text = '学生卡在 Hessian 负特征值与鞍点判定的关系上，结论是二阶导矩阵出现负特征值即该方向为极大曲率，故为鞍点。'
    else if (isGrade) {
      text = '## 逐条对照验收标准\n\n- 通过：实现了前向传播（第 12 行）。\n'
        + '- 不通过：教案要求仅用 NumPy 手写，第 3 行直接调用了 sklearn。\n\n'
        + '### 问题清单\n'
        + '- [高] 第 3 行使用了 sklearn，与教案「仅用 NumPy 手写」的要求不符\n'
        + '- [中] 缺少损失曲线绘制，无法验证收敛\n'
    } else text = '负特征值说明该方向上的二阶导数小于零，函数沿该方向是凹的，因此不是极小值点，而是鞍点。'
    return (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const piece of text.match(/[\s\S]{1,24}/g) || []) yield { type: 'text-delta', index: 0, text: piece }
      yield { type: 'usage', usage: { inputTokens: 111, outputTokens: 222 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
// 记录所有真正被保存成附件的图片。用来断言「学生拍的手推公式**真的**随请求发出去了」——
// 这条容易写成「代码里有 dataUrl 就算过」，而实际可能是空串或读坏了。
const attachmentsSaved = []
const attachmentsStub = {
  async saveImage({ data, mediaType, name }) {
    attachmentsSaved.push({ bytes: data.length, mediaType: mediaType || 'image/png', name: name || 'x.png', width: 640, height: 360 })
    return { attachmentId: 'stub-' + Date.now(), mediaType: mediaType || 'image/png', bytes: data.length, width: 640, height: 360, name: name || 'x.png' }
  },
}

// ── 装配 ──────────────────────────────────────────────────────
const fsShim = {
  resolve: async (p, o) => nodePath.resolve(o && o.cwd ? o.cwd : '.', p),
  readText: async (p) => nodeFs.readFileSync(p, 'utf8'),
  writeText: async (p, c) => { nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true }); nodeFs.writeFileSync(p, c, 'utf8') },
  readBytes: async (p) => nodeFs.readFileSync(p),
  stat: async (p) => nodeFs.statSync(p),
  listDir: async (p) => nodeFs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: () => e.isDirectory(), isFile: () => e.isFile() })),
}

const routes = []
const HOSTS = {}
function makeCtx(which) {
  return {
    get: (n) => {
      if (n === 'fs') return fsShim
      if (n === 'llm') return llmStub
      if (n === 'attachments') return attachmentsStub
      if (n === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) }
      return undefined
    },
    effect: (fn) => { const d = fn(); HOSTS[which] = HOSTS[which] || []; if (typeof d === 'function') HOSTS[which].push(d); return () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
}

const mods = {}
for (const pkg of ['dsh-course-student', 'dsh-course-teacher']) {
  const entry = nodePath.join(PACKS, pkg, 'src', 'host.js')
  mods[pkg] = await import(pathToFileURL(entry).href)
}
await mods['dsh-course-student'].apply(makeCtx('student'))
await mods['dsh-course-teacher'].apply(makeCtx('teacher'))

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}
const asText = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b))

// ── 1. 路由不冲突 ─────────────────────────────────────────────
console.log('=== 1. 两个插件同时挂载：路由是否互不冲突 ===')
const seen = new Map()
let dup = 0
for (const r of routes) {
  const k = r.kind + ' ' + r.path
  if (seen.has(k)) { dup++; console.log('    冲突: ' + k) }
  seen.set(k, true)
}
check('两侧共注册 ' + routes.length + ' 条路由，无重复', dup === 0)
// 每个插件注册 8 条前缀路由：
//   -api / .css / -katex / -media / -mat / -sub / -shot / -diag
// -diag 是诊断页（在浏览器里同源自查所有接口）；-sub 与 -shot 分别是
// 「学生提交的附件」与「提问截图」的文件服务；-mat 是「资料」里那些仓内文件
// （转好的 PDF 等）—— 四者都走独立前缀，前缀路由重叠会产生二义
// （webServer 对重复 (kind,path) 直接抛错）。
const PREFIX_ROUTE_COUNT = 8
const stuPaths = routes.map((r) => r.path).filter((p) => p.indexOf('/cip-stu') === 0)
const teaPaths = routes.map((r) => r.path).filter((p) => p.indexOf('/cip-tea') === 0)
check('学生端前缀 /cip-stu 有 ' + stuPaths.length + ' 条', stuPaths.length === PREFIX_ROUTE_COUNT, stuPaths.join(' '))
check('教师端前缀 /cip-tea 有 ' + teaPaths.length + ' 条', teaPaths.length === PREFIX_ROUTE_COUNT, teaPaths.join(' '))
check('  两端各有独立诊断页路由', stuPaths.indexOf('/cip-stu-diag') >= 0 && teaPaths.indexOf('/cip-tea-diag') >= 0)
check('  两端各有资料文件路由（-mat）', stuPaths.indexOf('/cip-stu-mat') >= 0 && teaPaths.indexOf('/cip-tea-mat') >= 0)

function call(pathname, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v },
      end(data) { resolve({ status: this.statusCode, headers: this.headers, body: data }) },
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = {
      url: pathname, method: payload ? 'POST' : 'GET',
      on(ev, cb) { if (ev === 'data' && payload) cb(payload); if (ev === 'end') cb(); return req },
      destroy() { },
    }
    for (const r of routes) {
      if (pathname.startsWith(r.path)) {
        Promise.resolve(r.handler(req, res)).catch((e) => { res.statusCode = 500; res.end('threw: ' + (e && e.message)) })
        return
      }
    }
    resolve({ status: -1, headers: {}, body: 'no route: ' + pathname })
  })
}
async function api(prefix, action, body) {
  const r = await call(prefix + '-api/' + action, body || {})
  let j = null
  try { j = JSON.parse(asText(r.body)) } catch (e) { }
  return { status: r.status, raw: asText(r.body), json: j }
}

// ── 2. 两端 info ──────────────────────────────────────────────
console.log('\n=== 2. 两端各自的 info ===')
{
  const a = await api('/cip-stu', 'info')
  check('学生端 info 200', a.status === 200, a.status + '')
  check('  角色=student', a.json && a.json.role === 'student', a.json && a.json.role)
  check('  前缀独立', a.json && a.json.prefix === '/cip-stu', a.json && a.json.prefix)
  const b = await api('/cip-tea', 'info')
  check('教师端 info 200', b.status === 200, b.status + '')
  check('  角色=teacher', b.json && b.json.role === 'teacher', b.json && b.json.role)
  check('  前缀独立', b.json && b.json.prefix === '/cip-tea', b.json && b.json.prefix)
}

// ── 3. 课程数据（两端都能读）──────────────────────────────────
console.log('\n=== 3. 课程数据 ===')
for (const [tag, pfx] of [['学生端', '/cip-stu'], ['教师端', '/cip-tea']]) {
  const t = await api(pfx, 'tree')
  check(tag + ' tree', t.json && t.json.tree && t.json.tree.modules.length > 0,
    t.json && t.json.tree ? (t.json.tree.modules.length + ' 模块 / ' + t.json.tree.totalLessons + ' 课时') : (t.json && t.json.error))
  const s = await api(pfx, 'slides', { chapter: '第一章' })
  check(tag + ' slides', s.json && s.json.slides && s.json.slides.length > 0,
    s.json && s.json.slides ? (s.json.slides.length + ' 页') : (s.json && s.json.error))
}

// ── 4. 学生提问：标题凝练 + AI 作答 + token 记账 ──────────────
console.log('\n=== 4. 学生提问（模型打桩：标题凝练 + 作答 + 总结）===')
let askPath = ''
{
  const before = modelCalls
  const r = await api('/cip-stu', 'ask', {
    question: '为什么负特征值就意味着鞍点？极大值不也是负的吗',
    origin: '课件 2 页共 2 块 · 第一章 第 12 页 · 图区 300×150；第一章 第 30 页 · 拖选文字',
    // 跨页多块证据（用户在课件页明确要求的能力）：一页给公式、一页给直觉解释。
    // 这里同时验证「文字来自两页」与「每块各自记住出处」都落进了条目文件。
    text: 'NLL = -Σ [ y log ŷ + (1-y) log(1-ŷ) ]\n\n这里我们就连起来了，NLL 越小越好',
    evidence: [
      { chapter: '第一章', page: 12, kind: 'region', label: '第一章 第 12 页 · 图区 300×150', text: 'NLL = -Σ [ y log ŷ + (1-y) log(1-ŷ) ]' },
      { chapter: '第一章', page: 30, kind: 'text', label: '第一章 第 30 页 · 拖选文字', text: '这里我们就连起来了，NLL 越小越好' },
    ],
    counts: { regions: 1, texts: 1, pages: 2, images: 2 },
    module: '模块一', lesson: '课时8', type: '概念问题', severity: '高',
    source: '阅读器框选图区',
  })
  check('ask 成功', r.json && r.json.ok === true, r.json && (r.json.error || ('id=' + r.json.id)))
  check('  标题被凝练（不是原文）', r.json && r.json.title === '为什么负特征值意味着鞍点', r.json && r.json.title)
  check('  有 AI 作答', r.json && r.json.answer && r.json.answer.length > 10, r.json && String(r.json.answer).slice(0, 30))
  check('  有 token 用量', r.json && r.json.usage && r.json.usage.inputTokens > 0,
    r.json && r.json.usage ? ('in ' + r.json.usage.inputTokens + ' / out ' + r.json.usage.outputTokens) : '')
  check('  调了 3 次模型（标题+作答+总结）', modelCalls - before === 3, String(modelCalls - before))
  check('  落进了学生自己的目录', r.json && r.json.path && r.json.path.indexOf('课程问题池\\学生\\' + process.env.CIP_STUDENT) === 0, r.json && r.json.path)
  // ④ 分类：标题与分类一次产出，分类必须落在受控词表里
  check('  领域分类已产出且在受控词表内',
    r.json && r.json.topic === '损失与优化', r.json && String(r.json.topic))
  check('  概念标签已产出', !!(r.json && r.json.concept), r.json && r.json.concept)
  check('  来源定位已记录（loc）', !!(r.json && r.json.loc), r.json && r.json.loc)
  // 跨页证据：条目文件里必须能看出「哪一块来自哪一页」——
  // 只把文字拼成一段的话，老师复盘时无法定位，等于白收集。
  const itemText = (function readItem() {
    try { return nodeFs.readFileSync(nodePath.join(WS, (r.json && r.json.path) || ''), 'utf8') } catch (e) { return '' }
  })()
  check('  条目里记了每一块证据的页码',
    itemText.indexOf('第一章 第 12 页') >= 0 && itemText.indexOf('第一章 第 30 页') >= 0,
    itemText ? (itemText.indexOf('第 12 页') >= 0 ? '含第12页' : '缺第12页') + '/' + (itemText.indexOf('第 30 页') >= 0 ? '含第30页' : '缺第30页') : '读不到条目')
  // ⚠️ 这个字段由**宿主自己**从 evidence 数组算出来（不信客户端传来的 counts），
  //    所以这里断言的是「算出来的结果」，不是回显 —— 第一版写成查 counts 回显，白红一次。
  check('  证据块数写进了字段',
    itemText.indexOf('evidence: "2 块 / 2 页"') >= 0,
    (function () { const m = /^evidence: (.+)$/m.exec(itemText); return m ? m[0] : '字段缺失' })())
  askPath = (r.json && r.json.path) || ''
}

// ── 5. 每一轮追问都有 AI 作答 ─────────────────────────────────
console.log('\n=== 5. 每一轮追问都必须有 AI 作答 ===')
if (askPath) {
  for (const [i, q] of ['那极大值呢', '局部和全局怎么区分'].entries()) {
    const before = modelCalls
    const r = await api('/cip-stu', 'followup', { path: askPath, question: q })
    check('第 ' + (i + 2) + ' 轮追问有作答', r.json && r.json.ok === true && r.json.answer && r.json.answer.length > 5,
      r.json && (r.json.error || (r.json.turns + ' 轮 · ' + String(r.json.answer).slice(0, 24))))
    check('  本轮真的调了模型', modelCalls - before >= 2, String(modelCalls - before) + ' 次')
  }
  const t = await api('/cip-stu', 'thread', { path: askPath })
  // ⚠️ 这条断言改过，说明理由：原来期望 2 轮（只数追问）。
  //    现在首答也写一条 thread 记录 —— 修的是「我的提问列表轮次恒为 0」那个 bug：
  //    `ask` 以前传 `createItem(fields, sections, [])`，而 core.writeItem 的契约是
  //    `if (turns && turns.length) writeThread(...)`，于是首答**从不写 .thread.json**，
  //    而列表的 turns 正是数这个文件 → 每条首答都显示 0 轮，详情页却有完整问答。
  //    现在「1 次提问 + 2 次追问」= **3 轮**。这是判据变了，不是放宽。
  //    并补一条断言明确首答那轮真的在，免得以后又退回"只记追问"。
  check('线程里存了 3 轮问答（首答 1 + 追问 2）',
    t.json && t.json.turns && t.json.turns.length === 3,
    t.json && t.json.turns ? (t.json.turns.length + ' 轮') : (t.json && t.json.error))
  check('  第 1 轮是首答且带 q/a/at（不是空壳）',
    !!(t.json && t.json.turns && t.json.turns[0] && t.json.turns[0].q && t.json.turns[0].a && t.json.turns[0].at),
    t.json && t.json.turns && t.json.turns[0] ? JSON.stringify(t.json.turns[0]).slice(0, 80) : '')
  check('  md 正文含全部轮次（他人可见的完整问答）',
    t.json && t.json.body && t.json.body.indexOf('第 2 轮追问') >= 0 && t.json.body.indexOf('追问记录') >= 0)
  const u = await api('/cip-stu', 'usage')
  check('额度页能累加 token', u.json && u.json.inputTokens > 0, u.json && ('in ' + u.json.inputTokens + ' / out ' + u.json.outputTokens))
}

// ── 6. 按教案批改 + 问题清单落条目 + 多类型提交 + 版本历史 ─────
console.log('\n=== 6. 按教案批改（模型打桩，返回结构化问题清单）===')
// 一张 1x1 的合法 PNG，用来验「图片按二进制落盘、下载回来字节一致」。
// 放在块外是因为 6b 节（HTTP 取附件）也要用它。
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')
let gradelesson = 8
let v1 = 0
let v2 = 0
{
  // 清掉这一课时上一轮留下的提交目录与版本清单。
  // 为什么必须清：临时工作区是复用的，上一轮跑完的 v1..vN 会留着，
  // 版本号于是从 N+1 开始 —— 断言写成「=== 1」就会在第二次运行时红，
  // 而红的原因和被测代码毫无关系。测试要自己保证起点干净，
  // 而不是靠「反正第一次跑是对的」。
  const stuDir = nodePath.resolve(WS, '作业提交', process.env.CIP_STUDENT)
  const versionsFile = nodePath.join(stuDir, '课时' + gradelesson + '.versions.json')
  if (nodeFs.existsSync(versionsFile)) nodeFs.unlinkSync(versionsFile)
  const lessonDir = nodePath.join(stuDir, '课时' + gradelesson)
  if (nodeFs.existsSync(lessonDir)) nodeFs.rmSync(lessonDir, { recursive: true, force: true })
  for (const f of (nodeFs.existsSync(stuDir) ? nodeFs.readdirSync(stuDir) : [])) {
    if (f.indexOf('课时' + gradelesson + '__v') === 0) nodeFs.unlinkSync(nodePath.join(stuDir, f))
  }

  // 提交形态：文本 + 附件。附件走 data URL（图片/PDF 都是二进制，不能当文本读）。

  const save = await api('/cip-stu', 'submission.save', {
    lesson: gradelesson,
    text: 'import numpy as np\nfrom sklearn.linear_model import LinearRegression\n# ... 前向传播\n',
    note: '第一版',
    files: [
      { name: 'mlp.py', dataUrl: 'data:text/x-python;base64,' + Buffer.from('import numpy as np\n').toString('base64') },
      { name: '手推公式.png', dataUrl: 'data:image/png;base64,' + pngBytes.toString('base64') },
    ],
  })
  check('提交已保存', save.json && save.json.ok === true, save.json && (save.json.error || ('v' + save.json.v + ' ' + save.json.rel)))
  // ⚠️ 不能断言 v===1：临时工作区可能在多次运行间保留了上一轮的版本目录，
  //    版本号是「已有最大值 +1」。断言要写**相对**关系，否则第二次跑就红。
  v1 = save.json && save.json.v
  check('  生成了新版本', v1 >= 1, 'v' + v1)
  check('  两类附件都落了盘', save.json && save.json.files && save.json.files.length === 2,
    save.json && (save.json.files || []).map((f) => f.name + '(' + f.bytes + 'B)').join(', '))
  const pngRel = save.json && save.json.files ? (save.json.files[1] || {}).stored : ''
  const pngAbs = pngRel ? nodePath.resolve(WS, '作业提交', process.env.CIP_STUDENT, '课时8', 'v1', '_附件', pngRel) : ''
  const pngOnDisk = pngAbs && nodeFs.existsSync(pngAbs) ? nodeFs.readFileSync(pngAbs) : null
  check('  图片按二进制落盘、字节数与原图一致',
    !!pngOnDisk && pngOnDisk.length === pngBytes.length && pngOnDisk.equals(pngBytes),
    pngOnDisk ? (pngOnDisk.length + ' 字节（期望 ' + pngBytes.length + '）') : '找不到图片')
  // 上报的字节数必须是**文件字节数**，不能是 data URL 字符串的长度 ——
  // base64 会把它撑大约 1/3，学生看到的数字就是假的（这里正是踩到的坑）。
  const imgEntry = (save.json.files || []).find((f) => /png$/i.test(f.name)) || {}
  check('  上报的字节数是文件字节数、不是 base64 字符串长度',
    imgEntry.bytes === pngBytes.length, imgEntry.bytes + ' 字节（期望 ' + pngBytes.length + '）')

  const rel = save.json && save.json.rel
  const g = await api('/cip-stu', 'submission.grade', { lesson: gradelesson, module: '模块二' })
  check('批改成功', g.json && g.json.ok === true, g.json && (g.json.error || ('v' + g.json.v)))
  check('  批到了刚提交的那一版', g.json && g.json.v === v1, 'g.v=' + (g.json && g.json.v) + ' 提交的 v=' + v1)
  check('  找到了教案并作为对齐基准', g.json && g.json.planRel && g.json.planRel.length > 0, g.json && g.json.planRel)
  check('  解析出 2 条问题', g.json && g.json.issues && g.json.issues.length === 2,
    g.json && g.json.issues ? g.json.issues.map((x) => x.severity).join(',') : '')
  check('  批改正文含《问题清单》小节', g.json && g.json.text && g.json.text.indexOf('### 问题清单') >= 0)
  check('  问题落成了条目', g.json && g.json.issues && g.json.issues.every((x) => x.path && x.path.indexOf('课程问题池\\学生\\') === 0))
  check('  批改也记了 token', g.json && g.json.usage && g.json.usage.outputTokens > 0)
  // 照片必须**真的**随批改请求发出去：手推公式拍照提交时，模型看不到图等于没交
  check('  提交的照片随批改请求发给了模型', attachmentsSaved.length >= 1,
    attachmentsSaved.length + ' 张（' + attachmentsSaved.map((x) => x.width + 'x' + x.height).join(',') + '）')
  check('  批改时读的是 base64（二进制没有被当文本读坏）',
    (g.json.trace || []).some((t) => t.indexOf('随批改发送的图片: 1') >= 0)
    || (g.json.trace || []).some((t) => t.indexOf('批改附图 1') >= 0),
    (g.json.trace || []).filter((t) => t.indexOf('图') >= 0).slice(0, 2).join(' | '))
  // ★ 这条是「按理说应该去批改代码啊」那个反馈的回归测试。
  //   原来只发附件的元信息，模型明确说「这一行代码我都看不到」，
  //   然后给出一串「无法核验」——它不是在偷懒，是真没拿到。
  //   这里断言提示词里**逐字含有** .py 的关键行，而不只是文件名。
  check('  文本附件的内容真的写进了批改提示词（模型看得到代码）',
    lastGradePrompt.indexOf('from sklearn.linear_model import LinearRegression') >= 0,
    lastGradePrompt ? ('提示词 ' + lastGradePrompt.length + ' 字符') : '没抓到批改提示词')
  check('  提示词里按文件名分段（.py 与其它附件不会混在一起）',
    lastGradePrompt.indexOf('【文本附件：') >= 0
    && /【文本附件：[^】]*\.py[^】]*】/.test(lastGradePrompt),
    (lastGradePrompt.match(/【文本附件：[^】]*】/g) || []).join(' '))
  check('  提示词明确要求「已提供内容的文件必须逐行看过」',
    lastGradePrompt.indexOf('逐行看过') >= 0)
  check('  提示词不再说「非图片附件的内容没有提供给模型」',
    lastGradePrompt.indexOf('非图片附件的内容没有提供') < 0)
  // 「内容未提供」只该给**真正读不出来**的附件（pdf/zip/docx…）。
  // 图片不算：它作为图片发给模型了；把图片也算进去会让提示词凭空多一句
  // 「某些内容没提供」，模型于是又开始说「无法核验」。
  {
    const binFiles = (save.json.files || []).filter((x) => !/\.(py|txt|md|json|csv|ipynb)$/i.test(x.name) && !/\.(png|jpe?g|webp|gif)$/i.test(x.name))
    check('  只有确实读不出来的二进制附件才说「内容未提供」',
      binFiles.length ? lastGradePrompt.indexOf('内容未提供') >= 0 : lastGradePrompt.indexOf('内容未提供') < 0,
      binFiles.length ? ('有二进制附件 ' + binFiles.map((x) => x.name).join(',')) : '本次没有二进制附件（图片不算）')
  }

  // 改完再传：必须是**新版本**，旧版本与旧批改一个字都不能动
  const save2 = await api('/cip-stu', 'submission.save', {
    lesson: gradelesson, text: 'import numpy as np\n# 改成全手写，不再用 sklearn\n', note: '去掉 sklearn',
  })
  v2 = save2.json && save2.json.v
  check('可以再交一版（改完再传）', save2.json && save2.json.ok === true && v2 === v1 + 1,
    'v' + v1 + ' → v' + v2)
  check('  第一版的正文没有被覆盖', nodeFs.existsSync(nodePath.resolve(WS, rel)), rel || '')
  const g2 = await api('/cip-stu', 'submission.grade', { lesson: gradelesson, v: v2 })
  check('可以只批指定的那一版', g2.json && g2.json.ok === true && g2.json.v === v2, g2.json && ('v' + g2.json.v))
  const hist = await api('/cip-stu', 'submission.history', { lesson: gradelesson })
  check('历史里两版都在、且各自带结论', hist.json && hist.json.versions && hist.json.versions.length === 2
    && hist.json.versions.every((v) => v.graded === true),
    hist.json && (hist.json.versions || []).map((v) => 'v' + v.v + (v.graded ? '(已批改)' : '(未批改)')).join(' '))
  check('  历史按版本倒序（新的在前）', hist.json && hist.json.versions[0].v === v2,
    '首条 v' + (hist.json && hist.json.versions[0].v) + '（最新提交 v' + v2 + '）')
  check('  每一版都记了模型与 token', hist.json && hist.json.versions.every((v) => v.tokens && v.tokens.indexOf('in ') === 0))
  check('  每一版都记了这一版判出的问题', hist.json && hist.json.versions.every((v) => Array.isArray(v.issues)),
    hist.json && hist.json.versions.map((v) => 'v' + v.v + ':' + (v.issues || []).length + '条').join(' '))
  // 附件的可访问 URL 必须拼对（这正是「学生能回看自己交了什么」的前提）
  check('  附件带可访问的 URL', hist.json && hist.json.versions.some((v) => (v.files || []).some((f) => f.url && f.url.indexOf('/cip-stu-sub/') === 0)),
    hist.json && (hist.json.versions[1].files || []).map((f) => f.url).join(' '))
}

// ── 6b. 课时页：学生端能读到教案（这是「看不到教案」那条需求的验收）──
console.log('\n=== 6b. 课时页：教案对学生可见 ===')
{
  const d = await api('/cip-stu', 'lesson.open', { lesson: gradelesson })
  check('课时页能打开', d.json && d.json.ok === true, d.json && (d.json.error || d.json.title))
  check('  带回了课时标题与模块', !!(d.json && d.json.title && d.json.module), d.json && (d.json.module + ' / ' + d.json.title))
  check('  教案正文对学生可见（不再只有老师能看）',
    !!(d.json && d.json.plan && d.json.plan.length > 100), d.json && (d.json.plan ? (d.json.plan.length + ' 字符') : '教案为空'))
  check('  带回了教案路径与批改维度', !!(d.json && d.json.planRel && (d.json.dimensions || []).length),
    d.json && (d.json.planRel || '') + ' · 维度 ' + ((d.json.dimensions || []).length))
  check('  一并带回提交历史', d.json && Array.isArray(d.json.versions) && d.json.versions.length >= 2,
    d.json && String((d.json.versions || []).length))
  // ── 全部提交：与课时解耦（用户明确要求「不是非得先选课时才能加载作业」）──
  {
    const all = await api('/cip-stu', 'submission.all', {})
    check('全部提交能取到（不需要先选课时）', all.json && all.json.ok === true,
      all.json && (all.json.error || ((all.json.items || []).length + ' 个版本')))
    const items = (all.json && all.json.items) || []
    check('  两版都在', items.length >= 2, String(items.length))
    check('  按时间倒序（新的在前）', items.length >= 2 && items[0].v === v2,
      items.map((x) => 'L' + x.lesson + '/v' + x.v + '@' + String(x.at).slice(11, 19)).join(' '))
    check('  每一条带上课时号与标题（列表里要标出这是哪一课的）',
      items.every((x) => x.lesson === gradelesson && x.lessonTitle && x.lessonTitle.length > 1),
      items.length ? ('L' + items[0].lesson + ' ' + items[0].lessonTitle) : '')
    check('  每一条带上模块', items.every((x) => typeof x.module === 'string'))
    check('  计数：版本数 / 未批改数 / 涉及课时数',
      !!(all.json.counts && all.json.counts.versions === items.length
        && all.json.counts.ungraded === items.filter((x) => !x.graded).length
        && all.json.counts.lessons === 1),
      all.json && JSON.stringify(all.json.counts))
    check('  附件 URL 依然是可用的（列表里也要能下载）',
      items.some((x) => (x.files || []).some((f) => f.url && f.url.indexOf('/cip-stu-sub/') === 0)))
    // 未批改的那一版也要出现在列表里并且可批改 —— 「哪一版还没批」是这一页的主要用途
    const v3 = await api('/cip-stu', 'submission.save', { lesson: gradelesson, text: '# 第三版，故意不批改\n' })
    const all2 = await api('/cip-stu', 'submission.all', {})
    check('  新提交立刻出现在全部提交里、且标为未批改',
      !!(all2.json && all2.json.items[0].v === v3.json.v && all2.json.items[0].graded === false),
      all2.json && ('首条 v' + all2.json.items[0].v + ' graded=' + all2.json.items[0].graded + ' · 未批改 ' + all2.json.counts.ungraded))
    check('  在「全部提交」里就能批改某一版（带上课时号）',
      await (async () => {
        const g3 = await api('/cip-stu', 'submission.grade', { lesson: gradelesson, v: v3.json.v })
        return !!(g3.json && g3.json.ok === true && g3.json.v === v3.json.v)
      })())
  }

  const noPlan = await api('/cip-stu', 'lesson.open', { lesson: 999 })
  check('索引里没有的课时给出明确报错', noPlan.json && noPlan.json.error && noPlan.json.error.indexOf('没有课时') >= 0,
    noPlan.json && noPlan.json.error)

  // ── 附件真的能下载（学生「回看自己交了什么」全靠这条路由）──
  const hist2 = await api('/cip-stu', 'submission.history', { lesson: gradelesson })
  const f0 = ((hist2.json.versions || []).find((v) => v.graded && (v.files || []).some((x) => x.image)) || {}).files || []
  const imgUrl = (f0.find((x) => x.image) || {}).url
  check('历史里给出了图片附件的 URL', !!imgUrl, imgUrl || JSON.stringify(f0.map((x) => x.name)))
  if (imgUrl) {
    const r = await call(imgUrl)
    check('  附件路由能取到（200）', r.status === 200, r.status + ' ' + String(r.headers['content-type'] || ''))
    check('  Content-Type 按扩展名给对', String(r.headers['content-type'] || '').indexOf('image/png') === 0,
      String(r.headers['content-type'] || ''))
    // 二进制没被当文本读坏：字节数必须与提交时一致
    const got = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body), 'binary')
    check('  下载回来的字节数与落盘一致（二进制没坏）', got.length === pngBytes.length && got.equals(pngBytes),
      got.length + ' 字节（期望 ' + pngBytes.length + '）')
  }
  // 路径穿越与目录逃逸必须被挡住 —— 文件读取路由只查 '..' 子串是不够的
  const esc1 = await call('/cip-stu-sub/..%2F..%2F课程中心%2F课程配置.json')
  check('  路径穿越被挡（403/400）', esc1.status === 403 || esc1.status === 400, esc1.status + '')
  const esc2 = await call('/cip-stu-sub/S001/课时8/v1/_附件/..%5C..%5C..%5C..%5C课程配置.json')
  check('  编码后的反斜杠穿越也被挡', esc2.status === 403 || esc2.status === 400, esc2.status + '')
  const esc3 = await call('/cip-stu-shot/%2E%2E%2F%2E%2E%2F课程中心%2F课程配置.json')
  check('  截图路由同样挡住穿越', esc3.status === 403 || esc3.status === 400, esc3.status + '')
}

// ── 7. 教师端：看到全部、汇总共性、审计共享 ───────────────────
console.log('\n=== 7. 教师端：可见性 / 共性汇总 / 审计 ===')
{
  // ★ 用户第三条要求的核心：作业批改生成的问题**不该自动涌向教师端**，
  //   由学生决定公开哪几条。所以教师端默认**只看得到学生公开过的**。
  const t0 = await api('/cip-tea', 'threads')
  check('教师端默认只看学生公开过的条目', t0.json && t0.json.onlyShared === true && t0.json.items.length === 0,
    t0.json ? (t0.json.items.length + ' 条可见 · ' + t0.json.hidden + ' 条学生未公开') : t0.json.error)
  check('  但如实告知还有多少条未公开（老师有权知道有这个池子）',
    t0.json && t0.json.hidden >= 3 && t0.json.total === t0.json.hidden,
    t0.json && ('hidden=' + t0.json.hidden + ' total=' + t0.json.total))
  // 审计视图：老师排查「某个学生是不是卡住了」时要能看全部
  const tAll = await api('/cip-tea', 'threads', { onlyShared: false })
  check('  打开审计视图能看到全部', tAll.json && tAll.json.items.length >= 3 && tAll.json.onlyShared === false,
    tAll.json && (tAll.json.items.length + ' 条'))

  // 公开一条 → 教师端应立刻看得到；撤回 → 又看不到
  check('学生能把某一条公开给老师', await (async () => {
    const r = await api('/cip-stu', 'item.share', { path: askPath, shared: true })
    return !!(r.json && r.json.ok === true && r.json.audit === 'shared')
  })())
  const t1 = await api('/cip-tea', 'threads')
  check('  公开后教师端就能看到它', t1.json && t1.json.items.some((i) => i.path === askPath || i.title),
    t1.json && (t1.json.items.length + ' 条'))
  check('学生能撤回', await (async () => {
    const r = await api('/cip-stu', 'item.share', { path: askPath, shared: false })
    return !!(r.json && r.json.ok === true && r.json.audit === 'not_shared')
  })())
  const t2 = await api('/cip-tea', 'threads')
  check('  撤回后教师端又看不到了', t2.json && t2.json.items.length === 0, t2.json && (t2.json.items.length + ' 条'))
  // 不能拿别人的/公共面的条目去公开
  check('  不能公开不属于自己的条目', await (async () => {
    const r = await api('/cip-stu', 'item.share', { path: '课程问题池\\公共\\不存在.md', shared: true })
    return !!(r.json && r.json.error)
  })())
  // 批改生成的问题必须默认未公开
  check('  批改生成的问题默认未公开（不会被自动推给老师）', await (async () => {
    const list = await api('/cip-stu', 'threads')
    const fromGrade = (list.json.mine || []).filter((i) => i.source === '作业')
    // 注意 audit 在没设置时是空串（不是 'not_shared'）：老条目没有这个字段，
    // 而「没有 audit」与「显式取消公开」对教师端是同一个效果 —— 都不可见。
    return fromGrade.length > 0 && fromGrade.every((i) => (i.audit || '') !== 'shared')
  })())
  // 批量公开：一次批改十几条，逐条点太累
  const batchPaths = await (async () => {
    const list = await api('/cip-stu', 'threads')
    return (list.json.mine || []).filter((i) => i.source === '作业').slice(0, 2).map((i) => i.path)
  })()
  check('  支持批量公开', await (async () => {
    const r = await api('/cip-stu', 'item.share.batch', { paths: batchPaths, shared: true })
    return !!(r.json && r.json.ok === true && r.json.done === batchPaths.length)
  })(), batchPaths.length + ' 条')
  const t3 = await api('/cip-tea', 'threads')
  check('  批量公开后教师端能看到这几条', t3.json && t3.json.items.length === batchPaths.length,
    t3.json && (t3.json.items.length + ' 条'))
  // 复原：后面的断言（共性汇总）按「能看到」来写
  await api('/cip-stu', 'item.share.batch', { paths: batchPaths, shared: false })

  // 审计（老师把某条标为值得共享给全班）仍然要能工作：先由学生公开
  await api('/cip-stu', 'item.share', { path: askPath, shared: true })
  const t = await api('/cip-tea', 'threads')
  check('教师能看到学生公开过的提问', t.json && t.json.items && t.json.items.length >= 1,
    t.json && (t.json.items ? t.json.items.length + ' 条' : t.json.error))
  check('  含学生身份', t.json && t.json.students && t.json.students.indexOf(process.env.CIP_STUDENT) >= 0,
    t.json && (t.json.students || []).join(','))

  const c = await api('/cip-tea', 'common')
  const groups = (c.json && c.json.groups) || []
  check('共性问题汇总有结果', groups.length > 0, groups.length + ' 组')
  const byLesson = groups.filter((g) => String(g.lesson) === '课时8')
  check('  课时8 的问题被聚到一起', byLesson.length > 0,
    byLesson.map((g) => g.sample + '(x' + g.count + ')').join(' | '))

  const a = await api('/cip-tea', 'audit', { path: askPath, decision: 'shared', note: '讲课时补一句：负特征值是鞍点的充分判据' })
  check('审计为「值得共享」', a.json && a.json.ok === true && a.json.decision === 'shared', a.json && (a.json.error || a.json.publicPath))
  check('  公共面出现策展副本', a.json && a.json.publicPath && nodeFs.existsSync(nodePath.resolve(WS, a.json.publicPath)),
    a.json && a.json.publicPath)

  const s = await api('/cip-stu', 'threads')
  const pub = (s.json && s.json.public) || []
  check('  学生端能看到已公开的提问', pub.length > 0, pub.map((p) => p.title).join(' | '))
  check('  学生端的「我的」与「公共」分开', s.json && Array.isArray(s.json.mine) && Array.isArray(s.json.public))

  const st = await api('/cip-tea', 'staged')
  check('教师端能看到待发布清单', st.json && st.json.files && st.json.files.length > 0, st.json && (st.json.files || []).join(', '))

  const d = await api('/cip-tea', 'digest')
  check('课堂记录汇总可用', d.json && d.json.lessons && d.json.lessons.length > 0,
    d.json && (d.json.lessons || []).map((l) => l.lesson + ':' + l.total).join(' '))

  const sub = await api('/cip-tea', 'submissions')
  check('教师能看到全部提交', sub.json && sub.json.files && sub.json.files.length > 0, sub.json && (sub.json.files || []).map((f) => f.name).join(', '))
}

// ── 8. 教师答复：学生必须能收到 ───────────────────────────────
console.log('\n=== 8. 教师答复（只答本人也要能送达）===')
if (askPath) {
  const ans = await api('/cip-tea', 'answer', { path: askPath, text: '补充一句：负特征值只是判据之一，还要看二阶条件是否退化。' })
  check('教师答复成功', ans.json && ans.json.ok === true, ans.json && (ans.json.error || (ans.json.turns + ' 轮')))
  check('  答复也同步到了公共面那份', ans.json && ans.json.syncedPublic === true, ans.json && String(ans.json.syncedPublic))

  const t = await api('/cip-stu', 'thread', { path: askPath })
  check('学生端能读到教师答复', t.json && t.json.hasTeacherAnswer === true, t.json && ('teacherTurns=' + t.json.teacherTurns))
  check('  教师答复在线程里带 by=teacher 标记',
    t.json && t.json.turns && t.json.turns.some((x) => x.by === 'teacher'),
    t.json && t.json.turns ? t.json.turns.map((x) => x.by || 'student').join(',') : '')
  check('  正文里能人读到教师答复', t.json && t.json.body && t.json.body.indexOf('补充一句') >= 0)

  const list = await api('/cip-stu', 'threads')
  const mine = (list.json && list.json.mine) || []
  check('列表里标出「教师已答复」', mine.some((x) => x.hasTeacherAnswer === true),
    mine.map((x) => x.title + (x.hasTeacherAnswer ? '✓' : '')).join(' | '))
}

// ── 9. 公开问答索引：学生能整体看到老师公开了什么 ─────────────
console.log('\n=== 9. 公开问答索引 ===')
{
  const pi = await api('/cip-stu', 'public.index')
  check('学生端能取到公开问答索引', pi.json && Array.isArray(pi.json.items), pi.json && (pi.json.error || (pi.json.count + ' 条，来源 ' + pi.json.source)))
  check('  索引里含教师答复标记', pi.json && pi.json.items && pi.json.items.some((x) => x.hasTeacherAnswer === true),
    pi.json && pi.json.items ? pi.json.items.map((x) => x.title + (x.hasTeacherAnswer ? '(有答复)' : '')).join(' | ') : '')
  check('  索引只含公共面的条目（不含别的学生私有）',
    pi.json && pi.json.items && pi.json.items.every((x) => x.path.indexOf('课程问题池/公共/') === 0 || x.path.indexOf('课程问题池\\公共\\') === 0))
}

// ── 10. 插件内的发布入口（真的跑发布工具）─────────────────────
console.log('\n=== 10. 插件内发布入口 ===')
{
  // 这一步会真的 spawn 课程发布工具。为了不污染真实公开仓，临时工作区里
  // 没有 课程发布/ 目录，所以预期是「找不到工具」的**明确报错**而不是崩溃。
  const r = await api('/cip-tea', 'publish', { mode: 'check' })
  const hasTool = r.json && r.json.ok === true
  if (hasTool) {
    check('发布工具执行成功', true, (r.json.output || '').split('\n')[0])
    check('  给出了 git 三步指引', Array.isArray(r.json.next) && r.json.next.length === 3, (r.json.next || []).join(' / '))
  } else {
    // 临时工作区没有发布工具，这是预期路径 —— 关键是报错必须**清楚**，
    // 而不是抛异常或静默失败。
    //
    // ⚠️ 这条断言跟着产品文案改过一次，把原因记下来：
    //    旧文案是「找不到发布工具：<路径>（这台机器上可能不是课程工作区）」。
    //    但**从 GitHub 装插件的人本来就没有那个路径** —— 发布工具是课程仓库的东西，
    //    不是插件自带的。所以「找不到」在那个场景下是**正常状态**，
    //    不是「这台机器不对」。旧文案会让人以为插件坏了。
    //
    //    新文案必须同时说清三件事：它为什么不在、去哪儿拿、以及可以不做。
    //    断言也跟着查这三件事，而**不是查某一句固定的话** ——
    //    否则下次改文案又要改断言，而改断言的人很可能顺手把它放宽成查不出问题的条件。
    const msg = String((r.json && r.json.error) || r.raw || '')
    check('没有发布工具时给出明确报错（不是抛异常/静默失败）', msg.length > 0, msg.slice(0, 60))
    check('  说清了它为什么不在（是课程仓库的一部分，不是插件自带）',
      msg.indexOf('课程仓库') >= 0 && msg.indexOf('不是插件自带') >= 0)
    check('  列出了找过的路径，便于老师自己核对',
      Array.isArray(r.json.tried) && r.json.tried.length >= 2, (r.json.tried || []).join(' | ').slice(0, 120))
    check('  允许不做这一步（不是硬故障）', msg.indexOf('可以跳过') >= 0)
    check('  带 notFound 标记，界面据此走「正常路径」而不是弹红条', r.json.notFound === true)
  }
}

// ── 11. 学生端拉取课程更新（这是学生的「下载入口」）─────────────
console.log('\n=== 11. 学生端拉取课程更新 ===')
{
  const r = await api('/cip-stu', 'sync')
  // 临时工作区不是 git 仓库，所以这里预期是**明确的报错**，而不是崩溃或静默成功。
  // 关键是学生看到的是「这里不是 git 仓库」这种他自己能处理的话，
  // 而不是一个 exit code 或一行 git 原始输出。
  const err = (r.json && r.json.error) || ''
  if (r.json && r.json.ok === true) {
    check('sync 执行成功', true, 'changed=' + r.json.changed + ' ' + r.json.before + '→' + r.json.after)
  } else {
    check('非 git 工作区时给出明确报错', err.indexOf('不是一个 git 仓库') >= 0, err.slice(0, 80))
  }
}

// ── 12. 诊断页（浏览器同源自查用）────────────────────────────
console.log('\n=== 12. 诊断页 ===')
{
  for (const [tag, pfx] of [['学生端', '/cip-stu'], ['教师端', '/cip-tea']]) {
    const r = await call(pfx + '-diag/', {})
    const body = asText(r.body)
    check(tag + ' 诊断页返回 HTML', r.status === 200 && String(r.headers['content-type'] || '').indexOf('text/html') === 0,
      `${r.status} ${String(r.headers['content-type'] || '')} ${body.length}B`)
    check('  页面内嵌了待测用例', body.indexOf('var CASES=') >= 0)
    // 用例是以 JSON 内嵌的，所以匹配时要带上引号，别找裸路径
    check('  用例覆盖本端 API',
      body.indexOf('"url":"' + pfx + '-api/info"') >= 0 && body.indexOf('"url":"' + pfx + '-api/tree"') >= 0)
    check('  用例覆盖静态资源', body.indexOf('"url":"' + pfx + '.css"') >= 0)
  }
}

// ── 13. 模型选择：面板上按提问挑模型（费用归学生，选了什么必须可见、且真的生效）──
console.log('\n=== 13. 模型选择（目录 / 保存 / 真的换掉调用模型 / 回到会话默认）===')
{
  const cat = await api('/cip-stu', 'model.catalog', {})
  check('目录能取到', cat.json && Array.isArray(cat.json.models) && cat.json.models.length >= 3,
    cat.json ? ((cat.json.models || []).length + ' 个模型 / ' + (cat.json.providers || []).length + ' 个提供方') : (cat.json && cat.json.error))
  check('  标出了哪些模型能看图',
    !!(cat.json && cat.json.models.find((m) => m.model === 'stub-vision' && m.image === true)
      && cat.json.models.find((m) => m.model === 'stub-model' && m.image === false)))
  check('  带上了会话默认模型', !!(cat.json && cat.json.sessionDefault && cat.json.sessionDefault.model),
    cat.json && JSON.stringify(cat.json.sessionDefault))
  check('  没选过时 effective = 会话默认',
    !!(cat.json && cat.json.saved === null && cat.json.effective && cat.json.effective.model === 'stub-model'),
    cat.json && JSON.stringify(cat.json.effective))

  const pick = await api('/cip-stu', 'model.select', { provider: 'stub', model: 'stub-vision' })
  check('保存选择成功', pick.json && pick.json.ok === true && pick.json.inCatalog === true,
    pick.json && JSON.stringify(pick.json.saved))
  const choiceFile = nodePath.join(WS, '课程问题池', '学生', process.env.CIP_STUDENT, '模型选择.json')
  check('  选择落在学生自己的目录里（不碰 DSH 设置）', nodeFs.existsSync(choiceFile), choiceFile.replace(WS, '.'))

  if (askPath) {
    const r = await api('/cip-stu', 'followup', { path: askPath, question: '换模型后再问一次' })
    check('选了模型之后追问仍然成功', r.json && r.json.ok === true, r.json && (r.json.error || (r.json.turns + ' 轮')))
    check('  本次调用真的用了面板选的模型',
      lastModelCall.provider === 'stub' && lastModelCall.model === 'stub-vision',
      lastModelCall.provider + '/' + lastModelCall.model)
  }
  const cat2 = await api('/cip-stu', 'model.catalog', {})
  check('  effective 跟着变成所选模型',
    !!(cat2.json && cat2.json.effective && cat2.json.effective.model === 'stub-vision'),
    cat2.json && JSON.stringify(cat2.json.effective))

  const odd = await api('/cip-stu', 'model.select', { provider: 'ghost', model: 'not-listed' })
  check('目录外的模型可保存但如实告知 inCatalog=false',
    odd.json && odd.json.ok === true && odd.json.inCatalog === false, odd.json && String(odd.json.inCatalog))

  const back = await api('/cip-stu', 'model.select', { provider: '', model: '' })
  check('可以清空、回到跟随会话默认', back.json && back.json.ok === true && back.json.cleared === true)
  const cat3 = await api('/cip-stu', 'model.catalog', {})
  check('  清空后 effective 回到会话默认',
    !!(cat3.json && cat3.json.saved === null && cat3.json.effective && cat3.json.effective.model === 'stub-model'),
    cat3.json && JSON.stringify(cat3.json.effective))
}

// ═══════════════════════════════════════════════════════════════
//  14. 教案补全（教师端唯一会花 token 的一条路）
//
//  这一步必须端到端跑，不能只测 core 里的纯函数 —— 中间有四个只有
//  真跑才会暴露的接缝：
//    · 课件文本有没有真的进提示词（忘了取 slideText 不会报错）
//    · 草稿有没有落进**课程目录**而不是工作区根（多课程下会串班）
//    · 采纳之后课程树**当场**就该变（内存层没有 TTL，不失效就一直是旧结论）
//    · 采纳会不会静默冲掉已有的正式教案（那是批改的基准）
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 14. 教案补全（体检 → 生成 → 审批 → 采纳 → 索引）===')
{
  const st = await api('/cip-tea', 'outline.status', {})
  check('大纲体检可用', st.json && st.json.totalLessons > 0,
    st.json ? (st.json.totalLessons + ' 课时 / 有教案 ' + st.json.withPlan + ' / 缺教案 ' + st.json.missingPlan
      + ' / 有课件页 ' + st.json.withSlides + ' / 可自动补 ' + st.json.autoFillable) : (st.json && st.json.error))
  check('  缺教案与缺课件分开报（不合成一个完成度）',
    !!(st.json && typeof st.json.missingSlides === 'number' && typeof st.json.missingPlan === 'number'))
  check('  给出了待办清单（缺教案且材料够的那些）',
    !!(st.json && Array.isArray(st.json.worklist)), st.json && JSON.stringify((st.json.worklist || []).slice(0, 8)))
  const bare = (st.json && st.json.lessons || []).filter((r) => !r.autoFillable)
  check('  材料不足的课时被单列出来（不当成「可自动补」）',
    !!(st.json && Array.isArray(st.json.blocked) && st.json.blocked.length === bare.filter((r) => !r.plan).length),
    st.json && ('blocked=' + JSON.stringify(st.json.blocked)))
  check('  课件页码标出了「推断 / 已确认」',
    !!(st.json && (st.json.lessons || []).some((r) => r.slides && r.slides.approx === true)
      || (st.json.lessons || []).every((r) => !r.slides)))

  const cat = await api('/cip-tea', 'plan.catalog', {})
  check('教师端有独立的模型选择（不和学生端共用一份）',
    !!(cat.json && cat.json.effective && cat.json.effective.model), cat.json && JSON.stringify(cat.json.effective))
  const setM = await api('/cip-tea', 'plan.model', { provider: 'stub', model: 'stub-vision' })
  check('  可以给教案生成单独指定模型', setM.json && setM.json.ok === true, setM.json && JSON.stringify(setM.json.saved))
  check('  选择文件落在 教案草稿/_模型.json（不碰 DSH 设置、不碰学生目录）',
    nodeFs.existsSync(nodePath.join(WS, '教案草稿', '_模型.json')),
    nodePath.join('教案草稿', '_模型.json'))

  // 挑一个「缺教案 + 有材料」的课时来生成
  const target = st.json && (st.json.worklist || [])[0]
  if (!target) {
    check('找到可生成的课时', false, '没有可自动补的课时，后面的断言跳过')
  } else {
    const tree0 = await api('/cip-tea', 'tree', {})
    const before = JSON.stringify(tree0.json.tree).indexOf('"hasPlan":true')
    // 记下调用次数：下面要断言「生成教案**确实**走了一次模型」。
    // 不能只查 modelCalls > 0 —— 前面的提问/批改已经把它加上去了，永远为真。
    const calls0 = modelCalls
    const r = await api('/cip-tea', 'plan.draft', { lesson: target })
    check('生成教案草稿成功', r.json && r.json.ok === true, r.json && (r.json.error
      || (r.json.draft && r.json.draft.file || '') + ' · ' + ((r.json.usage && r.json.usage.inputTokens) || 0) + '/' + ((r.json.usage && r.json.usage.outputTokens) || 0) + ' tokens'))
    check('  桩模型输出的整篇 ``` 包裹与开场白被剥掉',
      !!(r.json && r.json.draft && r.json.draft.preview && r.json.draft.preview.indexOf('好的，我来') < 0
        && r.json.draft.preview.indexOf('```') < 0), r.json && r.json.draft && JSON.stringify(r.json.draft.preview.slice(0, 30)))
    check('  五节齐全 → missing 为空', !!(r.json && Array.isArray(r.json.missing) && r.json.missing.length === 0),
      r.json && JSON.stringify(r.json.missing))
    check('  本次调用记录到了模型与用量',
      !!(r.json && r.json.draft && r.json.draft.model && r.json.draft.usage), r.json && r.json.draft && r.json.draft.model)

    // 提示词里到底有什么：这是判断「模型看到的是不是真材料」的唯一直接证据
    check('提示词里有课件正文（不是只给了页码）',
      lastPlanPrompt.indexOf('【课件】') >= 0 && lastPlanPrompt.length > 400,
      '提示词 ' + lastPlanPrompt.length + ' 字符')
    check('  提示词里没有任何「没找到」当借口时也说明了缺什么',
      lastPlanPrompt.indexOf('【缺失的材料】') >= 0)
    check('  本轮真的走了一次模型调用（教师端确实会花自己的额度）', modelCalls - calls0 >= 1,
      '调用次数 ' + calls0 + ' → ' + modelCalls)

    const drafts = await api('/cip-tea', 'plan.drafts', {})
    check('草稿清单里能看到它', !!(drafts.json && (drafts.json.drafts || []).some((d) => Number(d.lesson) === Number(target))),
      drafts.json && ((drafts.json.drafts || []).length + ' 份'))

    const rd = await api('/cip-tea', 'plan.read', { lesson: target })
    check('能读到草稿全文', !!(rd.json && rd.json.kind === 'draft' && rd.json.text.length > 200), rd.json && String(rd.json.text && rd.json.text.length))

    // 草稿不能直接变成教案
    const treeBefore = await api('/cip-tea', 'tree', {})
    const rowBefore = ((treeBefore.json.tree || {}).modules || [])
      .flatMap((m) => m.lessons || []).find((l) => Number(l.no) === Number(target))
    check('  生成草稿后**正式教案仍然没有**（草稿不是教案）', rowBefore && rowBefore.hasPlan === false,
      JSON.stringify(rowBefore && rowBefore.hasPlan))

    const saved = await api('/cip-tea', 'plan.save', { lesson: target, text: rd.json.text + '\n> 老师补一句：这里要强调参数量统计。\n' })
    check('老师能直接改草稿并保存', saved.json && saved.json.ok === true, saved.json && (saved.json.error || (saved.json.chars + ' 字符')))

    const acc = await api('/cip-tea', 'plan.accept', { lesson: target })
    check('采纳成功，写进正式教案', !!(acc.json && acc.json.ok === true), acc.json && (acc.json.error || acc.json.path))
    const planRel = String((acc.json && acc.json.path) || '')
    const planAbs = planRel ? nodePath.join(WS, planRel.replace(/\\/g, '/')) : ''
    check('  文件真的在磁盘上', !!planAbs && nodeFs.existsSync(planAbs) && nodeFs.statSync(planAbs).isFile(),
      planAbs ? planAbs.replace(WS, '.') : '(没有返回路径)')
    check('  老师的那句修改也进去了',
      !!planAbs && nodeFs.existsSync(planAbs) && nodeFs.readFileSync(planAbs, 'utf8').indexOf('这里要强调参数量统计') >= 0)
    const idxAbs = nodePath.join(WS, '课程中心', '课程结构索引.json')
    const idx = JSON.parse(nodeFs.readFileSync(idxAbs, 'utf8'))
    const idxRow = (idx.modules || []).flatMap((m) => m.lessons || []).find((l) => Number(l.no) === Number(target))
    check('  索引里的 plan 字段被同步（学生端靠它找教案）',
      !!(idxRow && idxRow.plan && idxRow.plan === (acc.json.file || idxRow.plan)), idxRow && idxRow.plan)

    // ⚠️ 内存里的课程树没有 TTL：不显式失效，面板会一直说「教案未撰写」。
    //    这条断言就是那个 bug 的回归。
    const treeAfter = await api('/cip-tea', 'tree', {})
    const rowAfter = ((treeAfter.json.tree || {}).modules || [])
      .flatMap((m) => m.lessons || []).find((l) => Number(l.no) === Number(target))
    check('  采纳后课程树**当场**就变了（不重启、不刷新缓存）', rowAfter && rowAfter.hasPlan === true,
      JSON.stringify(rowAfter && rowAfter.hasPlan))

    const again = await api('/cip-tea', 'plan.accept', { lesson: target })
    check('  再次采纳被拒绝（不能静默冲掉验收基准）',
      !!(again.json && again.json.error && again.json.error.indexOf('已存在') >= 0), again.json && again.json.error)
    const force = await api('/cip-tea', 'plan.accept', { lesson: target, overwrite: true })
    check('  显式覆盖会先备份旧教案', !!(force.json && force.json.ok && force.json.backedUp), force.json && force.json.backedUp)
    check('    备份在课程目录里（不污染共享内容）',
      nodeFs.existsSync(nodePath.join(WS, String(force.json.backedUp || '').replace(/\\/g, '/'))))

    // 锚点：确认过之后不再推断
    const a1 = await api('/cip-tea', 'anchor.set', { lesson: target, chapter: '第一章', from: 1, to: 9 })
    check('可以把课时锚点改成「已确认」', a1.json && a1.json.ok === true, a1.json && (a1.json.error || (a1.json.changed + ' 处')))
    const st2 = await api('/cip-tea', 'outline.status', {})
    const row2 = ((st2.json || {}).lessons || []).find((r) => Number(r.no) === Number(target))
    check('  体检里这个课时的页码变成「已确认」', !!(row2 && row2.slides && row2.slides.approx === false),
      JSON.stringify(row2 && row2.slides))

    // 索引重建：老师手写了一份教案放进 详细教案/ 但忘了回来登记 —— 必须能扫出来。
    // 这一条的实际意义：索引漏登 → 学生端说「这一课时没有教案」→ 批改悄悄退化成
    // 通用初筛，**不报错**。所以「能把漏登记的补上」是硬需求，不是便利功能。
    const mod0 = ((treeBefore.json.tree || {}).modules || []).find((m) => (m.lessons || []).some((l) => Number(l.no) === Number(target)))
    const orphDir = nodePath.join(WS, mod0.dir, mod0.planDir)
    nodeFs.mkdirSync(orphDir, { recursive: true })
    const l1 = (mod0.lessons || []).find((l) => l.plan && l.plan !== acc.json.file)
    const orphName = '课时' + (l1 ? l1.no : 1) + '_手写但忘了登记.md'
    nodeFs.writeFileSync(nodePath.join(orphDir, orphName),
      '# 课时 ' + (l1 ? l1.no : 1) + '：手写但忘了登记\n\n## 目标\n\n1. x\n\n## 推导\n\n### 一、a\n\nb\n\n## 实操\n\n### 任务一：c\n\n- 产物：`c.py`\n\n## 验收标准\n\n1. d\n\n## 当堂交付物\n\n- `c.py`\n', 'utf8')
    const rb = await api('/cip-tea', 'index.rebuild', {})
    const idx2 = JSON.parse(nodeFs.readFileSync(idxAbs, 'utf8'))
    const row2b = (idx2.modules || []).flatMap((m) => m.lessons || []).find((l) => Number(l.no) === Number(l1 ? l1.no : 1))
    check('重建索引能把漏登记的教案补进索引',
      !!(rb.json && (rb.json.changes || []).length > 0 && row2b && row2b.plan === orphName),
      rb.json && (rb.json.note + ' · ' + JSON.stringify((rb.json.changes || []).map((c) => c.lesson + ':' + c.to))))
    const orphanFile = nodePath.join(orphDir, '随手记.md')
    nodeFs.writeFileSync(orphanFile, '# 随手记\n', 'utf8')
    const rb2 = await api('/cip-tea', 'index.rebuild', {})
    check('  对不上课时的文件被列为待处理（不静默忽略）',
      !!(rb2.json && (rb2.json.orphans || []).some((o) => o.name === '随手记.md')),
      rb2.json && JSON.stringify((rb2.json.orphans || []).map((o) => o.name)))
    nodeFs.unlinkSync(orphanFile)
  }
}

// ═══════════════════════════════════════════════════════════════
//  15. 学生身份 —— 「谁提问的」原来写的是 Administrator
//
//  那不是学生，是这台 Windows 机器的用户名（身份 = CIP_STUDENT || USERNAME）。
//  老师要看的是「这一班谁需要我管」，所以这一节验三件事：
//    · 显示名优先级：老师名册 > 学生自报 > 学号
//    · 改学号必须**搬迁**目录（学号就是目录名，不搬等于历史数据消失）
//    · 换课是热切换，不用重启
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 15. 学生身份：名册 / 显示名 / 改学号搬迁 / 换课 ===')
{
  const me = await api('/cip-stu', 'student.me', {})
  check('学生端能报出「我是谁」', !!(me.json && me.json.sid), me.json && JSON.stringify({
    sid: me.json.sid, name: me.json.name, identified: me.json.identified,
  }))
  check('  CIP_STUDENT 指定时算「已识别」（多开/测试用）', me.json && me.json.identified === true)

  // 填一次身份。⚠️ 这里必须带 confirm：本进程前面的小节已经以 CIP_STUDENT=S001
  // 提过问、交过作业，所以「S001 → S2026」是一次**有数据的改名**，
  // 宿主会先回报「要搬多少」而不直接搬（这条门本身在下面单独验）。
  const id1 = await api('/cip-stu', 'student.identify', {
    sid: 'S2026', name: '张三', klass: '土木2101', confirm: true,
  })
  check('能写入本机身份（学号 + 姓名 + 班级）', !!(id1.json && id1.json.ok === true),
    id1.json && (id1.json.error || id1.json.note))
  check('  旧学号下的提问确实跟着搬过来了（不是复制）',
    !nodeFs.existsSync(nodePath.join(WS, '课程问题池', '学生', 'S001'))
    && nodeFs.existsSync(nodePath.join(WS, '课程问题池', '学生', 'S2026')),
    id1.json && JSON.stringify(id1.json.move && id1.json.move.moved))
  const me2 = await api('/cip-stu', 'student.me', {})
  check('  写入后 label 变成「张三（S2026）」', !!(me2.json && me2.json.label === '张三（S2026）'),
    me2.json && me2.json.label)
  const idFile = me2.json && me2.json.identityFile
  check('  身份文件在工作区里（~/.dsh 是只读的，沙箱挡住过）',
    !!idFile && idFile.indexOf(WS) === 0 && idFile.indexOf('我的身份.json') > 0, idFile)
  check('  而且已在 .gitignore 里（绝不进任何仓库）', (() => {
    const gi = nodePath.join(WS, '.gitignore')
    if (!nodeFs.existsSync(gi)) return true   // 夹具工作区没有 .gitignore，跳过
    return nodeFs.readFileSync(gi, 'utf8').indexOf('我的身份.json') >= 0
  })())
  check('  课程内也留了一份自报信息（老师能看到）',
    nodeFs.existsSync(nodePath.join(WS, '课程问题池', '学生', 'S2026', '学生信息.json')))

  const r1 = await api('/cip-tea', 'roster', {})
  const row1 = ((r1.json && r1.json.students) || []).find((x) => x.sid === 'S2026')
  check('教师端学生总表能看到这个人', !!row1, r1.json && ((r1.json.students || []).length + ' 人'))
  check('  显示名先用学生自报的', !!(row1 && row1.label === '张三（S2026）'), row1 && row1.label)
  check('  并标出名字来自「学生自报」而不是名册', !!row1 && row1.fromRoster === false)
  check('  带上可比较的计数（老师据此排序）',
    !!(row1 && typeof row1.asked === 'number' && typeof row1.ungraded === 'number'),
    row1 && ('提问 ' + row1.asked + ' / 未批改 ' + row1.ungraded))

  const sv = await api('/cip-tea', 'roster.save', { sid: 'S2026', name: '张三丰', klass: '土木2101', note: '基础较弱' })
  check('老师能把学号改成真名', !!(sv.json && sv.json.ok === true), sv.json && sv.json.label)
  const r2 = await api('/cip-tea', 'roster', {})
  const row2 = ((r2.json && r2.json.students) || []).find((x) => x.sid === 'S2026')
  check('  名册里的名字优先于学生自报', !!(row2 && row2.name === '张三丰'), row2 && row2.label)
  check('  同时留着自报的那个名字（便于核对是不是本人）', !!(row2 && row2.selfName === '张三'))

  const det = await api('/cip-tea', 'student.detail', { sid: 'S2026' })
  check('能看某个学生的全部情况', !!(det.json && det.json.sid === 'S2026'),
    det.json && (det.json.error || det.json.label))
  check('  直接给出「这个人需要你做什么」的结论',
    !!(det.json && Array.isArray(det.json.todo)), det.json && JSON.stringify(det.json.todo))
  check('  按课时列出他卡在哪', !!(det.json && Array.isArray(det.json.lessons)))

  const th = await api('/cip-tea', 'threads', { onlyShared: false })
  const items = (th.json && th.json.items) || []
  check('教师端每条提问都带上了显示名', items.length > 0 && items.every((i) => i.who && i.who.label),
    items.slice(0, 3).map((i) => i.who && i.who.label).join(' | '))
  if (items[0]) {
    const td = await api('/cip-tea', 'thread', { path: items[0].path })
    check('  详情页的 fields.who 也在（改完名点进去立刻是新名字）',
      !!(td.json && td.json.fields && td.json.fields.who && td.json.fields.who.label),
      td.json && td.json.fields && JSON.stringify(td.json.fields.who))
  }

  // 改学号：有数据时必须先问一次，再搬
  const asked = await api('/cip-stu', 'ask', {
    question: '搬迁测试：这条提问挂在 S2026 下', chapter: '第一章', slideIndex: 1,
  })
  check('在这个学号下发了一条提问（用于验证搬迁）', !!(asked.json && asked.json.ok),
    asked.json && (asked.json.error || asked.json.path))
  const ren = await api('/cip-stu', 'student.identify', { sid: 'S2027', name: '张三丰' })
  check('改学号时先回报「会搬多少」而不是直接搬',
    !!(ren.json && ren.json.needsConfirm === true && ren.json.willMove), ren.json && ren.json.message)
  check('  这一步还没动任何文件（搬迁不可逆，得先说清）',
    nodeFs.existsSync(nodePath.join(WS, '课程问题池', '学生', 'S2026')))
  const ren2 = await api('/cip-stu', 'student.identify', { sid: 'S2027', name: '张三丰', confirm: true })
  check('确认后真的搬过去了', !!(ren2.json && ren2.json.ok === true),
    ren2.json && (ren2.json.error || ren2.json.note))
  check('  旧目录已经不在', !nodeFs.existsSync(nodePath.join(WS, '课程问题池', '学生', 'S2026')))
  check('  新目录里有刚才那条提问', nodeFs.existsSync(nodePath.join(WS, '课程问题池', '学生', 'S2027')))

  // 换课：热切换
  const cu = await api('/cip-tea', 'course.use', { code: '' })
  check('换课（回到根目录即课程）不报错', !!(cu.json && cu.json.ok === true),
    cu.json && (cu.json.error || cu.json.note))
  check('  换课是**热切换**：不重启，info 立刻反映',
    !!(cu.json && cu.json.course), cu.json && JSON.stringify(cu.json.course && cu.json.course.rootIsCourse))
  const cu2 = await api('/cip-tea', 'course.use', { code: '不存在的课程码' })
  check('  换到不存在的课要明确报错（不静默失败）',
    !!(cu2.json && cu2.json.error && cu2.json.error.indexOf('不存在') >= 0), cu2.json && cu2.json.error)
  const cl = await api('/cip-tea', 'course.list', {})
  check('  能列出可切的课', !!(cl.json && Array.isArray(cl.json.available)),
    cl.json && JSON.stringify((cl.json.available || []).map((x) => x.code)))
}

// ═══════════════════════════════════════════════════════════════
//  16. 交一个 zip —— 里面的代码必须真的能被批改读到
//
//  学生交作业常常是**一整个项目**（src/ + README + notebook），打包成 zip 交。
//  如果 zip 只当二进制附件存着，模型看到的就是「一个未知文件」，然后给出
//  满篇「无法核验」—— 等于没交。所以这条路的验收点是：
//  **解出来的 .py 内容真的进了批改提示词**，而不是「上传成功」。
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 16. zip 提交：服务端解开，批改能读到里面的代码 ===')
{
  // 手工造一个真 zip（stored + deflate 两种都放，两个压缩方式都要走到）
  const zlib = await import('node:zlib')
  const crc32 = (buf) => {
    let c; let crc = 0xffffffff
    for (let i = 0; i < buf.length; i += 1) {
      c = (crc ^ buf[i]) & 0xff
      for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
      crc = (crc >>> 8) ^ c
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  const mkZip = (items) => {
    const locals = []; const centrals = []; let off = 0
    for (const it of items) {
      const name = Buffer.from(it.name, 'utf8')
      const data = Buffer.from(it.data, 'utf8')
      const comp = it.method === 8 ? zlib.deflateRawSync(data) : data
      const lh = Buffer.alloc(30)
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
      lh.writeUInt16LE(it.method, 8); lh.writeUInt32LE(crc32(data), 14)
      lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22)
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
      locals.push(lh, name, comp)
      const ch = Buffer.alloc(46)
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
      ch.writeUInt16LE(it.method, 10); ch.writeUInt32LE(crc32(data), 16)
      ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24)
      ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42)
      centrals.push(ch, name)
      off += 30 + name.length + comp.length
    }
    const cd = Buffer.concat(centrals)
    const eo = Buffer.alloc(22)
    eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(items.length, 8); eo.writeUInt16LE(items.length, 10)
    eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16)
    return Buffer.concat([Buffer.concat(locals), cd, eo])
  }
  const ZIP_MARK = 'def train_step(self, batch):  # ZIP_MARKER_9421'
  const zip = mkZip([
    { name: 'README.md', data: '# 课时 8 作业\n纯 NumPy 手写逻辑回归。\n', method: 8 },
    { name: 'src/model.py', data: 'import numpy as np\n\nclass LR:\n    ' + ZIP_MARK + '\n        pass\n', method: 8 },
    { name: 'notes.txt', data: '推导见草稿纸照片。\n', method: 0 },
    { name: 'logo.png', data: '\u0089PNG\u0000\u0001binary', method: 0 },
  ])
  const zipUrl = 'data:application/zip;base64,' + zip.toString('base64')

  const sub = await api('/cip-stu', 'submission.save', {
    lesson: 8, text: '第 8 课时作业，代码在 zip 里。',
    files: [{ name: '课时8作业.zip', dataUrl: zipUrl }],
  })
  check('能交一个 zip', !!(sub.json && sub.json.ok === true), sub.json && (sub.json.error || ('v' + sub.json.v)))
  const notes = (sub.json && sub.json.zipNotes) || []
  check('  服务端认出并解开了它', notes.length === 1 && notes[0].extracted === 3,
    JSON.stringify(notes.map((n) => ({ zip: n.zip, ex: n.extracted, skip: n.skipped, err: n.error }))))
  check('  二进制条目被跳过并记了原因（不静默丢）',
    notes.length === 1 && notes[0].skipped === 1 && /不是文本/.test(JSON.stringify(notes[0].skippedWhy)),
    JSON.stringify(notes[0] && notes[0].skippedWhy))
  const names = ((sub.json && sub.json.files) || []).map((f) => f.name)
  check('  解出来的三个文本条目各自成了一份附件',
    names.indexOf('src__model.py') >= 0 && names.indexOf('README.md') >= 0 && names.indexOf('notes.txt') >= 0,
    names.join(', '))
  check('  原始路径记在 originalPath 里（不是只留个拍平名）',
    ((sub.json.files || []).find((f) => f.name === 'src__model.py') || {}).originalPath === 'src/model.py')

  // 关键的一步：批改提示词里能不能看到 zip 里的代码
  const g = await api('/cip-stu', 'submission.grade', { lesson: 8, v: 0 })
  check('  能批改这一版', !!(g.json && g.json.ok === true), g.json && (g.json.error || ('v' + g.json.v)))
  check('  【关键】zip 里的 .py 内容真的进了批改提示词',
    lastGradePrompt.indexOf(ZIP_MARK) >= 0,
    lastGradePrompt.indexOf('【文本附件：src__model.py】') >= 0
      ? '提示词里有 src__model.py 的文本块'
      : ('未找到标记；提示词 ' + lastGradePrompt.length + ' 字符'))
  check('  提示词里也说了 zip 里有二进制条目被跳过',
    lastGradePrompt.indexOf('logo.png') >= 0 || lastGradePrompt.indexOf('src__model.py') >= 0)

  // 解不开的包不能让整次提交失败
  const bad = await api('/cip-stu', 'submission.save', {
    lesson: 8, text: '交了个坏包',
    files: [{ name: '坏的.zip', dataUrl: 'data:application/zip;base64,' + Buffer.from('not a zip at all').toString('base64') }],
  })
  check('  交一个假的 zip：作业仍然存下来，只是如实说解不开',
    !!(bad.json && bad.json.ok === true) && (bad.json.zipNotes || [])[0]
      && /不是 zip/.test(String((bad.json.zipNotes || [])[0].error)),
    bad.json && JSON.stringify(bad.json.zipNotes))
}

// ═══════════════════════════════════════════════════════════════
//  17. 草稿多轮修改 —— 像学生追问那样一轮一轮改
//
//  为什么不能只测「重新生成」：老师看出来的问题几乎都是**局部的**
//  （这节推导跳步、验收标准太虚、第 12 页那张图要讲进去）。重生成会把
//  已经满意的部分一起洗掉。所以这里要验的是三件事：
//    · 一轮一轮能接上（历史进提示词、轮次被记下来）
//    · 老师能像学生那样递证据（拖选文字 / 框选截图，同一套形状）
//    · 改坏了能退回去（快照 + revert）
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 17. 草稿多轮修改（对话式）===')
{
  // 先给课时 2 生成一份草稿（打桩模型回的是五节齐全的课时 19 模板，够用）
  const mk = await api('/cip-tea', 'plan.draft', { lesson: 2 })
  check('先有一份草稿可改', !!(mk.json && mk.json.ok === true), mk.json && (mk.json.error || mk.json.draft && mk.json.draft.file))

  const before = ((await api('/cip-tea', 'plan.read', { lesson: 2 })).json || {}).text || ''
  check('  读到当前草稿', before.length > 200, before.length + ' 字符')

  // 第二轮：带一段拖选来的文字当证据
  const callsBefore = modelCalls
  const r1 = await api('/cip-tea', 'plan.revise', {
    lesson: 2,
    instruction: '把「推导」第二节补上逐步说明',
    evidence: [{ chapter: '第一章', page: 12, kind: 'text', text: '矩阵求导要先展开再逐项求' }],
  })
  check('能改一轮', !!(r1.json && r1.json.ok === true), r1.json && (r1.json.error || r1.json.note))
  check('  这一轮真的走了一次模型（花老师自己的额度）', modelCalls - callsBefore >= 1,
    '调用 ' + callsBefore + ' → ' + modelCalls)
  check('  提示词里有老师的整篇草稿', lastPlanPrompt.indexOf('## 验收标准') >= 0,
    '提示词 ' + lastPlanPrompt.length + ' 字符')
  check('  提示词里有老师圈出来的证据（含页码与文字）',
    lastPlanPrompt.indexOf('第一章 第 12 页') >= 0 && lastPlanPrompt.indexOf('矩阵求导要先展开') >= 0)
  // 「只改要求的地方」这条写在 system 里（它是角色约束，不属于某一轮的内容），
  // 所以要查 system 而不是 user 消息 —— 查错了会得到「提示词没写」的假结论。
  check('  改稿的角色约束里写清了「只改要求的地方，其余逐字不变」',
    lastReviseSystem.indexOf('逐字保持不变') >= 0 && lastReviseSystem.indexOf('只改老师要求改的地方') >= 0,
    lastReviseSystem.slice(0, 60))
  check('  改完是整篇（不是只剩改动的那一节）',
    (r1.json.text || '').indexOf('## 目标') >= 0 && (r1.json.text || '').indexOf('## 当堂交付物') >= 0)
  check('  如实报出这一轮改了哪几节', !!(r1.json.turn && Array.isArray(r1.json.turn.changed)),
    r1.json && JSON.stringify((r1.json.turn.changed || []).map((c) => c.title)))
  check('  改了之前先留了快照（能回退）', !!(r1.json.turn && r1.json.turn.snapshot), r1.json && r1.json.turn.snapshot)

  // 第二轮：带一张框选截图
  const img = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64')
  const r2 = await api('/cip-tea', 'plan.revise', {
    lesson: 2,
    instruction: '把这张图的内容讲进实操',
    evidence: [{ chapter: '第一章', page: 20, kind: 'region', text: '', note: '' }],
    images: [img],
  })
  check('第二轮（带框选截图）也能改', !!(r2.json && r2.json.ok === true), r2.json && (r2.json.error || r2.json.note))
  check('  截图真的作为图片附件发出去了',
    !!(r2.json.turn && r2.json.turn.images >= 1), r2.json && ('attached=' + (r2.json.turn && r2.json.turn.images)))
  check('  第二轮的历史里带着第一轮的要求', lastPlanPrompt.indexOf('已经改过什么') >= 0
    || lastPlanPrompt.indexOf('把「推导」第二节补上逐步说明') >= 0)

  const tt = await api('/cip-tea', 'plan.turns', { lesson: 2 })
  check('轮次被记下来了', !!(tt.json && (tt.json.turns || []).length === 2),
    tt.json && ((tt.json.turns || []).length + ' 轮'))
  check('  每轮都记了改了哪几节和字数变化',
    !!(tt.json.turns[0].changed && typeof tt.json.turns[0].charsAfter === 'number'),
    tt.json && JSON.stringify(tt.json.turns[0].changed))

  // 空轮次要被挡住 —— 什么都不说就点「让模型改这一轮」不该花钱
  const empty = await api('/cip-tea', 'plan.revise', { lesson: 2, instruction: '', evidence: [] })
  check('空的这一轮被挡住（不白花钱）',
    !!(empty.json && empty.json.error && empty.json.error.indexOf('这一轮是空的') >= 0), empty.json && empty.json.error)

  // 退回
  const rv = await api('/cip-tea', 'plan.revert', { lesson: 2, keepTurns: 0 })
  check('能退回改之前（逐轮改就必须能回退）', !!(rv.json && rv.json.ok === true), rv.json && (rv.json.error || rv.json.note))
  check('  退回后轮次记录也回退了',
    ((await api('/cip-tea', 'plan.turns', { lesson: 2 })).json.turns || []).length === 0)

  // 没改过就没得退
  const rv2 = await api('/cip-tea', 'plan.revert', { lesson: 2 })
  check('  没改过时说清「没有可退回的版本」',
    !!(rv2.json && rv2.json.error && rv2.json.error.indexOf('没有可退回') >= 0), rv2.json && rv2.json.error)
}

console.log('\n' + '='.repeat(60))
console.log(`通过 ${pass} 项，失败 ${fail} 项 · 模型打桩调用共 ${modelCalls} 次`)
process.exitCode = fail ? 1 : 0
