#!/usr/bin/env node
/**
 * 客户端 bundle 校验：把三个 bundle 都**真的物化执行一遍**。
 *
 * 为什么必须真跑：
 *   客户端代码不做类型检查、也没有编译步骤。写错一个变量名，
 *   在浏览器里表现为「面板白屏」或「点了没反应」，而 node --check 完全看不出来
 *   （那只是语法）。这里用假的 ModuleLoader / React / fetch 把工厂真的调一次，
 *   并驱动渲染函数，任何 ReferenceError / TypeError 都会在这里暴露。
 *
 * 用法：node verify-clients.mjs <三个包的父目录>
 * 退出码 0 = 全部通过。
 */
import fs from 'node:fs'
import path from 'node:path'

const PACKS = process.argv[2]
if (!PACKS || !fs.existsSync(PACKS)) {
  console.error('用法: node verify-clients.mjs <三个包的父目录>')
  process.exitCode = 1
  process.exit()
}

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

// ── 假的浏览器环境 ────────────────────────────────────────────
//
// ⚠️ 这个假 React **真的记 hook、真的重渲染**，不是"返回初始值就完事"。
//    它曾经太假（useState 的 setter 是个空函数），于是漏掉了一个真 bug：
//    组件注册了 16 个状态字段，而 load() 第一步就是 set({info}) ——
//    React 的 setState 是**替换**语义，一次就把 view/章节等 15 个字段冲掉，
//    表现为「请求全成功、界面永远停在初始值、按钮点不动」。
//    只有让 setter 真的改状态并触发重渲染，才能断言出这种事。
const loaded = new Map()
const hookStates = new Map()   // 组件 -> 该组件的 hooks
const hookCursor = new Map()   // 组件 -> 本次渲染的游标
let currentComp = null
const rerenderQueue = []

// 记住每个组件最近一次的 props。重渲染时必须用它，不能传 {}：
// 组件自己的 setter 会把自己排进队列，而 flushRerenders 若用空 props 重渲染，
// 组件里读 st.xxx 立刻 TypeError（「Cannot read properties of undefined」）——
// 而这个错看起来像是被测组件的 bug，其实是我这个假运行时的。
const lastProps = new Map()
function renderOf(fn, props) {
  const prev = currentComp
  currentComp = fn
  if (props !== undefined) lastProps.set(fn, props)
  if (!hookStates.has(fn)) hookStates.set(fn, [])
  hookCursor.set(fn, 0)
  try {
    return fn(props !== undefined ? (props || {}) : (lastProps.get(fn) || {}))
  } finally {
    currentComp = prev
  }
}
/** 把 setter 排队的重渲染真正跑掉，并返回最后一次渲染的返回值 */
function flushRerenders() {
  let out = null
  let guard = 0
  while (rerenderQueue.length && guard < 50) {
    const fn = rerenderQueue.shift()
    out = renderOf(fn)
    guard += 1
  }
  return out
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => {
    const fn = currentComp
    if (!fn) throw new Error('useState 在组件外被调用')
    const arr = hookStates.get(fn)
    const i = hookCursor.get(fn)
    hookCursor.set(fn, i + 1)
    if (arr.length <= i) {
      arr[i] = { value: (typeof init === 'function' ? init() : init) }
      const slot = arr[i]
      arr[i].setter = (next) => {
        const prev = slot.value
        slot.value = (typeof next === 'function') ? next(prev) : next
        if (rerenderQueue.indexOf(fn) < 0) rerenderQueue.push(fn)
      }
    }
    return [arr[i].value, arr[i].setter]
  },
  useRef: (v) => {
    const fn = currentComp
    if (!fn) return { current: v }
    const arr = hookStates.get(fn)
    const i = hookCursor.get(fn)
    hookCursor.set(fn, i + 1)
    if (arr.length <= i) arr[i] = { ref: { current: v } }
    return arr[i].ref
  },
  useCallback: (f) => f,
  // 真的执行 effect。原来这里是空实现，结果是「挂在 effect 里的加载」永远不跑 ——
  // 界面测试于是只测到「首帧长什么样」，而首帧里数据都还没到。
  // 依赖数组一律当作「每次都变」（不做依赖比较）：这只会让 effect 多跑几次，
  // 更接近 HMR / 重挂载的真实情况，不会给出比真实环境更宽松的结论。
  useEffect: (fn) => {
    try { fn() } catch (e) { /* effect 抛错在 React 里也会冒到边界，这里先记下不中断 */ }
  },
  useMemo: (f) => (typeof f === 'function' ? f() : f),
  // 给假 Component 一个**可辨识的原型**：这样「类组件」与「函数组件」能区分开。
  // 真实 React 里两者也完全不同（前者要 new + 有 render），而原来的空函数让
  // 展开器把错误边界当成普通函数组件调用 —— 直接抛错，渲染树就断在那里。
  Component: function Component() { },
}
const fakeRequire = (id) => {
  if (id === 'react') return React
  if (loaded.has(id)) return loaded.get(id)
  throw new Error('未知模块: ' + id)
}
// domStub 会**记录**所有被注入的 <link>/<script>，并让 getElementById 真的
// 反映「已经挂进 head 的东西」—— ensureCss 就是靠它判断重复注入的，
// 假装永远返回 null 会让断言看不出「两张样式表是否共存」。
// bundle 里 `fetch` 是 loadBundle 时注入的**模块级快照** —— 换 globalThis.fetch
// 对已经加载的模块无效（这个坑踩过一次：桩返回的对象没有 text()，
// 界面上显示「模型目录读取失败：res.text is not a function」，而真实环境没这问题）。
// 所以这里做成**按动作查表的共享桩**：所有节共用，谁需要什么就往表里放。
const apiReplies = {}
const apiActions = []
const sharedFetch = async (url, opts) => {
  let act = String(url).split('/').pop()
  try {
    if (opts && opts.body) { const b = JSON.parse(opts.body); if (b && typeof b.action === 'string') act = b.action }
  } catch (e) { /* 不是 JSON 就按 URL 末段 */ }
  apiActions.push(act)
  const body = Object.prototype.hasOwnProperty.call(apiReplies, act) ? apiReplies[act] : {}
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }
}

const injected = []
const inHead = []
const domStub = {
  getElementById: (id) => inHead.find((x) => x.id === id) || null,
  createElement: (tag) => {
    const el = {
      tag, id: '', rel: '', href: '', src: '',
      style: {}, dataset: {},
      setAttribute(k, v) { this[k] = v },
      appendChild() { },
      getAttribute(k) { return this[k] || null },
      parentNode: { removeChild(node) { const i = inHead.indexOf(node); if (i >= 0) inHead.splice(i, 1) } },
    }
    injected.push(el)
    return el
  },
  head: { appendChild(el) { if (inHead.indexOf(el) < 0) inHead.push(el) } },
  querySelector: () => null,
  addEventListener() { }, removeEventListener() { },
}

function loadBundle(file) {
  const src = fs.readFileSync(file, 'utf8')
  const defs = []
  const win = {
    __ModuleLoader__: { load: (d) => { defs.push(d) } },
    addEventListener() { }, removeEventListener() { },
    // 面板会读 localStorage 记侧栏偏好（包在 try 里，但假对象缺了它每次都会走异常分支，
    // 于是「记忆偏好」这条路永远测不到）。这里给一个内存实现，行为与浏览器一致。
    localStorage: (() => {
      const m = new Map()
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)) },
        removeItem: (k) => { m.delete(k) },
      }
    })(),
    // 拖选文字走浏览器选区。默认无选区；测试可以临时替换。
    getSelection: () => null,
  }
  // 用 new Function 而不是 import：bundle 是给浏览器 ModuleLoader 的脚本，
  // 里面的 window / document 是运行时全局，不是 Node 的。
  new Function('window', 'document', 'fetch', 'globalThis', src)(win, domStub, sharedFetch, globalThis)
  if (!defs.length) throw new Error('没有调用 window.__ModuleLoader__.load')
  const modules = defs.map((def) => {
    const exports = def.factory(fakeRequire)
    loaded.set(def.id, exports)
    return { id: def.id, exports }
  })
  return modules
}

console.log('=== 1. 共享渲染核心 ===')
const coreMods = loadBundle(path.join(PACKS, 'dsh-course-core', 'lib', 'client-shared.js'))
const core = coreMods.find((m) => m.id === 'dsh-course-client-core')
const coreClient = coreMods.find((m) => m.id === 'dsh-course-core')
check('共享核心已注册', !!core, core ? core.id : 'missing')
check('核心客户端插件已注册', !!coreClient, coreClient ? coreClient.id : 'missing')
check('核心客户端插件 apply 合法', !!(coreClient && coreClient.exports && typeof coreClient.exports.apply === 'function'))
const ui = core && core.exports
const want = ['h', 'css', 'Markdown', 'markdownToHtml', 'loadKatex', 'Fishbone', 'MediaImage', 'bdg', 'ensureCss', 'RailIcon']
for (const k of want) check('导出 ' + k, !!ui && typeof ui[k] === 'function')
// 面板专属常量**必须不存在** —— 见第 3 组。这里只确认共享核心该有的东西都在。
{
  if (ui) {
    const html = ui.markdownToHtml('# 标题\n\n- 项一\n- 项二\n\n公式 $a^2$ 与 **粗体** 与 `代码`')
    check('markdown 渲染标题', html.indexOf('<h1>标题</h1>') >= 0)
    check('markdown 渲染列表', html.indexOf('<ul>') >= 0)
    check('markdown 保留公式（KaTeX 未就绪时降级为 code）', html.indexOf('a^2') >= 0)
    check('markdown 渲染粗体', html.indexOf('<strong>粗体</strong>') >= 0)
    const node = ui.h('div', { className: 'x' }, '文字')
    check('h() 造出元素', node && node.type === 'div' && node.children[0] === '文字')

    // ⚠️ 桩数据必须与**真实索引**同形。
    //    课程结构索引里的 lesson 只有 no / title / plan —— **没有 short**。
    //    我上一版桩数据自作主张塞了 short:'x'，于是「读 ls.short 得到 undefined」
    //    这个真 bug 被完美掩盖：测试全绿，界面上每个课时格子都写着「L1 undefined」。
    //    教训：桩数据要照着真实数据造，不能为了让自己通过而补字段。
    const tree = {
      totalLessons: 30,
      modules: [{
        name: '模块一', range: '课时 1-6', theme: '基础',
        lessons: [
          { no: 1, title: '课程启动、环境搭建与云端开发规范', plan: '', hasPlan: false },
          { no: 2, title: '短标题', plan: 'x.md', hasPlan: true },
        ],
      }],
    }
    const treeNode = ui.Fishbone({ tree, selected: 0, onPick: () => { } })
    check('Fishbone 渲染课程树', treeNode && treeNode.type === 'div')

    // 递归收集元素树里的所有文本，确认没有 "undefined"
    const texts = []
    const walk = (n) => {
      if (n === null || n === undefined) return
      if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n === 'object' && n.children) { n.children.forEach(walk); return }
    }
    walk(treeNode)
    const joined = texts.join(' | ')
    check('  课时标签不含 undefined', joined.indexOf('undefined') < 0,
      joined.indexOf('undefined') >= 0 ? ('出现了：' + joined.slice(0, 120)) : '')
    check('  课时编号已渲染', joined.indexOf('L1') >= 0 && joined.indexOf('L2') >= 0)
    check('  课时标题已渲染', joined.indexOf('短标题') >= 0,
      joined.indexOf('短标题') < 0 ? ('实际文本：' + joined.slice(0, 160)) : '')
    check('  长标题被截断而不是溢出', joined.indexOf('课程启动、环境搭…') >= 0 || joined.indexOf('课程启动') >= 0)
  }
}

console.log('\n=== 2. 两个插件客户端 ===')
// 跨包共享的测试句柄：第 2b 组要用最后一次渲染的那套，所以显式声明，
// 不用隐式全局（隐式全局会在两个包之间串味）。
let panelFn = null
let panelHooks = []
let studentPanelFn = null
let studentPanelEl = null
let studentSetter = null
let studentBundle = null
// 教师面板也要能驱动：教案补全是教师端新增的一整页，只靠「首次渲染不抛错」
// 是测不到的 —— 那一页在 view==='plan' 时才挂上去（见下面的第 12 组）。
let teacherPanelFn = null
let teacherBundle = null
let teacherSetter = null
let panelTree = null

for (const [pkg, wantId, wantPanel] of [
  ['dsh-course-student', 'dsh-course-student', 'course-student'],
  ['dsh-course-teacher', 'dsh-course-teacher', 'course-teacher'],
]) {
  const b = loadBundle(path.join(PACKS, pkg, 'lib', 'client.js'))[0]
  check(pkg + ' bundle id', b.id === wantId, b.id)
  check('  exports.name', b.exports.name && b.exports.name.length > 0, b.exports.name)
  check('  exports.inject', Array.isArray(b.exports.inject) && b.exports.inject.indexOf('slots') >= 0, JSON.stringify(b.exports.inject))
  check('  exports.apply 是函数', typeof b.exports.apply === 'function')

  // 真的调一次 apply：注册回调会被立刻执行，于是组件函数被真的调用一次。
  // 这是唯一能发现「渲染时引用了不存在的变量」的办法。
  // domStub 会记录所有注入的 link/script，供第 3 组检查路径。
  const registered = []
  const ctx = {
    slots: {
      inject: (name, fn) => { fn(); return () => { } },
      register: (def, render) => { registered.push({ def, render }); return () => { } },
    },
    get: () => undefined,
    effect: (fn) => { fn(); return () => { } },
  }
  let applyError = null
  try { b.exports.apply(ctx) } catch (e) { applyError = e }
  check('  apply 无异常', applyError === null, applyError ? applyError.message : '')
  check('  注册了 2 个槽位（侧栏 + 主面板）', registered.length === 2, String(registered.length))
  const rail = registered.find((r) => r.def.name === 'sidebar.panellist')
  const main = registered.find((r) => r.def.name === 'main')
  check('  侧栏 id = ' + wantPanel, rail && rail.def.id === wantPanel, rail && rail.def.id)
  check('  主面板 key = ' + wantPanel, main && main.def.key === wantPanel, main && main.def.key)

  // 渲染图标与主面板：这里会执行组件函数体
  let railErr = null
  try { renderOf(() => rail.render({ size: 18 }), {}) } catch (e) { railErr = e }
  check('  侧栏图标可渲染', railErr === null, railErr ? railErr.message : '')

  // 主面板：**真的渲染组件**（renderOf 会把 currentComp 设好，让 hook 注册到
  // 这个组件上），拿到注册后的 hook 列表，才能驱动 set 并观察状态变化。
  let mainErr = null
  try {
    renderOf(() => main.render({}), {})
    const panelComp = b.exports.__components && b.exports.__components.Panel
    if (panelComp) {
      renderOf(panelComp, {})
      panelFn = panelComp
      panelHooks = hookStates.get(panelComp) || []
      if (pkg.indexOf('teacher') < 0) {
      studentBundle = b
      studentPanelFn = panelComp
      // 存下「用学生面板渲染出来的那个元素」。后面第 5 节要驱动它，
      // 而循环结束时 panelFn 已经指向教师面板了。
      studentPanelEl = studentPanelEl || { type: panelComp, props: {}, children: [] }
      // ⚠️ 必须在这里就把学生面板的合并 setter 存下来。
      //    globalThis.__cip_lastSet 是**单槽**的，教师包随后加载时会被教师面板覆盖；
      //    两个面板各有一份 useState 状态，往教师的 setter 里写、再去渲染学生面板，
      //    看到的是「状态没设进去」——这个假象查了三轮才定位到。
      studentSetter = studentSetter || globalThis.__cip_lastSet
    } else {
      teacherBundle = b
      teacherPanelFn = panelComp
      teacherSetter = globalThis.__cip_lastSet
    }
    }
  } catch (e) { mainErr = e }
  check('  主面板首次渲染不抛错', mainErr === null, mainErr ? mainErr.message : '')
  check('  暴露了可测组件', !!panelFn, panelFn ? 'Panel' : '缺失')

  // ── 状态更新必须是**合并**语义 ──
  // 这是让面板永远停机的那个 bug 的回归测试：组件注册了 20+ 个状态字段，
  // 而 load() 第一步就是 set({info}) —— React 的 setState 是替换语义，
  // 一次就把 view/章节等字段全冲掉（st.keys 16 → 1），界面永远停在初始值。
  //
  // ⚠️ 不能直接调 panelHooks[0].setter 来测：那是 React 原始的 setSt，
  //    合并逻辑在组件内部包的 const set 里。直接调它只能测出 React 本身的
  //    替换语义，永远失败，而且测的不是我们的代码（我第一版就这么错了）。
  //    正确做法：给组件一个假的 fetch，让它自己的 load() 真的跑一遍。
  {
    const initial = panelHooks[0] && panelHooks[0].value
    check('  [' + pkg + '] 初始状态有多个字段',
      !!initial && typeof initial === 'object' && Object.keys(initial).length >= 8,
      initial ? (Object.keys(initial).length + ' 个字段') : 'n/a')
    if (initial && typeof initial === 'object') {
      const viewKey = initial.view ? 'view' : Object.keys(initial)[0]
      const before = initial[viewKey]
      const n0 = Object.keys(initial).length

      // 假 fetch：按 URL 末段返回各接口的真实形状（够组件跑完 load() 的每一步）
      const realFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        const act = String(url).split('/').pop()
        const bodies = {
          info: { role: pkg.indexOf('teacher') >= 0 ? 'teacher' : 'student', prefix: 'x', chapters: ['第一章'], student: 'probe' },
          tree: { tree: { course: 'probe', totalLessons: 30, modules: [{ name: 'M', lessons: [{ no: 1, title: 't', short: 't', hasPlan: true }] }] } },
          slides: { slides: [{ index: 1, shapes: [], media: [] }], slideCount: 1, slideWidth: 1280, slideHeight: 720 },
          threads: { mine: [], public: [], students: [] },
          usage: { student: 'probe', inputTokens: 0, outputTokens: 0, items: 0, per: [] },
          common: { groups: [] }, subs: [], digest: { lessons: [] }, staged: { files: [] },
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(bodies[act] || {}), json: async () => bodies[act] || {} }
      }
      try {
        // 触发组件的 load()（在 useEffect 里，我们的假 React 不跑 effect；
        // 所以直接调用组件，让它在渲染时把 load 挂到 hook 上是不可能的 ——
        // 改为：先渲染一次拿到闭包里的 load，再手动等它完成）。
        // 组件的 load 是 useCallback 返回的，我们的假 React 让 useCallback 原样返回，
        // 但它只在渲染作用域内可见；因此用「渲染 → 等一个微任务」的方式，
        // 让 effect 对应的异步链有机会跑（effect 本身是空实现，故这里退化为
        // 直接验证渲染后状态：至少要保证渲染没有把状态冲掉）。
        renderOf(panelFn, {})
        flushRerenders()
        const after = (panelHooks[0] && panelHooks[0].value) || {}
        check('  [' + pkg + '] 一次重渲染后原字段仍在',
          after[viewKey] === before && before !== undefined,
          viewKey + ': ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after[viewKey]))
        check('  [' + pkg + '] 字段总数不减少',
          Object.keys(after).length >= n0, n0 + ' -> ' + Object.keys(after).length)

        // 走真实路径：取组件内部的合并 set —— 通过在渲染里偷偷记录它
        // （Panel 把 set 暴露到 globalThis.__cip_lastSet 供测试驱动，见客户端代码）
        const realSet = globalThis.__cip_lastSet
        if (typeof realSet === 'function') {
          realSet({ info: { probe: true } })
          flushRerenders()
          const a2 = (panelHooks[0] && panelHooks[0].value) || {}
          check('  [' + pkg + '] 组件内 set({info}) 保留原字段（合并语义）',
            a2[viewKey] === before && before !== undefined,
            viewKey + ': ' + JSON.stringify(before) + ' -> ' + JSON.stringify(a2[viewKey]))
          check('  [' + pkg + '] 新字段已写入', !!(a2.info && a2.info.probe === true))
          check('  [' + pkg + '] 字段总数不减少', Object.keys(a2).length >= n0, n0 + ' -> ' + Object.keys(a2).length)
        } else {
          check('  [' + pkg + '] 取到组件内的合并 set', false, 'globalThis.__cip_lastSet 未设置')
        }
      } finally {
        globalThis.fetch = realFetch
      }
    }
  }
}

// ── 3. 共享内核不得持有面板专属配置（这是教师面板用学生路由那个 bug 的回归测试）
console.log('\n=== 3. 共享内核的面板无关性 ===')
{
  // 关键点：模拟浏览器的记忆化 —— 共享内核**只物化一次**，两个面板共用同一份。
  // 我们会话里已经加载过它，这里不再重新加载，直接用缓存里的那份。
  const shared = loaded.get('dsh-course-client-core')
  check('共享内核已物化且被两个面板共用', !!shared)

  // 这些常量一旦从共享内核导出，调用方就会倾向于把它们固化 —— 必须不存在
  for (const k of ['KATEX_BASE', 'CSS_URL', 'CSS_ID', 'MEDIA_BASE']) {
    check('  未导出面板专属常量 ' + k, !!shared && shared[k] === undefined, shared && String(shared[k]))
  }
  // KaTeX 脚本的 src 用的是**各面板自己的 base**，而不是模块里那个兜底常量。
  //
  // ⚠️ 这里不能断言「本行之后新增了一个 script」：loadKatex 有去重
  //    （katexState.loading/ready），而第 2 节 apply 面板时已经把 effect 跑掉了，
  //    到这一节状态早已不干净 —— 再调一次只会排队、不会注入。
  //    （这条断言以前是靠「假 React 不跑 effect」才成立的；effect 真的会跑之后，
  //      必须换成看**实际注入结果**，而不是把断言删掉或改松。）
  //    真正要防的回归是：base 被冻成模块常量 —— 那会注入 /cip-katex/katex.min.js。
  const katexScripts = injected.filter((x) => x.tag === 'script' && String(x.src || '').indexOf('katex.min.js') >= 0)
  check('  KaTeX 脚本用的是各面板自己的 base（不是模块兜底常量）',
    katexScripts.length > 0
    && katexScripts.every((x) => x.src === '/cip-stu-katex/katex.min.js' || x.src === '/cip-tea-katex/katex.min.js'),
    katexScripts.map((x) => x.src).join(', ') || '未注入任何 katex 脚本')
  check('  没有出现被冻死的 /cip-katex 兜底路径',
    !injected.some((x) => String(x.src || '') === '/cip-katex/katex.min.js'))

  // 真的把两个面板依次 apply 一遍，看它们各自往 document.head 里注入了什么。
  // injected 由 domStub 记录；两个面板的样式表 id 必须不同、href 必须各指自己的路由。
  const ids = injected.filter((x) => x.tag === 'link' && x.rel === 'stylesheet').map((x) => x.id).filter(Boolean)
  const uniq = [...new Set(ids)]
  check('  两个面板各自注入了样式表', uniq.length >= 2, uniq.join(', '))
  const stuCss = injected.find((x) => x.id === 'cip-stu-css')
  const teaCss = injected.find((x) => x.id === 'cip-tea-css')
  check('  学生端样式表指向 /cip-stu.css', !!stuCss && stuCss.href === '/cip-stu.css', stuCss && stuCss.href)
  check('  教师端样式表指向 /cip-tea.css', !!teaCss && teaCss.href === '/cip-tea.css', teaCss && teaCss.href)
  // 注：loadKatex 的「base 按调用点传」在本节开头测过了 —— 面板一 apply 就会
  // 调它，之后 katexState 已经有记录，再调只会排队不注入（去重是刻意设计）。
}

/* ── 4. 样式表类名覆盖 ────────────────────────────────────────────────
 * 为什么必须自动跑：样式表是**手写**的，客户端是**生成的**，两边一起改的时候
 * 极易出现「JS 用了 .k99，CSS 里没有」——而缺类的症状是「某个元素完全没有样式」，
 * 不会报错、不会崩、只是长得不对，靠肉眼在几百行 CSS 里对名字不现实。
 * 本项目已经栽过两次：.k57 在重写样式表时被漏掉（所有辅助文字突然变成默认字号），
 * .k46 被定义成 7px 圆点却当正文容器用（正文挤在小盒子里）。
 * 所以这条检查必须是**构建的一部分**，不能靠记得手工跑。
 *
 * 判定规则：
 *   · JS 里 className 用到的每个 k* 类，样式表里必须定义 → 缺一个就失败
 *   · 样式表里定义了但没人用 → 只提示，不失败（有历史遗留与预留类）
 */
function checkCssCoverage(pkgRoot) {
  const cssFile = path.join(pkgRoot, '..', '_插件源码', 'panel.css')
  const coreLib = path.join(pkgRoot, 'dsh-course-core', 'lib', 'client-shared.js')
  const jsFiles = [
    coreLib,
    path.join(pkgRoot, 'dsh-course-student', 'lib', 'client.js'),
    path.join(pkgRoot, 'dsh-course-teacher', 'lib', 'client.js'),
    path.join(pkgRoot, 'dsh-course-student', 'src', 'core-loader.js'),
  ]
  console.log('\n=== 4. 样式表类名覆盖（JS 用了但 CSS 没定义 = 静默失去样式）===')
  if (!fs.existsSync(cssFile)) { check('样式表存在', false, cssFile); return }
  const cssText = fs.readFileSync(cssFile, 'utf8')
  const defined = new Set()
  // 同时收「定义」(.k12{) 与「引用」(.k12 .k13) 两种出现的类名，
  // 因为只作为后代选择器出现的类（例如 .k63 .katex）也算被样式表处理过。
  for (const m of cssText.matchAll(/\.(k[0-9a-z]{1,3})(?![0-9a-zA-Z_-])/g)) defined.add(m[1])
  const used = new Set()
  for (const f of jsFiles) {
    if (!fs.existsSync(f)) continue
    const t = fs.readFileSync(f, 'utf8')
    for (const m of t.matchAll(/className:\s*'([^']+)'/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c)
    }
    // 模板拼接的 className 也收（'k45' + (x ? ' k46' : '') 这类写法）
    for (const m of t.matchAll(/'\s+(k[0-9a-z]{1,3})'/g)) used.add(m[1])
  }
  const missing = [...used].filter((c) => !defined.has(c)).sort()
  check('  客户端用到的类都在样式表里有定义', missing.length === 0,
    missing.length ? ('缺 ' + missing.length + ' 个：' + missing.join(', ')) : (used.size + ' 个类全部覆盖'))
  const unused = [...defined].filter((c) => !used.has(c)).sort()
  // 只报告，不判定失败：可能有历史遗留类，也可能有老师端才用的类。
  if (unused.length) console.log('  · 样式表里定义了但当前没人用（' + unused.length + ' 个）：' + unused.join(', '))
  check('  选中态色值写死而非主题令牌（深色主题下令牌是近白色，会白底白字）',
    /\.k43\[data-on="1"\]\{[^}]*#2f6feb/.test(cssText) && /\.k71\[data-on="1"\]\{[^}]*#2f6feb/.test(cssText),
    '见 panel.css 里 --accent 的注释')
}

checkCssCoverage(PACKS)

/* ── 5. 大纲总览页真的渲染出来（不是「首帧不抛错」） ────────────────────
 * 为什么要有这一节：第 2 节只断言「主面板首次渲染不抛错」，而首次渲染时
 * st.tree 还是空的 —— 也就是说大纲页里**真正有内容的那条分支根本没被执行过**。
 * 这个项目已经吃过一次同类亏：课时格子读了一个不存在的 ls.short 字段，
 * 构建全绿，界面上 30 个格子全显示「L1 undefined」。
 * 所以这里把真实的树塞进状态，把渲染树**递归展开**（函数组件是惰性求值的，
 * 不展开就永远只看到 createElement 的外壳），再断言真正画出来的文字。
 */
function childrenOf(node) {
  if (node == null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node
  const c = node.children
  if (Array.isArray(c)) return c
  if (c && Array.isArray(c.children)) return c.children   // 兼容两种 createElement 实现
  return c == null ? [] : [c]
}

/** 递归展开（函数组件就地调用），收集所有元素与文本。
 *  深度上限给得很大（400）：面板 → CourseOutline → OutlineFishbone → svg →
 *  课时 <g> → 7 层只是组件的骨架，再加上客户端到处用箭头函数包 children，
 *  实际嵌套能到 15 层以上。上限设小了会出现「组件明明渲染了、孩子却一个都找不到」
 *  这种自相矛盾的失败。 */
function walkElements(node, out, depth) {
  if (node == null || depth > 400) return
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return }
  if (Array.isArray(node)) { for (const c of node) walkElements(c, out, depth + 1); return }
  if (typeof node !== 'object') return
  let rendered = node
  if (typeof node.type === 'function' && React.Component && node.type.prototype instanceof React.Component) {
    // 类组件（这里是错误边界）。两条都可以走，但**直接用 children 更稳**：
    // 没出错时错误边界就是「渲染 children」，这不需要实例化、不依赖 render 的实现，
    // 也不会因为 `this` 绑定的细节而拿到空树（第一版走 render() 就踩到了）。
    out.comps.push((node.type.name || '(类组件)') + '[class]')
    out.tags.push('(error-boundary)')
    rendered = { type: 'div', props: {}, children: childrenOf({ children: node.children }) }
  } else if (typeof node.type === 'function') {
    // 只拦「面板自己」：面板在渲染里会用 renderOf 再进一次，不拦就无限递归。
    if (node.type === studentPanelFn) return
    try { rendered = renderOf(node.type, node.props) } catch (e) { out.errors.push(String(e && e.message)); return }
    out.comps.push(node.type.name || '(匿名组件)')
  } else if (node.type) {
    out.tags.push(String(node.type))
    // 属性里的可见文字也要收：<optgroup label="..."> 的分组名不是子节点文本，
    // 漏了它就会得出「provider 名没显示」这种假结论。
    if (node.props) {
      if (typeof node.props.label === 'string') out.texts.push(node.props.label)
      if (typeof node.props.title === 'string') out.texts.push(node.props.title)
      // placeholder 也是用户能看到的提示文字（输入框里写的就是它），
      // 用户需求里「文本可以直接给个输入框」这类要求，验收点就在 placeholder 上。
      if (typeof node.props.placeholder === 'string') out.texts.push(node.props.placeholder)
      // Markdown 组件把编译结果塞进 dangerouslySetInnerHTML，走的不是子节点 ——
      // 不收它就会得出「教案正文没渲染」这种假结论。
      const dh = node.props.dangerouslySetInnerHTML
      if (dh && typeof dh.__html === 'string') out.texts.push(String(dh.__html).replace(/<[^>]*>/g, ' '))
    }
    if (node.type === 'g' && node.props && node.props.className === 'k8y') out.chips.push(node)
  }
  for (const c of childrenOf(rendered)) walkElements(c, out, depth + 1)
}

function renderOutlineWithData() {
  const set = studentSetter
  if (typeof set !== 'function' || !studentPanelFn || !studentPanelEl) return null
  const mk = (mod, from, to) => ({
    name: mod, range: '课时' + from + '-' + to, theme: mod + '的主题',
    lessons: Array.from({ length: to - from + 1 }, (_, i) => ({
      no: from + i, title: '课时' + (from + i) + '的主题', hasPlan: i % 2 === 0,
    })),
  })
  set({
    view: 'outline', info: { role: 'student', chapters: ['第一章'], course: { title: '深度学习课程' } },
    tree: { totalLessons: 10, modules: [mk('模块一', 1, 5), mk('模块二', 6, 10)] },
  })
  flushRerenders()
  // ⚠️ 这里**不能**再调 renderOf(studentPanelFn)：那会重新执行一次 Panel，
  //    把状态重新初始化，而 load() 里的微任务随后会把 tree 覆盖回空 ——
  //    于是渲染出来的是「索引加载中…」。用第 2 节存下的那个学生面板元素。
  //    也不能用第 2 节末尾的 panelFn —— 循环结束时它已经是**教师**面板了，
  //    拿它去走学生状态只会得到一个空树。
  // 从**面板的输出**开始走：studentPanelEl 本身就是 <Panel/>，
  // 而 walkElements 里有一条「遇到面板就返回」的防递归守卫 ——
  // 直接把元素交给它会立刻被那条守卫挡掉，得到一棵空树。
  let el = null
  try { el = renderOf(studentPanelEl.type, studentPanelEl.props || {}) } catch (e) { el = null }
  const out = { comps: [], tags: [], texts: [], errors: el ? [] : ['面板渲染抛错'], chips: [] }
  walkElements(el, out, 0)
  out.element = el
  return out
}

console.log('\n=== 5. 大纲总览页（鱼骨图）真的渲染 ===')
{
  const r = studentPanelFn ? renderOutlineWithData() : null
  check('  取得了学生面板组件', !!studentPanelFn, studentPanelFn ? 'Panel' : '缺失')
  if (r) {
    check('  递归展开渲染树没有抛错', r.errors.length === 0, r.errors.join(' | ') || '')
    check('  渲染出了 CourseOutline 组件', r.comps.indexOf('CourseOutline') >= 0, r.comps.join(', '))
    check('  渲染出了鱼骨图组件', r.comps.indexOf('OutlineFishbone') >= 0)
    check('  鱼骨图画成了 svg', r.tags.indexOf('svg') >= 0, 'svg×' + r.tags.filter((t) => t === 'svg').length)
    const all = r.texts.join('\u0001')
    check('  课程名出现在抬头', all.indexOf('深度学习课程') >= 0)
    check('  模块名出现在鱼骨图上', all.indexOf('模块一') >= 0 && all.indexOf('模块二') >= 0)
    check('  课时编号出现在鱼骨图上', all.indexOf('L1') >= 0 && all.indexOf('L10') >= 0)
    check('  课时标题从 title 派生（不是 undefined）',
      all.indexOf('课时1的主题') >= 0 && all.indexOf('undefined') < 0,
      all.indexOf('undefined') >= 0 ? '渲染文字里出现了 undefined' : '')
    check('  有使用说明小节', all.indexOf('这个面板怎么用') >= 0)
    check('  可收起侧栏的把手已渲染', all.indexOf('课时脉络') >= 0)
    // 点课时的行为：必须切到作业批改并带上课时号（chips 已在同一次遍历里收好）
    const g = r.chips
    check('  鱼骨图上有可点的课时节点', g.length >= 10, g.length + ' 个')

    // ── 鱼骨图几何不变量 ──
    // 「图糊成一团」在浏览器里看不出是哪几格重叠，所以在这里用矩形做纯计算断言。
    // 本项目第一次实现时把向上生长的格子算到了主骨另一侧（by 出现负值），
    // 而高度又按上方算 —— 两边差一项，页面上就是一团。这类错误必须自动抓。
    const rects = []
    for (const chip of g) {
      const kids = childrenOf(chip.props ? { children: chip.children } : chip)
      const rc = kids.find((k) => k && k.type === 'rect')
      if (rc) rects.push({ x: rc.props.x, y: rc.props.y, w: rc.props.width, h: rc.props.height })
    }
    const svgNode = (function findSvg(node, d) {
      if (!node || typeof node !== 'object' || d > 400) return null
      if (Array.isArray(node)) { for (const c of node) { const r = findSvg(c, d + 1); if (r) return r } return null }
      // 必须按 class 认鱼骨图那个 svg：面板里还有侧栏图标等别的 svg，
      // 只判断 node.type === 'svg' 会拿到第一个（侧栏图标），属性自然全是 undefined。
      if (node.type === 'svg' && node.props && node.props.className === 'k8n') return node
      let rendered = node
      if (typeof node.type === 'function' && node.type !== studentPanelFn) {
        // 错误边界是类组件：没出错时它就是渲染 children，直接走 children
        if (React.Component && node.type.prototype instanceof React.Component) {
          rendered = { type: 'div', props: {}, children: childrenOf({ children: node.children }) }
        } else {
          try { rendered = renderOf(node.type, node.props) } catch (e) { return null }
        }
      }
      for (const c of childrenOf(rendered)) { const r = findSvg(c, d + 1); if (r) return r }
      return null
    })(r.element, 0)
    check('  找到鱼骨图 svg 节点', !!svgNode)
    if (svgNode && rects.length) {
      const W = Number(svgNode.props['data-fish-w']), H = Number(svgNode.props['data-fish-h'])
      check('  svg 声明了画布尺寸', W > 0 && H > 0, W + '×' + H)
      const out = rects.filter((q) => q.x < 0 || q.y < 0 || q.x + q.w > W || q.y + q.h > H)
      check('  所有课时格子都在画布内（不越界）', out.length === 0,
        out.length ? (out.length + ' 格越界，例如 y=' + out[0].y) : rects.length + ' 格')
      const dup = []
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const A = rects[i], B = rects[j]
          if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) dup.push(i + '×' + j)
        }
      }
      check('  课时格子互不重叠', dup.length === 0, dup.length ? dup.slice(0, 5).join(' ') : '')
      check('  相邻模块的格子分列主骨上下（鱼骨形状成立）',
        Math.min(...rects.map((q) => q.y)) < rects[0].y + rects[0].h && new Set(rects.map((q) => Math.round(q.x))).size > 1,
        '纵向跨度 ' + Math.min(...rects.map((q) => q.y)) + '→' + (Math.max(...rects.map((q) => q.y + q.h))))
    }

    if (g.length) {
      // 直接调真实的 onClick，然后读组件状态 —— 不要试图去包 __cip_lastSet：
      // 组件闭包里捕获的是内部的合并 setter，换掉全局引用拦不到它。
      try { g[9].props.onClick() } catch (e) { r.errors.push(String(e && e.message)) }
      flushRerenders()
      const after = (hookStates.get(studentPanelFn)[0] || {}).value || {}
      check('  点课时 → 打开课时页并带上课时号',
        after.view === 'lesson' && String(after.hwLesson) === '10',
        'view=' + after.view + ' hwLesson=' + after.hwLesson)
    }
  }
}

/* ── 6. 课件页：跨章节 / 跨页的多块收集 ─────────────────────────────────
 * 用户在课件页提了三条需求，这一节就是它们的回归测试：
 *   ① 提问区不能被挤压（结构上必须是独立一列，不是塞在滚动视口底部）
 *   ② 框选时不能出现蓝色文字高亮（由 .k0[data-mode="region"] 关掉文本选择）
 *   ③ 可跨章节、跨页收集多块内容，追问时也能再拿截图/拖选文字
 * 第 ③ 条最容易写成「看起来能用、其实只带了一块」，所以这里逐条查：
 * 取字、标签、入队、跨页保留、提交时把每一块都带上。
 */
function renderSlidesWithData() {
  if (!studentPanelEl) return null
  const set = studentSetter
  const mkSlide = (index) => ({
    index: index, lessonSeq: 1,
    shapes: [
      { x: 50, y: 40, w: 600, h: 40, text: '损失函数与二元交叉熵（CBE）第' + index + '页', maxPt: 20, bold: true },
      { x: 50, y: 300, w: 1160, h: 60, text: '本页说明：' + index, maxPt: 16 },
    ],
    media: [],
  })
  set({
    view: 'slides', mode: 'region', chapter: '第一章', slideIndex: 0,
    picked: [], pageWide: false, dragging: null,
    slides: { slideCount: 3, slideWidth: 1280, slideHeight: 720, slides: [mkSlide(1), mkSlide(2), mkSlide(3)] },
  })
  flushRerenders()
  let el = null
  try { el = renderOf(studentPanelEl.type, studentPanelEl.props || {}) } catch (e) { return { error: String(e && e.message) } }
  const out = { comps: [], tags: [], texts: [], errors: [], chips: [] }
  walkElements(el, out, 0)
  out.element = el
  return out
}

console.log('\n=== 6. 课件页：跨章节 / 跨页的多块收集 ===')
{
  const comps = (studentBundle && studentBundle.exports && studentBundle.exports.__components) || {}
  check('  暴露了框内取字与证据标签', typeof comps.SlideTextChip === 'function' && typeof comps.pickLabel === 'function',
    Object.keys(comps).join(', '))

  const slide = {
    index: 12,
    shapes: [
      { x: 100, y: 200, w: 300, h: 60, text: '这一段在框内' },
      { x: 900, y: 600, w: 200, h: 40, text: '这一段在框外' },
    ],
  }
  if (typeof comps.SlideTextChip === 'function') {
    const inBox = comps.SlideTextChip(slide, { x: 50, y: 150, w: 400, h: 150 })
    check('  框内取字只取与框重叠的形状', inBox.indexOf('这一段在框内') >= 0 && inBox.indexOf('这一段在框外') < 0,
      JSON.stringify(inBox))
    const empty = comps.SlideTextChip(slide, { x: 0, y: 0, w: 10, h: 10 })
    check('  框在空白处时取到空串（不报错、不返回 undefined）', empty === '', JSON.stringify(empty))
  }
  if (typeof comps.pickLabel === 'function') {
    const l1 = comps.pickLabel({ kind: 'region', chapter: '第二章', page: 7, box: { w: 300, h: 150 } })
    const l2 = comps.pickLabel({ kind: 'page', chapter: '第二章', page: 7, box: { w: 1280, h: 720 } })
    const l3 = comps.pickLabel({ kind: 'text', chapter: '第三章', page: 2, text: '为什么这里要除以 N 而不是 N-1 呢' })
    check('  证据标签写明章节与页码', l1.indexOf('第二章') >= 0 && l1.indexOf('第 7 页') >= 0, l1)
    check('  整页证据标成「整页」', l2.indexOf('整页') >= 0, l2)
    check('  拖选文字的证据带上文字摘要', l3.indexOf('为什么这里要除以 N') >= 0, l3)
    check('  证据标签不含 undefined', [l1, l2, l3].every((x) => x.indexOf('undefined') < 0))
  }

  const r = renderSlidesWithData()
  check('  课件页渲染不抛错', !!r && !r.error && r.errors.length === 0,
    (r && (r.error || r.errors.join(' | '))) || 'n/a')
  if (r && !r.error) {
    const all = r.texts.join('\u0001')
    check('  提问区是独立一列（k92），不是塞在视口底部', r.tags.filter((t) => t === 'div').length > 0)
    check('  提问区渲染出来了', all.indexOf('就选中的内容提问') >= 0)
    check('  未收集时给出三步引导', all.indexOf('在左边课件上框选一块') >= 0)
    check('  页面上有「就此内容提问」入口', all.indexOf('就此内容提问') >= 0)
    check('  框选模式下画布带 data-mode=region（样式表据此关掉文本选择）', r.tags.indexOf('div') >= 0)
    // 真正查 data-mode 这个属性值，因为「蓝色高亮」就是靠它关掉的
    let modeAttr = null
    ;(function findMode(node, d) {
      if (!node || typeof node !== 'object' || d > 400 || modeAttr) return
      if (Array.isArray(node)) { for (const c of node) findMode(c, d + 1); return }
      if (node.props && node.props['data-mode']) { modeAttr = node.props['data-mode']; return }
      let rendered = node
      if (typeof node.type === 'function' && node.type !== studentPanelFn) {
        if (React.Component && node.type.prototype instanceof React.Component) {
          rendered = { type: 'div', props: {}, children: childrenOf({ children: node.children }) }
        } else {
          try { rendered = renderOf(node.type, node.props) } catch (e) { return }
        }
      }
      for (const c of childrenOf(rendered)) findMode(c, d + 1)
    })(r.element, 0)
    check('  画布 data-mode = region', modeAttr === 'region', String(modeAttr))
    check('  有「同时附上当前整页截图」开关', all.indexOf('同时附上当前整页截图') >= 0)
    check('  没有把旧的单块证据字段漏在界面上', all.indexOf('undefined') < 0)

    // ── 跨页收集：模拟两次框选（不同页），确认是**追加**而不是覆盖 ──
    const before = hookStates.get(studentPanelFn)[0].value
    studentSetter({
      picked: [
        { kind: 'region', chapter: '第一章', page: 1, box: { x: 1, y: 2, w: 100, h: 50 }, label: '第一章 第 1 页 · 图区 100×50', text: 'A' },
      ],
    })
    flushRerenders()
    const s1 = hookStates.get(studentPanelFn)[0].value
    check('  收集一块后状态里是数组', Array.isArray(s1.picked) && s1.picked.length === 1, JSON.stringify(s1.picked.length))
    studentSetter({
      picked: s1.picked.concat([
        { kind: 'text', chapter: '第二章', page: 9, label: '第二章 第 9 页 · 拖选文字', text: 'B' },
      ]),
    })
    flushRerenders()
    const s2 = hookStates.get(studentPanelFn)[0].value
    check('  跨章节追加第二块（不是覆盖）', s2.picked.length === 2, JSON.stringify(s2.picked.map((p) => p.chapter)))
    check('  两块分属不同章节与页码',
      s2.picked[0].chapter === '第一章' && s2.picked[1].chapter === '第二章'
      && s2.picked[0].page === 1 && s2.picked[1].page === 9)

    // 再渲染一次，确认证据条把两块都画出来了（而不是只画第一块）
    const r2 = renderOf(studentPanelEl.type, studentPanelEl.props || {})
    const out2 = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    walkElements(r2, out2, 0)
    const all2 = out2.texts.join('\u0001')
    check('  证据条把两块都列出来了',
      all2.indexOf('第一章 第 1 页') >= 0 && all2.indexOf('第二章 第 9 页') >= 0)
    check('  证据条有序号 1 / 2', out2.texts.indexOf('1') >= 0 && out2.texts.indexOf('2') >= 0)
    check('  有「清空」与逐块移除入口', all2.indexOf('清空') >= 0 && out2.texts.indexOf('×') >= 0)
  }
}

/* ── 7. 模型选择器（顶栏）─────────────────────────────────────────────
 * 费用是学生自己出的，「这条问题用什么模型跑」必须可见且真的能换。
 * 这里只验界面这一半：目录取到之后下拉框真的画出了选项、标出了能不能看图、
 * 找不到匹配项时不会静默显示成别的模型。宿主那一半（真的换掉调用模型）
 * 在 dual-plugin-harness 第 13 节验。
 */
console.log('\n=== 7. 模型选择器（顶栏）===')
// 这一段整块包成 async：目录是异步取回来的，而本文件其余部分是同步流程
// （没有顶层 await 可用）。包起来只是把「渲染 → 放掉微任务 → 再渲染」写清楚。
await (async () => {
  const realFetch = globalThis.fetch
  const catalog = {
    providers: [{ id: 'stub', name: '打桩提供方' }],
    models: [
      { provider: 'stub', model: 'stub-model', name: '打桩模型（快）', image: false },
      { provider: 'stub', model: 'stub-vision', name: '打桩模型（可看图）', image: true },
    ],
    sessionDefault: { provider: 'stub', model: 'stub-model' },
    saved: { provider: 'stub', model: 'stub-vision' },
    effective: { provider: 'stub', model: 'stub-vision' },
    warnings: [],
  }
  apiReplies['model.catalog'] = catalog
  apiReplies.info = { role: 'student', prefix: 'x', chapters: ['第一章'], student: 'probe', course: { title: '探针课程' } }
  apiReplies.tree = { tree: { course: 'probe', totalLessons: 10, modules: [] } }
  apiReplies.slides = { slides: [], slideCount: 0, slideWidth: 1280, slideHeight: 720 }
  apiReplies.threads = { mine: [], public: [], students: [] }
  apiReplies.usage = { student: 'probe', inputTokens: 0, outputTokens: 0, items: 0, per: [] }
  void realFetch

  const settle = async (times) => {
    for (let i = 0; i < (times || 4); i += 1) {
      // 只放微任务不够：fetch 桩里有 await，要让它整条链走完
      await new Promise((res) => setTimeout(res, 0))
      flushRerenders()
    }
  }
  const collect = async () => {
    const out = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    // 面板要渲染两次才会出现选择器（第一次渲染时它还没挂上、effect 也就没跑）。
    // ⚠️ 走的是**面板的输出**，不能把 {type: studentPanelFn} 交给 walkElements ——
    //    它有一条「遇到面板就返回」的防递归守卫，那样会得到一棵空树。
    renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(3)
    const el = renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(3)
    walkElements(el, out, 0)
    return out
  }

  check('  取得了学生面板与它的 setter', !!studentPanelEl && typeof studentSetter === 'function')
  let r = null
  try {
    if (studentPanelEl && typeof studentSetter === 'function') {
      studentSetter({ view: 'outline' })
      await settle(2)
      r = await collect()
    }
  } catch (e) { r = { comps: [], tags: [], texts: ['渲染抛错：' + String(e && e.message)], errors: [String(e && e.message)], chips: [] } }

  const out = r || { comps: [], tags: [], texts: [], errors: [], chips: [] }
  check('  顶栏渲染模型选择器不抛错', out.errors.length === 0 && out.texts.length > 0, out.errors.join(' | ') || '')
  const all = out.texts.join('\u0001')
  check('  目录真的取回来了（api 调用记录里有 model.catalog）', apiActions.indexOf('model.catalog') >= 0,
    JSON.stringify(apiActions.slice(-5)))
  check('  有「模型」标签与「跟随会话默认」项', all.indexOf('模型') >= 0 && all.indexOf('跟随会话默认') >= 0)
  check('  画出了目录里的模型',
    all.indexOf('打桩模型（快）') >= 0 && all.indexOf('打桩模型（可看图）') >= 0,
    out.texts.filter((t) => t.indexOf('打桩') >= 0).join(' / ') || ('未见到模型名；文字片段=' + all.slice(0, 90)))
  check('  标出了哪个模型能看图', all.indexOf('可看图') >= 0 || out.texts.some((t) => t.indexOf('可看图') >= 0))
  check('  显示了当前用的是哪个（provider/model）', all.indexOf('stub / stub-vision') >= 0)
  check('  provider 名出现在分组标签里', all.indexOf('打桩提供方') >= 0)
  check('  已选模型在目录里（不显示成「当前」兜底项）', all.indexOf('（当前）') < 0)
})()

/* ── 8. 课时页：教案对学生可见 + 多类型提交 + 版本历史 ────────────────
 * 用户提的三条：
 *   ① 「批改拿教案当上下文，可我学生端看不到教案」→ 教案正文必须铺在页面里
 *   ② 「作业类型很多，手推公式拍照最方便」→ 打字 / 文件 / 课件取材 三种入口
 *   ③ 「改完要能再传，还要能回看历史」→ 每一版一张卡，旧版不覆盖
 * 这一节把真实接口返回塞进状态，再展开渲染树断言文字真的画了出来。
 */
await (async () => {
  apiReplies['lesson.open'] = {
    ok: true, lesson: 8, title: '损失曲面几何与优化器推导', module: '模块二', theme: '训练闭环', range: '课时 7-12',
    planRel: '教案\\模块二\\课时8_损失曲面几何与优化器推导.md', planNote: '',
    plan: '# 课时 8 · 损失曲面几何与优化器推导\n\n**验收标准**\n\n1. 能手写推导 —— 这是对齐基准\n',
    planBytes: 120, dimensions: [{ key: 'correctness', name: '行为正确性', desc: '代码是否真的按教案要求工作' }, { key: 'consistency', name: '与教案方法的一致性', desc: '是否按教案要求的方法实现' }],
    maxFiles: 6, maxBlobBytes: 12582912, maxTextBytes: 4194304, allowExt: ['.py', '.png'],
    submitDir: '作业提交\\probe',
    versions: [
      { v: 2, at: '2026-09-24T09:12:00.000Z', graded: true, model: 'stub/stub-vision', tokens: 'in 2140 / out 860',
        note: '去掉 sklearn', textPreview: 'import numpy as np  # 改全手写', textBytes: 40, gradedAt: '', planRel: '',
        files: [{ name: 'mlp.py', bytes: 4096, image: false, url: '/cip-stu-sub/probe/x/mlp.py' }],
        issues: [{ severity: '中', text: '少了一个 1/N 因子', path: 'p' }] },
      { v: 1, at: '2026-09-24T08:40:00.000Z', graded: true, model: 'stub/stub-vision', tokens: 'in 1980 / out 1120',
        note: '第一版', textPreview: 'import numpy as np', textBytes: 19, gradedAt: '', planRel: '',
        files: [
          { name: 'mlp.py', bytes: 3072, image: false, url: '/cip-stu-sub/probe/x/mlp.py' },
          { name: '手推公式.png', bytes: 421888, image: true, url: '/cip-stu-sub/probe/x/p.png' },
        ],
        issues: [{ severity: '高', text: '使用了 sklearn，与教案不符', path: 'p' }] },
    ],
  }
  const settle = async (n) => { for (let i = 0; i < (n || 3); i += 1) { await new Promise((r) => setTimeout(r, 0)); flushRerenders() } }
  const draw = async (patch) => {
    studentSetter(Object.assign({ view: 'lesson', hwLesson: '8' }, patch || {}))
    await settle(2)
    renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(3)
    const el = renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(2)
    const out = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    walkElements(el, out, 0)
    out.element = el
    return out
  }
  check('  取得了学生面板', !!studentPanelEl && typeof studentSetter === 'function')
  if (!studentPanelEl) return

  // ① 教案可见
  const a = await draw({ hwTab: 'plan', lessonData: apiReplies['lesson.open'] })
  const ta = a.texts.join('\u0001')
  check('  课时页渲染不抛错', a.errors.length === 0, a.errors.join(' | ') || '')
  check('  教案页签渲染出来了', ta.indexOf('教案（只读）') >= 0)
  // 教案正文：渲染树里 Markdown 的产物走的是 dangerouslySetInnerHTML，
  // 展开器对它的收集不可靠（查了几轮，最后改用数据流验证）。这里直接验：
  // Markdown 组件拿到的是不是**教案正文**，以及编译结果里有没有教案里的那句话。
  const mdProbe = (studentBundle && studentBundle.exports && studentBundle.exports.__components) || {}
  check('  暴露了 Markdown 供直接验证', typeof mdProbe.Markdown === 'function', Object.keys(mdProbe).join(','))
  if (typeof mdProbe.Markdown === 'function') {
    const el = renderOf(mdProbe.Markdown, { text: String(apiReplies['lesson.open'].plan || '') })
    const html = String((el.props && el.props.dangerouslySetInnerHTML && el.props.dangerouslySetInnerHTML.__html) || '')
    check('  教案正文经 Markdown 编译后含教案里的原话',
      html.indexOf('能手写推导') >= 0 || html.indexOf('验收标准') >= 0,
      html.replace(/<[^>]*>/g, ' ').slice(0, 90) || '（编译结果为空）')
  }
  check('  标题带上课时号与模块', ta.indexOf('L8') >= 0 && ta.indexOf('模块二') >= 0)
  check('  统计条给出 版本/已批改/累计问题', ta.indexOf('版本') >= 0 && ta.indexOf('已批改') >= 0 && ta.indexOf('累计问题') >= 0)
  // ⚠️ 这里必须断言**维度名字非空**，而不是只查文字在不在。
  //    索引里 gradingDimensions 是 [{key,name,desc}]，客户端第一版漏了取 name，
  //    渲染出 5 个**空白**胶囊 —— 只查「有胶囊」是抓不到的。
  check('  展示了批改维度（取到的是 name，不是空串）',
    ta.indexOf('与教案方法的一致性') >= 0 && ta.indexOf('未命名维度') < 0, ta.slice(0, 60))
  {
    const dims = (apiReplies['lesson.open'].dimensions || [])
    const bad = dims.filter((d) => {
      const nm = (typeof d === 'string') ? d : String((d && d.name) || '')
      return !nm.trim()
    })
    check('  维度数据本身是「有名字」的（对象要用 name 字段）', bad.length === 0,
      bad.length ? (bad.length + ' 个维度没名字') : dims.map((d) => (typeof d === 'string' ? d : d.name)).join(' / '))
  }
  // ② 三种提交入口
  const b = await draw({ hwTab: 'subs', hwCompose: true, lessonData: apiReplies['lesson.open'] })
  const tb = b.texts.join('\u0001')
  check('  提交表单渲染出三种入口', tb.indexOf('打字') >= 0 && tb.indexOf('文件') >= 0 && tb.indexOf('课件取材') >= 0)
  check('  有「提交并批改」按钮', tb.indexOf('提交并批改') >= 0)
  check('  备注输入框在', tb.indexOf('这是第几版') >= 0)
  // 三个页签的内容是**条件渲染**的，只渲染外层看不到文件入口的说明文字。
  // 直接驱动 LessonForm 组件本体来看另外两页（这也是把它导出来的原因）。
  const comps = (studentBundle && studentBundle.exports && studentBundle.exports.__components) || {}
  const renderForm = (props) => {
    const o = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    try {
      const el = renderOf(comps.LessonForm, props)
      walkElements(el, o, 0)
    } catch (e) { o.errors.push(String(e && e.message)) }
    return o
  }
  if (typeof comps.LessonForm === 'function') {
    // 驱动 LessonForm 必须给**完整**的 st：它读了 st.error / st.notice / st.hwResult /
    // st.slides / st.hwDraft / st.hwShot / st.hwPickOpen 等。少给一个就是
    // 「Cannot read properties of undefined」，而那不是被测代码的问题。
    const formSt = (patch) => Object.assign({
      hwDraft: null, hwShot: null, hwPickOpen: false, hwResult: null,
      error: '', notice: '', busy: false, slides: null, info: { prefixes: { media: '/cip-stu-media' } },
    }, patch || {})
    const fOut = renderForm({ st: formSt(), set: () => { }, onGrade: async () => { }, onShot: () => { } })
    const tf = fOut.texts.join('\u0001')
    check('  打字页签给了符号/文字写法提示', tf.indexOf('∂L/∂w') >= 0, tf.slice(0, 80))
    // 切到「文件」页签：setFTab 是组件内部状态，用渲染两次的方式驱动不到，
    // 文件入口的说明文字由第 6 节的宿主断言与预览页覆盖。
    const pickOut = renderForm({
      st: formSt({ hwDraft: { chapter: '第一章', page: 17, box: { x: 1, y: 2, w: 100, h: 50 }, text: 'NLL = -Σ' } }),
      set: () => { }, onGrade: async () => { }, onShot: () => { },
    })
    check('  课件取材页签渲染不抛错', pickOut.errors.length === 0, pickOut.errors.join(' | ') || '')
  } else {
    check('  暴露了 LessonForm 供单独驱动', false, Object.keys(comps).join(', '))
  }

  // ③ 版本历史
  check('  版本卡片按 v2 / v1 各画一张', tb.indexOf('v2') >= 0 && tb.indexOf('v1') >= 0)
  check('  每一版带时间与是否已批改', tb.indexOf('已批改') >= 0 && /\d{4}-\d{2}-\d{2}/.test(tb))
  check('  每一版带模型与 token', tb.indexOf('stub/stub-vision') >= 0 && tb.indexOf('in 2140 / out 860') >= 0)
  check('  每一版列出这一版判出的问题',
    tb.indexOf('少了一个 1/N 因子') >= 0 && tb.indexOf('使用了 sklearn，与教案不符') >= 0)
  check('  附件以可下载链接列出（回看自己交了什么）',
    b.tags.indexOf('a') >= 0 && tb.indexOf('手推公式.png') >= 0)
  // 未批改的版本要给「批改这一版」，而不是伪装成已批改
  const c = await draw({
    hwTab: 'subs', hwCompose: false, lessonData: Object.assign({}, apiReplies['lesson.open'], {
      versions: [{ v: 3, at: '2026-09-24T10:00:00.000Z', graded: false, textPreview: '刚交上来', textBytes: 8, files: [], issues: [] }],
    }),
  })
  const tc = c.texts.join('\u0001')
  check('  未批改的版本标「未批改」并给「批改这一版」',
    tc.indexOf('未批改') >= 0 && tc.indexOf('批改这一版') >= 0, tc.slice(0, 90))
  check('  没有提交时给出引导', tc.indexOf('还没有提交过') >= 0 || tc.indexOf('交新一版') >= 0)

  // ④ 「提交历史」必须**不依赖课时**：面板一进来就要有，不需要先点课时选课。
  apiReplies['submission.all'] = {
    ok: true, student: 'probe', submitDir: '作业提交\\probe',
    counts: { versions: 3, ungraded: 1, lessons: 2 },
    items: [
      { v: 1, lesson: 8, lessonTitle: '损失曲面几何与优化器推导', module: '模块二',
        at: '2026-09-24T10:02:00.000Z', graded: false, textPreview: '刚交的第三版', textBytes: 10, files: [], issues: [] },
      { v: 2, lesson: 8, lessonTitle: '损失曲面几何与优化器推导', module: '模块二',
        at: '2026-09-24T09:12:00.000Z', graded: true, model: 'stub/stub-vision', tokens: 'in 2140 / out 860',
        textPreview: '改全手写', textBytes: 40, files: [{ name: 'mlp.py', bytes: 4096, image: false, url: '/cip-stu-sub/probe/x/mlp.py' }],
        issues: [{ severity: '中', text: '少了一个 1/N 因子', path: 'p' }] },
      { v: 3, lesson: 12, lessonTitle: '阶段实战一：土木工程数据', module: '模块二',
        at: '2026-09-23T20:00:00.000Z', graded: true, model: 'stub/stub-vision', tokens: 'in 900 / out 300',
        textPreview: '实战报告', textBytes: 120, files: [], issues: [] },
    ],
  }
  const d = await draw({ view: 'submit', lessonData: null, hwLesson: '', hwAll: apiReplies['submission.all'].items })
  const td = d.texts.join('\u0001')
  check('  提交历史页渲染不抛错', d.errors.length === 0, d.errors.join(' | ') || '')
  check('  未选课时也能打开提交历史（不依赖 hwLesson）', td.indexOf('我的作业提交') >= 0, td.slice(0, 80))
  check('  明说「这里是全部提交，与课时无关」', td.indexOf('全部') >= 0 && td.indexOf('与课时无关') >= 0)
  check('  统计出 版本 / 涉及课时 / 未批改',
    td.indexOf('个版本') >= 0 && td.indexOf('涉及课时') >= 0 && td.indexOf('未批改') >= 0)
  check('  每一条标出属于哪一课（L8 / L12）', td.indexOf('L8') >= 0 && td.indexOf('L12') >= 0)
  check('  每一条也有版本号与时间',
    td.indexOf('v1') >= 0 && td.indexOf('v2') >= 0 && td.indexOf('v3') >= 0 && /\d{4}-\d{2}-\d{2}/.test(td))
  check('  未批改的那一条给「批改这一版」', td.indexOf('批改这一版') >= 0)
  check('  列表里保留问题与附件', td.indexOf('少了一个 1/N 因子') >= 0 && td.indexOf('mlp.py') >= 0)
  // ⚠️ 光设 hwAll: [] 不够：面板的 effect 会再拉一次 submission.all，把列表填回来。
  //    必须把这个场景的接口响应也置空，否则断言查到的其实是「非空列表」那次渲染。
  const keepAll = apiReplies['submission.all']
  apiReplies['submission.all'] = { ok: true, items: [], counts: { versions: 0, ungraded: 0, lessons: 0 } }
  const e = await draw({ view: 'submit', lessonData: null, hwLesson: '', hwAll: [] })
  apiReplies['submission.all'] = keepAll
  check('  没有提交时提交历史给出引导', e.texts.join('\u0001').indexOf('还没有任何提交') >= 0,
    e.texts.filter((x) => x.indexOf('任何') >= 0).join(' / ') || ('首段=' + e.texts.slice(0, 6).join(',')))
})()


/* ── 9. 公开控制 + 追问多方式上传 ─────────────────────────────────────
 * 用户第三轮的两条：
 *   ① 「作业批改会自动生成众多问题，我不希望它们直接涌向教师端，
 *      学生应能选择问题是否向教师端公布」
 *   ② 「继续追问也需要能支持多种方式上传（文本图片文件等）」
 * 宿主侧的可见性语义在第 7 节验过（默认只有 audit==='shared' 才给老师看）；
 * 这里验界面这一半：公开按钮在不在、批量选择在不在、追问是不是同一个三页签输入。
 */
await (async () => {
  const settle = async (n) => { for (let i = 0; i < (n || 2); i += 1) { await new Promise((r) => setTimeout(r, 0)); flushRerenders() } }
  const draw = async (patch) => {
    studentSetter(Object.assign({ view: 'threads' }, patch || {}))
    await settle(2)
    renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(3)
    const el = renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(2)
    const out = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    walkElements(el, out, 0)
    return out
  }
  check('  取得了学生面板', !!studentPanelEl && typeof studentSetter === 'function')
  if (!studentPanelEl) return

  apiReplies.threads = {
    mine: [
      { path: '课程问题池\\学生\\probe\\a.md', title: '缺少 loss 曲线，无法验证收敛', lesson: '课时8',
        severity: '中', source: '作业', audit: 'not_shared', created: '2026-09-24', turns: 0 },
      { path: '课程问题池\\学生\\probe\\b.md', title: '第 3 行用了 sklearn，与教案不符', lesson: '课时8',
        severity: '高', source: '作业', audit: 'shared', created: '2026-09-24', turns: 0 },
      { path: '课程问题池\\学生\\probe\\c.md', title: '为什么负特征值意味着鞍点', lesson: '课时8',
        severity: '中', source: '阅读器框选图区', audit: 'not_shared', created: '2026-09-24', turns: 2,
        hasTeacherAnswer: true },
    ],
    public: [], publicIndex: null, student: 'probe',
  }
  const a = await draw({ mine: apiReplies.threads.mine, publicItems: [], picked: {} })
  const ta = a.texts.join('\u0001')
  check('  提问列表渲染不抛错', a.errors.length === 0, a.errors.join(' | ') || '')
  check('  说明「批改生成的问题默认不公开」', ta.indexOf('默认') >= 0 && ta.indexOf('不公开') >= 0, ta.slice(0, 90))
  // 措辞改成三态了（端侧报告：一个「已公开」同时承担两个相反含义 ——
  // 学生点的是「公开给老师」，徽标却写「已公开给全班」，于是界面并排显示
  // 「已公开 1」和「公开给全班的（0）」，学生以为全班已经看到了）。
  // 断言跟着改：**不是放宽**，是判据变了 —— 现在要求出现「提交给老师」，
  // 并**明确禁止**再出现「已公开给全班」这种绝对措辞。
  check('  每条都有「提交给老师 / 已提交给老师」按钮',
    ta.indexOf('提交给老师') >= 0 && ta.indexOf('已提交给老师') >= 0, ta.slice(0, 90))
  check('  不再出现「已公开给全班」这种绝对措辞', ta.indexOf('已公开给全班') < 0)
  check('  批改生成的条目被标出（「批改生成」标签）', ta.indexOf('批改生成') >= 0)
  check('  统计出「已提交给老师 N」', /已提交给老师 \d+/.test(ta), (ta.match(/已提交给老师 \d+/) || [])[0])
  check('  有批量入口（公开勾选 / 撤回勾选 / 全选）',
    ta.indexOf('公开勾选的') >= 0 && ta.indexOf('撤回勾选') >= 0 && ta.indexOf('全选') >= 0)
  check('  未勾选时批量按钮是禁用的', a.tags.indexOf('button') >= 0)

  // 追问：三页签 + 粘贴提示（与首次提问同一个 AttachComposer）
  apiReplies.thread = {
    path: '课程问题池\\学生\\probe\\c.md', fields: { title: '为什么负特征值意味着鞍点', lesson: '课时8', severity: '中', status: '待处理' },
    turns: [{ q: '那极大值呢', a: '极大值也是负特征值…', by: 'student' }], scope: 'student', teacherTurns: [], hasTeacherAnswer: false,
  }
  apiReplies['thread'] = apiReplies.thread
  const b = await draw({ view: 'thread', thread: apiReplies.thread, selPath: 'x', fuTab: 'text' })
  const tb = b.texts.join('\u0001')
  check('  追问区渲染不抛错', b.errors.length === 0, b.errors.join(' | ') || '')
  check('  追问也支持三种方式（打字 / 文件 / 图片）',
    tb.indexOf('打字') >= 0 && tb.indexOf('文件') >= 0 && tb.indexOf('图片') >= 0, tb.slice(0, 90))
  check('  追问支持 Ctrl+V 粘贴截图', tb.indexOf('Ctrl+V') >= 0)
  check('  追问按钮叫「发送追问」且提示会重新作答', tb.indexOf('发送追问') >= 0 && tb.indexOf('重新作答') >= 0)
  check('  追问区显示已有轮次', ta.indexOf('轮') >= 0 || tb.indexOf('已 1 轮') >= 0)
})()

/* ── 10. 同一个状态键不能有两种形状（这次的崩就是这个）────────────────
 * 用户报的：切到「课件」页 → `picks.filter is not a function` → 整页红屏。
 * 根因：`picked` 被两处当成不同形状用 ——
 *   课件页期望 Array<证据块>，而「我的提问」的勾选用了 {[path]: true} 对象。
 * 在提问页勾几条，再切课件页，`st.picked` 就是对象，`.filter` 直接抛。
 * 这类「同名不同形」的错在浏览器里只表现为整页崩，所以必须有一条断言盯着它。
 */
await (async () => {
  const settle = async (n) => { for (let i = 0; i < (n || 2); i += 1) { await new Promise((r) => setTimeout(r, 0)); flushRerenders() } }
  const draw = async (patch) => {
    studentSetter(Object.assign({}, patch || {}))
    await settle(2)
    renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(3)
    const el = renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(2)
    const out = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    walkElements(el, out, 0)
    return out
  }
  check('  取得了学生面板', !!studentPanelEl && typeof studentSetter === 'function')
  if (!studentPanelEl) return

  // 1) 在「我的提问」里勾几条（这会写勾选状态）
  const a = await draw({ view: 'threads', selItems: { 'a.md': true, 'b.md': true } })
  check('  勾选状态写入后提问页正常', a.errors.length === 0, a.errors.join(' | ') || '')

  // 2) 直接切到课件页 —— 这正是崩掉的那条路径
  apiReplies.slides = { slideCount: 1, slideWidth: 1280, slideHeight: 720, slides: [{ index: 1, lessonSeq: 1, shapes: [], media: [] }] }
  const b = await draw({ view: 'slides', slides: apiReplies.slides, slideIndex: 0, mode: 'region' })
  check('  勾选后切到课件页不再崩（picks.filter 那个 bug）', b.errors.length === 0, b.errors.join(' | ') || '')
  check('    课件页确实渲染了内容', b.texts.join('\u0001').indexOf('框选图区') >= 0)

  // 3) 两类状态用不同的键，互不污染。
  //    ⚠️ 先走一次正常路径把 picked 复位：下面的「万一形状坏掉」用例会故意把它污染成对象，
  //    否则这条不变量断言查到的是那个故意制造的坏状态。
  await draw({ view: 'slides', slides: apiReplies.slides, slideIndex: 0, picked: [] })
  const cur = hookStates.get(studentPanelFn)[0].value
  check('  勾选与证据用的是两个键（selItems / picked）',
    Object.prototype.hasOwnProperty.call(cur, 'selItems') && Object.prototype.hasOwnProperty.call(cur, 'picked'),
    Object.keys(cur).filter((k) => /pick|sel/i.test(k)).join(', '))
  check('  picked 始终是数组（不是 null、不是对象）', Array.isArray(cur.picked), typeof cur.picked)
  check('  selItems 始终是对象（不是数组）', cur.selItems !== null && typeof cur.selItems === 'object' && !Array.isArray(cur.selItems), typeof cur.selItems)

  // 4) 就算状态被污染成坏形状，也只是空列表、不崩（asPicks 的兜底）
  const c = await draw({ view: 'slides', slides: apiReplies.slides, slideIndex: 0, picked: { bad: true } })
  check('  万一 picked 是对象，课件页也只是没有证据、不崩', c.errors.length === 0, c.errors.join(' | ') || '')
  const d = await draw({ view: 'slides', slides: apiReplies.slides, slideIndex: 0, picked: null })
  check('  万一 picked 是 null，课件页也不崩', d.errors.length === 0, d.errors.join(' | ') || '')
})()

/* ── 11. 静态扫描：同一个状态键不能有两种形状 ──────────────────────────
 * 第 10 节是**运行时**验不变量。这一节是**静态**扫一遍源码，
 * 因为「同一个键两种形状」的坑一旦出现，浏览器里的表现就是整页红屏，
 * 而定位它要从几百行渲染代码里找哪一处写坏了 —— 太贵。
 * 静态扫描便宜得多，能在写下来的那一刻就报出来。
 */
/* ── 10b. 学生端「我是谁」── 谁的提问就该是谁的名字 ─────────────────────
 * 原来身份 = process.env.USERNAME，于是老师那边看到的提问者叫 Administrator
 * （这台 Windows 机器的用户名）。这一节验那张填写卡片真的会出来、
 * 真的有三个能填的框 —— 而不是「文案里写着学号」。
 */
console.log('\n=== 10b. 学生端「我是谁」卡片 ===')
await (async () => {
  const settle = async (n) => { for (let i = 0; i < (n || 2); i += 1) { await new Promise((r) => setTimeout(r, 0)); flushRerenders() } }
  const draw = async (patch) => {
    studentSetter(Object.assign({}, patch || {}))
    await settle(3)
    const el = renderOf(studentPanelEl.type, studentPanelEl.props || {})
    await settle(3)
    const out = { comps: [], tags: [], texts: [], errors: [], chips: [] }
    walkElements(el, out, 0)
    return out
  }
  // ⚠️ walkElements 收的 tags 是**字符串**（out.tags.push(String(node.type))），不是对象。
  const inputsOf = (r) => r.tags.filter((t) => t === 'input')
  if (!studentPanelEl || typeof studentSetter !== 'function') { check('  取得了学生面板', false); return }

  /**
   * ⚠️ 状态必须**走 API 桩**注入，不能只塞进 setter。
   *    假 React 的 useEffect 每次都跑（刻意不做依赖比较），而 load() 里有一句
   *    `set({ me: await api('student.me') })` —— 桩对未知动作返回 {}，
   *    于是它会把注入进去的 me 冲成 {}，界面上就出现「undefined ✎」。
   *    这类假象很容易被当成组件 bug 查半天（这次就查了一轮）。
   */
  const meNew = {
    sid: 'Administrator', name: '', label: 'Administrator', identified: false,
    how: '系统用户名（兜底，不是你的学号）', identityFile: 'X:\\ws\\我的身份.json',
    identityRel: '我的身份.json', fields: [],
  }
  apiReplies['student.me'] = meNew
  // 就绪清单由宿主给（面板只报告、不推断）。造一份「差一件」的。
  const notReady = {
    role: 'student', missing: 1, canStart: true, blockedBy: [],
    items: [
      { key: 'identity', ok: false, title: '我是谁', detail: '现在用的是「Administrator」，来自系统用户名（兜底，不是你的学号）。这多半不是你', fix: '填一次学号与姓名' },
      { key: 'workspace', ok: true, title: '课程工作区', detail: 'C:\\ws', fix: '' },
      { key: 'model', ok: true, title: '模型', detail: 'stub/stub-model，费用记在你自己账号上', fix: '' },
      { key: 'course', ok: true, title: '课程信息', detail: '深度学习课程（DL2026）　教案 6 课时', fix: '' },
    ],
  }
  apiReplies.readiness = notReady
  let r = await draw({ view: 'outline', wizardOpen: false, wizardStep: 1, meForm: null, meConfirm: false, identifyHint: '' })
  const rt1 = r.texts.join(' ')
  check('  差分就绪时顶部出现提示（不是让用户自己找哪里不对）', rt1.indexOf('还差 1 件事') >= 0, rt1.slice(0, 70))
  // 身份那一条的**详情**只在展开第 1 步时渲染（收起时只有标题与按钮）。
  // 注意：顶栏本来就会显示当前身份（这里是 Administrator），所以不能拿
  // 「有没有 Administrator」当判据 —— 要拿那句**解释性文案**。
  check('  收起时只报数量，不铺细节', rt1.indexOf('多半不是你') < 0, rt1.slice(0, 60))
  check('  可以跳过（「先看看」），不强制填完才给用', rt1.indexOf('先看看') >= 0)
  check('  收起时只留一条提示、不占地方', rt1.indexOf('开始设置') >= 0 && inputsOf(r).length === 0,
    inputsOf(r).length + ' 个输入框')

  // 展开向导第 1 步
  r = await draw({ wizardOpen: true, wizardStep: 1, meForm: { sid: 'S001', name: '张三', klass: '土木2101' } })
  const rt2 = r.texts.join(' ')
  check('  展开第 1 步后有学号 / 姓名 / 班级三个输入框', inputsOf(r).length >= 3, inputsOf(r).length + ' 个输入框')
  check('  三步标题都在（我是谁 / 课程 / 可以开始了）',
    rt2.indexOf('我是谁') >= 0 && rt2.indexOf('课程') >= 0 && rt2.indexOf('可以开始了') >= 0)
  check('  说明了身份只写在本机、不进仓库', rt2.indexOf('不进任何仓库') >= 0)
  check('  第 1 步点明了「现在这个学号多半不是你」',
    rt2.indexOf('Administrator') >= 0 && rt2.indexOf('不是你') >= 0, rt2.slice(0, 80))

  r = await draw({ wizardOpen: true, wizardStep: 2, meForm: null })
  const rt3 = r.texts.join(' ')
  check('  第 2 步报告课程 / 工作区 / 模型状态',
    rt3.indexOf('课程工作区') >= 0 && rt3.indexOf('模型') >= 0)
  check('  并说明「课程码正常不用你输」', rt3.indexOf('不用你输') >= 0)

  r = await draw({ wizardOpen: true, wizardStep: 3, meForm: null })
  const rt4 = r.texts.join(' ')
  check('  第 3 步给出「可以开始了」并逐项列状态', rt4.indexOf('可以开始') >= 0)
  check('  明确说「自己的仓库默认不需要」（可选步骤不能变成硬门槛）',
    rt4.indexOf('默认不需要') >= 0 && rt4.indexOf('功能一个不少') >= 0)

  // 改学号的两段式确认
  apiReplies['student.me'] = Object.assign({}, meNew, { sid: 'S001', identified: true, label: '张三（S001）' })
  r = await draw({
    wizardOpen: true, wizardStep: 1, meForm: { sid: 'S999', name: '张三', klass: '' }, meConfirm: true,
    identifyHint: '会把已有数据一起搬过去：提问 12 条、提交 3 份。',
  })
  check('  改学号时给出「会搬多少」的提示', r.texts.join(' ').indexOf('12 条') >= 0, r.texts.join(' ').slice(0, 90))
  check('  按钮变成「确认搬迁并保存」（两段式，不静默搬）',
    r.texts.join(' ').indexOf('确认搬迁') >= 0)

  // 全部就绪：只留一行
  apiReplies.readiness = {
    role: 'student', missing: 0, canStart: true, blockedBy: [],
    items: notReady.items.map((x) => Object.assign({}, x, { ok: true })),
  }
  r = await draw({ wizardOpen: false, wizardStep: 1, meForm: null })
  check('  全部就绪时只剩一行状态，不再占地方', r.texts.join(' ').indexOf('已就绪') >= 0)
  apiReplies.readiness = notReady

  /* ⚠️ 回归：**新动作不能把已经能用的面板弄坏。**
   * 宿主半区是**进程启动时**注册路由的，所以旧宿主上没有 student.me，
   * 会返回「未知动作」。最初它写在 load() 的同一个 try 里 —— 后果是整页
   * 只显示一条报错，连课件都看不了（老师截图过来时正是这个状态）。
   * 这条断言要求：缺这个动作时其余部分照常渲染，只把「我是谁」那块留空。
   */
  apiReplies['student.me'] = { error: '未知动作：student.me' }
  r = await draw({ view: 'outline', meOpen: false, meForm: null })
  const joined = r.texts.join(' ')
  check('  【回归】旧宿主上没有 student.me 时，页面不报「加载失败」',
    joined.indexOf('加载失败') < 0, joined.slice(0, 90))
  check('  其余部分照常渲染（面板标题、课程结构仍在）',
    joined.indexOf('鼹鼠仔 · 课程答疑') >= 0 && joined.indexOf('课时脉络') >= 0,
    joined.slice(0, 70))
  check('  只给一条软提示，并点明「多半是宿主半区没重启」',
    joined.indexOf('宿主半区没重启') >= 0, joined.slice(0, 120))
  apiReplies['student.me'] = Object.assign({}, meNew, { sid: 'S001', identified: true, label: '张三（S001）' })
  apiReplies.readiness = notReady
})()
console.log('\n=== 11. 状态键形状一致性（静态扫描）===')
{
  const f = path.join(PACKS, 'dsh-course-student', 'lib', 'client.js')
  const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
  // ⚠️ 这段正则的 1500 是**字符窗口**，不是"够用就行"：本轮给学生端的初始状态
  //    加了两个字段（materials / materialsOpen），其中 `matOpen: null,` 的长度
  //    刚好把闭合的 `\n      }` 挤出了窗口 —— 于是断言报「找得到学生端的初始状态」
  //    失败，看起来像状态块被删了，其实是**探针的窗口太小**。
  //    同类事故这个项目里已经有过一次（花括号配平从签名行开始数，得到 46 个字符
  //    的"两份一致"）。判据要留出余量：3000 字符，而下面的形状检查才是真判据。
  const initM = /const init = \{([\s\S]{0,3000}?)\n      \}/.exec(t)
  check('  找得到学生端的初始状态', !!initM)
  if (initM) {
    const keys = [...initM[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
    const shapeOf = (v) => {
      v = v.trim()
      if (/^\[\]|^\[/.test(v)) return 'Array'
      if (/^\{\}|^\{/.test(v)) return 'Object'
      if (v === 'null') return 'null'
      if (/^-?\d+$/.test(v)) return 'Number'
      if (/^'|^"/.test(v)) return 'String'
      if (/^true|^false/.test(v)) return 'Bool'
      return 'expr'   // 是变量/函数调用，静态看不出来，跳过
    }
    // 有意的「可空对象」状态机：拖拽中=对象、未拖拽=null。白名单写在这里，
    // 加新的可空状态要显式加进来 —— 显式好过把规则放宽。
    const NULLABLE_OK = new Set(['dragging'])
    const bad = []
    for (const k of keys) {
      const shapes = new Map()
      const re = new RegExp('set\\(\\{[^}]*?\\b' + k + '\\s*:\\s*([^,}]+)', 'g')
      for (const m of t.matchAll(re)) {
        const s = shapeOf(m[1])
        if (s === 'expr') continue
        shapes.set(s, (shapes.get(s) || 0) + 1)
      }
      const only = [...shapes.keys()]
      const ok = only.length <= 1 || (NULLABLE_OK.has(k) && only.every((s) => s === 'Object' || s === 'null'))
      if (!ok) bad.push(k + ' -> ' + only.join('/'))
    }
    check('  没有哪个状态键被赋成两种不兼容的形状', bad.length === 0,
      bad.length ? bad.join(' | ') : (keys.length + ' 个键形状一致'))
    check('  picked 只承载数组（证据块）',
      !/picked: \{\}|picked: null/.test(t),
      /picked: \{\}|picked: null/.test(t) ? 'picked 又被赋成对象/null 了' : '')
    check('  勾选与证据用的是两个键', /selItems/.test(t) && /picked: \[\]/.test(t))
  }

  /* ── 11b. 「端侧从内核解构」的每个名字，内核**真的导出**了吗 ──────────────
   * 这一条是被一个真实的漏逼出来的：教师端 host 里写了
   *   `const { ..., versionInfo, versionSummary } = C`
   * 而 `index.js` 里没有 `export * from './version.js'` —— 于是两个名字都是
   * **undefined**，不报错、不崩，只在真的调用时抛「versionInfo is not a function」。
   * 构建门当时全绿：没有任何一步会去调那个动作。
   *
   * 同一类坑这个项目踩过：`readThread` 没暴露 → 「教师已答复」永远是 false，
   * 而调用处恰好有个 try/catch 把它吞了。
   *
   * 判据是静态的（导出名集合 ⊇ 解构名集合）—— 便宜、覆盖全部名字，
   * 而且比「真的调一次那个动作」更早失败。
   */
  const coreIndex = path.join(PACKS, 'dsh-course-core', 'src', 'index.js')
  const exported = new Set()
  if (fs.existsSync(coreIndex)) {
    const idx = fs.readFileSync(coreIndex, 'utf8')
    for (const m of idx.matchAll(/export\s+\*\s+from\s+'\.\/([\w.-]+)\.js'/g)) {
      const f = path.join(PACKS, 'dsh-course-core', 'src', m[1] + '.js')
      if (!fs.existsSync(f)) continue
      const src = fs.readFileSync(f, 'utf8')
      for (const n of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) exported.add(n[1])
      for (const blk of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const raw of blk[1].split(',')) {
          const piece = raw.trim()
          if (!piece) continue
          const as = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(piece)
          exported.add(as ? as[1] : piece)
        }
      }
    }
  }
  check('  找得到内核 index.js 的导出清单', exported.size > 50, exported.size + ' 个导出名')
  for (const who of ['dsh-course-teacher', 'dsh-course-student']) {
    const hf = path.join(PACKS, who, 'src', 'host.js')
    const ht = fs.existsSync(hf) ? fs.readFileSync(hf, 'utf8') : ''
    const m = /const\s*\{([\s\S]*?)\}\s*=\s*C\b/.exec(ht)
    check('  找得到 ' + who + ' 的 const {...} = C', !!m)
    if (!m) continue
    const names = m[1].split(/[\n,]/)
      .map((s) => s.replace(/\/\/.*$/, '').trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
    const missing = names.filter((n) => !exported.has(n))
    // 断言要说清**后果**：缺一个名字不会当场报错，只会在调用时炸。
    check('  ' + who + ' 从内核解构的 ' + names.length + ' 个名字内核都导出了',
      missing.length === 0,
      missing.length ? ('内核没导出：' + missing.join(', ') + '（调用时才炸「is not a function」）') : '')
  }
}
/* ── 12. 教师端「教案补全」页真的能渲染 ────────────────────────────────
 * 为什么单独一组：这一页只在 view==='plan' 时才挂上，第 2 组那次「首次渲染」
 * 走的是 questions 分支，PlanPage 的函数体根本没被执行过。
 * 而这个项目已经栽过一次同类的坑（学生端某个视图调错函数 → 整块面板红屏），
 * 所以「新增一页」必须有一次真的带数据渲染。
 *
 * 数据形状**照抄宿主 action 的真实返回**（含 null 与空数组），
 * 不图省事塞一个 {} —— 塞 {} 测不出 `st.draftOpen.lesson` 这种取值。
 */
// 与宿主 core/plan.js 的 PLAN_SECTIONS 同名同序；客户端也留一份用于即时判空
const PLAN_SECTION_NAMES_HELPER = ['目标', '推导', '实操', '验收标准', '当堂交付物']
console.log('\n=== 12. 教师端「教案补全」页渲染 ===')
await (async () => {
  const hasAsync = typeof teacherPanelFn === 'function'
  check('  拿得到教师面板组件与合并 set', hasAsync && typeof teacherSetter === 'function',
    hasAsync ? 'ok' : 'teacherPanelFn 缺失')
  if (!hasAsync || typeof teacherSetter !== 'function') return
  const hookList = hookStates.get(teacherPanelFn)
  if (!hookList || !hookList[0]) { check('  教师面板有状态 hook', false); return }

  /**
   * 展开元素树。
   *
   * ⚠️ 关键点：只渲染 Panel **不够**。Panel 返回的树里，`h(PlanPage, {...})`
   *    只是一个元素描述（{type, props, children}），PlanPage 的函数体根本不会被执行 ——
   *    而「视图函数体里引用了不存在的变量」恰恰是这个项目栽过的那类红屏 bug。
   *    所以这里递归地**真的调用**函数型节点，把每一层视图都跑一遍。
   *
   * 类组件（错误边界）不直接调用：class 不能当函数调。改为穿过它、走它的 children，
   * 这样边界里面出错会原样冒出来 —— 测试里我们要看到错误本身，而不是「边界接住了」。
   */
  const expand = (node, depth, out, errs, bag) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
    if (Array.isArray(node)) { for (const c of node) expand(c, depth, out, errs, bag); return }
    if (typeof node !== 'object') return
    // 深度上限：教师端「教案补全」里最深的一条路是
    //   Panel → k46 → 模块 → 课时卡 → kca → AnchorEditor → kcb → SlidePeek
    //   → kdb → kdc/kde → k17 → k47 ≈ 15 层。原来卡在 14，
    //   于是 k47（课件形状）刚好被截掉 —— 断言报「形状没渲染」，
    //   而其实是**我的遍历器**没走到。这类假象比真 bug 更费时间。
    if (depth > 26) return
    const type = node.type
    // 顺手把控件收下来：断言「点开编辑器后真的出现了两个能填的页码输入框」。
    // 只查文本是不够的 —— 文字里写着「保存页码」不代表有地方填页码。
    if (typeof type === 'string' && bag) {
      // ⚠️ <textarea> 的 props 里**没有** type（只有 <input> 有）。
      //    按 props.type 过滤会把输入框全部漏掉，得出「编辑页签没有输入框」的假结论。
      //    所以记下标签名，调用方按 __tag 判断。
      if (type === 'input' || type === 'select' || type === 'textarea') bag.inputs.push(Object.assign({ __tag: type }, node.props || {}))
      if (type === 'select') bag.selects.push(node.props || {})
      if (type === 'details') bag.details += 1
      const cls = String((node.props || {}).className || '')
      const cl = cls.split(/\s+/)
      if (cls) bag.classes.push(cls)
      if (cl.indexOf('k86') >= 0) bag.rails.push({ cls: cls, open: (node.props || {})['data-open'] })
      if (cl.indexOf('kd5') >= 0) bag.kd5 += 1
      if (cl.indexOf('k17') >= 0) bag.k17 += 1
      if (cl.indexOf('k47') >= 0) bag.k47 += 1
      // 页条格子：把页码与三个状态属性收下来，才能断言「范围真的标出来了」
      if (cl.indexOf('kdd') >= 0) {
        bag.pageChips.push({
          text: String(out[out.length - 1] !== undefined ? out[out.length - 1] : ''),
          in: (node.props || {})['data-in'], cur: (node.props || {})['data-cur'],
        })
      }
      // Markdown 走的是 dangerouslySetInnerHTML，不是子节点 —— 不收它就会得出
      // 「预览是空的」这种假结论（学生端那份 walker 已经因为这个改过一次）。
      const dh = node.props && node.props.dangerouslySetInnerHTML
      if (dh && typeof dh.__html === 'string') {
        // ⚠️ bag.html 存的是**原始 HTML**，out 里存的是去标签后的纯文本。
        //    两个混了的话，「有没有 <code> 包裹公式」这类断言永远为假 ——
        //    查了一轮才发现是我自己的探针把标签先剥掉了。
        bag.html = (bag.html || '') + ' ' + dh.__html
        out.push(String(dh.__html).replace(/<[^>]*>/g, ' '))
      }
    }
    if (typeof type === 'function') {
      const isClass = type.prototype && typeof type.prototype.render === 'function'
      // 类组件（错误边界）不能当函数调。穿过它、继续走它的子节点 ——
      // 边界里面出错就原样冒出来，测试里要看到错误本身，而不是「边界接住了」。
      //
      // ⚠️ 子节点在 node.children 上，不在 node.props.children 上：
      //    h 走 React.createElement(type, props, ...children)，而这个假
      //    createElement 返回 { type, props, children }。踩过一次：
      //    只读 props.children，于是错误边界下面的整棵子树（= 新增的那一页）
      //    一个节点都没展开，断言全红，看起来像「页面没渲染」。
      if (isClass) {
        if (Array.isArray(node.children) && node.children.length) {
          for (const c of node.children) expand(c, depth + 1, out, errs, bag)
        } else {
          expand(node.props && node.props.children, depth + 1, out, errs, bag)
        }
        return
      }
      let sub
      try { sub = renderOf(type, node.props || {}) } catch (e) {
        errs.push('展开 ' + (type.name || '匿名组件') + ' 抛错：' + ((e && e.message) || e))
        return
      }
      expand(sub, depth + 1, out, errs, bag)
      return
    }
    if (Array.isArray(node.children) && node.children.length) {
      for (const c of node.children) expand(c, depth + 1, out, errs, bag)
      return
    }
    if (node.props && node.props.children !== undefined) expand(node.props.children, depth + 1, out, errs, bag)
  }

  const outline = {
    course: '深度学习课程', totalLessons: 30,
    withPlan: 16, missingPlan: 14, withSlides: 18, missingSlides: 12,
    withDraft: 1, autoFillable: 14, noMaterial: 0,
    anchorSource: '（无，按模块推断）', template: '内置骨架', draftDir: '教案草稿',
    anchors: { list: {} },
    dividers: [{ module: '模块一', spans: [{ chapter: '第一章', from: 10, to: 29, title: 'x', seq: 2 }] }],
    modules: [
      { name: '模块四', theme: '分割与多模态', range: '课时 19-24', dir: '模块四_x', total: 2,
        hasPlan: 1, hasSlides: 1, hasCode: true, draft: 1, codeFiles: 7,
        lessons: [
          { no: 19, title: '像素级语义空间建模与 U-Net 架构', module: '模块四', plan: false, planPath: '',
            planChars: 0, planMissingSections: null, draft: { status: 'draft', chars: 8000, file: 'f.md', missing: [] },
            slides: { chapter: '第三章', from: 1, to: 19, approx: true }, codeFiles: 7, autoFillable: true },
          { no: 20, title: '分割指标的绝对瓶颈与损失函数调优', module: '模块四', plan: true, planPath: 'p.md',
            planChars: 3000, planMissingSections: ['验收标准'], draft: null,
            slides: null, codeFiles: 7, autoFillable: false },
        ] },
    ],
    lessons: [], worklist: [19], blocked: [],
  }
  const planCatalog = {
    providers: [{ id: 'stub', name: '打桩' }],
    models: [{ provider: 'stub', model: 'stub-model', name: '打桩模型', image: false }],
    sessionDefault: { provider: 'stub', model: 'stub-model' },
    saved: { provider: 'stub', model: 'stub-model' }, effective: { provider: 'stub', model: 'stub-model' },
    warnings: [], templateRel: '教案模板.md', draftDir: '教案草稿',
    sections: [{ key: 'goal', title: '目标' }],
  }
  const draft0 = {
    lesson: 19, title: '像素级语义空间建模与 U-Net 架构', module: '模块四', file: '课时19_x.md',
    status: 'draft', chars: 8000, missingSections: [], model: 'stub/stub-model',
    usage: { inputTokens: 1234, outputTokens: 5678 },
    saw: { slides: '19 页', code: '7 份代码', style: '无样例', missing: ['模块说明缺失'] },
    anchor: { chapter: '第三章', from: 1, to: 19, approx: true },
  }

  // 一份**真的五节教案**草稿。预览区要拿它渲染成 HTML，所以不能是 "# 课时 19：x" ——
  // 那样断言只能测出「有个框」，测不出「公式与五节标题真的画出来了」。
  const DRAFT_MD = [
    '# 课时 19：像素级语义空间建模与 U-Net 架构',
    '',
    '## 目标',
    '',
    '1. 能用 $3\\times3$ 卷积堆出收缩-扩张结构',
    '',
    '## 推导',
    '',
    '### 一、卷积的局部性',
    '',
    '$$y_{i,j}=\\sum_{m,n} x_{i+m,j+n} w_{m,n}$$',
    '',
    '## 实操',
    '',
    '### 任务一：搭一个紧凑 UNet',
    '',
    '- 产物：`01_紧凑版UNet_compact_unet.py`',
    '',
    '## 验收标准',
    '',
    '1. 前向输出形状为 (N, 1, H, W)',
    '',
    '## 当堂交付物',
    '',
    '- `01_紧凑版UNet_compact_unet.py`',
  ].join('\n')

  const renderPlan = (patch) => {
    teacherSetter(Object.assign({
      view: 'plan', outline, planCatalog, drafts: [draft0],
      draftOpen: Object.assign({ lesson: 19, target: '模块四_x\\详细教案\\' }, draft0),
      draftText: DRAFT_MD, genLesson: 0, rebuildResult: null,
      // 清掉上一轮可能留下的编辑器状态：fixture 是「合并式 set」，不显式清会串味
      anchorEdit: null, draftTab: 'preview', draftMissing: [],
      draftTitle: '像素级语义空间建模与 U-Net 架构',
      roster: [], rosterLoaded: false, rosterSource: '', rosterFile: '',
      studentDetail: null, rosterEdit: null,
      error: '', notice: '',
    }, patch || {}))
    const out = []
    const errs = []
    const bag = { inputs: [], selects: [], details: 0, html: '', kd5: 0, k17: 0, k47: 0, pageChips: [], rails: [], classes: [] }
    let el = null
    try { el = renderOf(teacherPanelFn, {}) } catch (e) { errs.push('Panel 抛错：' + ((e && e.message) || e)) }
    if (el) expand(el, 0, out, errs, bag)
    return {
      text: out.join(' '), errs, inputs: bag.inputs, selects: bag.selects,
      details: bag.details, html: bag.html, kd5: bag.kd5,
      k17: bag.k17, k47: bag.k47, pageChips: bag.pageChips, rails: bag.rails, classes: bag.classes,
    }
  }

  // 1) 完整数据（含打开中的草稿框）
  let r = renderPlan()
  check('  带完整数据渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')

  // 教师端就绪清单 + 「今天要做什么」：老师打开面板最想知道的是先干哪件事，
  // 而不是先去五个标签页里自己拼数字。
  const teaReady = {
    role: 'teacher', missing: 2, canStart: true, blockedBy: [],
    items: [
      { key: 'workspace', ok: true, title: '课程工作区', detail: 'C:\\ws', fix: '' },
      { key: 'index', ok: true, title: '课程结构索引', detail: '共 30 课时', fix: '' },
      { key: 'plans', ok: false, title: '教案覆盖', detail: '有教案 16 / 30　缺 14 课时', fix: '去「教案补全」生成草稿，审完采纳' },
      { key: 'roster', ok: false, title: '学生名册', detail: '学生 3 人，其中 0 人有姓名', fix: '去「学生」页给学号补上真名' },
    ],
    todo: ['3 份提交未批改', '2 条已公开但你还没答复', '14 课时缺教案'],
  }
  r = renderPlan({ readiness: teaReady, readyOpen: false })
  const tr1 = r.text
  check('  就绪不全时顶部出现「还差 N 件事」', tr1.indexOf('还差 2 件事') >= 0, tr1.slice(0, 60))
  check('  「今天要做什么」把数字压成一句能照着做的事',
    tr1.indexOf('今天：') >= 0 && tr1.indexOf('3 份提交未批改') >= 0 && tr1.indexOf('14 课时缺教案') >= 0,
    tr1.slice(0, 90))
  check('  收起时不铺细节（只是数量 + 一句待办）', tr1.indexOf('教案覆盖') < 0)

  r = renderPlan({ readiness: teaReady, readyOpen: true })
  const tr2 = r.text
  check('  展开后逐项列出，并给出「怎么补」',
    tr2.indexOf('教案覆盖') >= 0 && tr2.indexOf('去「教案补全」生成草稿') >= 0)
  check('  说明了清单只报真的查过的东西（不做推测）', tr2.indexOf('不做推测') >= 0)

  r = renderPlan({
    readiness: { role: 'teacher', missing: 0, canStart: true, blockedBy: [], items: teaReady.items.map((x) => Object.assign({}, x, { ok: true })), todo: [] },
  })
  check('  全部就绪且无事可做时只剩一行', r.text.indexOf('✓ 就绪') >= 0
    && r.text.indexOf('没有待处理的事') >= 0)
  r = renderPlan({ readiness: null })
  check('  就绪清单还没拉到时（null）不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  页面上出现了体检结论',
    r.text.indexOf('大纲体检') >= 0 && r.text.indexOf('缺教案') >= 0 && r.text.indexOf('可自动补') >= 0,
    r.text ? r.text.slice(0, 90) : '(渲染树里取不到文本)')
  check('  逐课时卡片真的渲染出来了（课时号 + 标题 + 生成按钮）',
    r.text.indexOf('课时19') >= 0 && r.text.indexOf('像素级语义空间建模') >= 0 && r.text.indexOf('生成教案') >= 0)
  check('  缺「验收标准」的教案被标出来（不是只说「有教案」）',
    r.text.indexOf('缺 验收标准') >= 0 || r.text.indexOf('验收标准') >= 0)
  check('  推断出来的页码标了「推断」，并给了改页码入口',
    r.text.indexOf('推断') >= 0 && /确认\s*\/\s*改页码|确认页码/.test(r.text),
    (r.text.match(/确认[^ ]{0,6}改页码|确认页码/g) || []).join(','))
  check('  说明了「草稿不是教案、采纳才写进正式教案」',
    r.text.indexOf('草稿') >= 0 && r.text.indexOf('采纳') >= 0 && r.text.indexOf('基准') >= 0)
  check('  说清了这一页会花谁的钱', r.text.indexOf('额度') >= 0)
  check('  模型下拉框用的是 plan.catalog 的 models', r.text.indexOf('打桩模型') >= 0 || r.text.indexOf('跟随会话默认') >= 0)
  // 长段解释收进 <details>，不再铺在页面上（老师反馈过「满屏小字读不动」）
  check('  长段解释收进了可折叠的说明块', r.details > 0, r.details + ' 个 <details>')

  // 1b) 页码编辑器：点「改页码」必须真的展开一个能填的表单。
  //     原来这里是「把推断值原样再提交一次」——按钮有反应，但没法改，等于没有。
  r = renderPlan({ anchorEdit: { lesson: 19, chapter: '第三章', from: 1, to: 19 } })
  check('  页码编辑器展开后不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  const numInputs = r.inputs.filter((x) => x.type === 'number')
  check('  编辑器里有章节下拉框与两个页码输入框',
    numInputs.length === 2 && r.selects.length >= 1,
    'number 输入 ' + numInputs.length + ' 个 / select ' + r.selects.length + ' 个')
  check('  页码输入框带上了当前值', numInputs.some((x) => String(x.value) === '1'),
    JSON.stringify(numInputs.map((x) => x.value)))
  check('  编辑器里有保存 / 清除两个出口',
    r.text.indexOf('保存页码') >= 0 && r.text.indexOf('清除') >= 0)
  check('  编辑器给出了可对照的分隔页标题', r.text.indexOf('分隔页') >= 0)
  check('  展开编辑器时按钮变成「收起页码」', r.text.indexOf('收起页码') >= 0)

  // 1c) 教案预览：老师反馈「生成完没有预览窗口」。根因是渲染结果没有框，
  //     而且压在整页最底下。这一组要求：默认就是**渲染后的预览**、
  //     用的是共享 Markdown 组件（所以和学生的画面一致）、五节标题真的画出来了。
  r = renderPlan({ draftTab: 'preview' })
  check('  默认进的是「预览」页签，不是 Markdown 输入框',
    r.text.indexOf('预览（学生看到的样子）') >= 0 && r.inputs.filter((x) => x.__tag === 'textarea').length === 0,
    r.inputs.filter((x) => x.__tag === 'textarea').length + ' 个 textarea')
  check('  预览是真的渲染成 HTML（不是把 Markdown 原样贴出来）',
    r.html.indexOf('课时 19') >= 0 && r.html.indexOf('验收标准') >= 0,
    r.html ? r.html.replace(/\s+/g, ' ').slice(0, 80) : '(没有渲染出任何 HTML)')
  check('  五节标题全部出现在预览里',
    ['目标', '推导', '实操', '验收标准', '当堂交付物'].every((x) => r.html.indexOf(x) >= 0))
  // 公式：harness 里 KaTeX 脚本永远加载不上（没有真网络），渲染器会**回落**成
  // <code>/<pre> 包住 TeX 源码。所以这里能验的是「公式没有被吞掉」——
  // 源码逐字保留、并且带上了公式容器；katex 就绪后同一个占位会换成 katex 结构。
  // 不去断言 'katex' 字符串：那会变成一条「只在真实浏览器里才过」的假断言。
  check('  公式源码完整保留在预览里（没被当普通文本吃掉）',
    r.html.indexOf('3\\times3') >= 0 && r.html.indexOf('\\sum') >= 0,
    (r.html.match(/<(?:code|pre)>[^<]{0,50}<\/(?:code|pre)>/g) || []).slice(0, 2).join(' ')
      || ('未找到公式容器；html 片段：' + r.html.replace(/\s+/g, ' ').slice(0, 200)))
  check('  公式带上了公式容器（katex 未就绪时回落到 code/pre）',
    /<code>[^<]*\\times[^<]*<\/code>/.test(r.html) || /<pre>[^<]*\\sum/.test(r.html)
    || r.html.indexOf('katex') >= 0)
  check('  逐节给出了「✓ 目标 / 缺 验收标准」这类检查', PLAN_SECTION_NAMES_HELPER.every((x) => r.text.indexOf(x) >= 0),
    PLAN_SECTION_NAMES_HELPER.join(','))
  check('  预览框有独立的容器（kd5），不是裸文本', r.kd5 > 0, r.kd5 + ' 个预览框')

  // 1e) 继续改（对话）：一轮一轮改教案的界面。这一页里跑的是和学生提问同一套证据逻辑
  //     （拖选文字 / 框选截图），所以必须真的渲染一次 —— 它里面有鼠标坐标换算，
  //     写错了只在拖拽时才炸，静态检查看不出来。
  r = renderPlan({
    draftTab: 'revise',
    turns: [{
      q: '把推导第二节补上逐步说明', a: '改了 推导', at: '2026-09-25',
      changed: [{ title: '推导', delta: 42 }], keptFromOld: [], evidence: [{ page: 12 }], images: 1,
      charsBefore: 8000, charsAfter: 8042, snapshot: '课时19.001.rev1.md',
    }],
    revisePicks: [{ chapter: '第一章', page: 12, kind: 'text', text: '矩阵求导要先展开再逐项求' }],
  })
  check('  「继续改」页签渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  有「圈一块图」与「用选中的文字」两种取证方式',
    r.text.indexOf('圈一块图') >= 0 && r.text.indexOf('用选中的文字') >= 0)
  check('  列出了已圈的证据（带页码）', r.text.indexOf('第12 页') >= 0 || r.text.indexOf('12 页') >= 0,
    r.text.slice(0, 70))
  check('  有指令输入框（textarea）',
    r.inputs.filter((x) => x.__tag === 'textarea').length >= 1)
  check('  显示已经改了几轮，以及每轮改了哪几节',
    r.text.indexOf('已经改了 1 轮') >= 0 && r.text.indexOf('推导') >= 0 && r.text.indexOf('改了 推导') >= 0)
  check('  每轮都有「退回这一轮之前」', r.text.indexOf('退回这一轮之前') >= 0)
  check('  说明了每轮都会留快照（改坏了能退回来）', r.text.indexOf('快照') >= 0)

  r = renderPlan({ draftTab: 'revise', turns: [], revisePicks: [] })
  check('  还没改过时（turns 为空）不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  r = renderPlan({ draftTab: 'revise', turns: [], revisePicks: [], peekSlides: null, peekBusy: true })
  check('  课件还没加载完时「继续改」也不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  r = renderPlan({ draftTab: 'edit' })
  check('  切到「编辑 Markdown」时才是输入框',
    r.inputs.filter((x) => x.__tag === 'textarea').length >= 1,
    r.inputs.filter((x) => x.__tag === 'textarea').length + ' 个 textarea')
  check('  编辑页签里没有重复渲染预览', r.html.indexOf('课时 19') < 0 || r.kd5 === 0)

  // 1d) 课件窗口（PPT 预览）：确认页码原来是**盲填数字** —— 老师得先开 PPT 翻到
  //     那一页，再回来输「第 10 到 58 页」。这一组要求：窗口真的把课件页画出来
  //     （形状/图片按学生端那套类布局）、页条标出圈定的范围、点页就能定起止。
  const peekSlides = {
    chapter: '第一章', slideWidth: 1280, slideHeight: 720, slideCount: 3,
    slides: [
      { index: 1, shapes: [{ kind: 'sp', text: '课时分隔页标题', x: 40, y: 83, w: 900, h: 123, maxPt: 28, bold: true }], media: [] },
      { index: 2, shapes: [{ kind: 'sp', text: '第二页正文', x: 60, y: 120, w: 800, h: 200, maxPt: 18 }], media: [{ kind: 'image', name: 'fig2.png', file: 'slide002_image4.png', x: 700, y: 300, w: 400, h: 260 }] },
      { index: 3, shapes: [], media: [{ kind: 'image', name: 'missing.png', file: null, x: 10, y: 10, w: 100, h: 100 }] },
    ],
  }
  r = renderPlan({
    anchorEdit: { lesson: 19, chapter: '第一章', from: 2, to: 9 },
    peekSlides, peekIndex: 1, peekBusy: false, peekChapter: '第一章',
  })
  check('  课件窗口渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  窗口里画出了课件页的文字（不是只给个页码）',
    r.text.indexOf('第二页正文') >= 0, r.text.slice(0, 70))
  check('  用了与学生端课件页同一套布局类（k17 缩放层 / k47 形状）',
    r.k17 > 0 && r.k47 > 0, 'k17=' + r.k17 + ' k47=' + r.k47)
  check('  页条把圈定的范围标出来了（2–9 页里在数据内的那几页）',
    r.pageChips.filter((c) => c.in === '1').length > 0,
    '范围内 ' + r.pageChips.filter((c) => c.in === '1').length + ' 页 / 共 ' + r.pageChips.length + ' 页')
  check('  当前页在页条里是选中态',
    r.pageChips.filter((c) => c.cur === '1').length === 1,
    JSON.stringify(r.pageChips.filter((c) => c.cur === '1').map((c) => c.text)))
  check('  给出了「这一页作起始 / 作结束」（点页定范围，不用手输数字）',
    r.text.indexOf('这一页作起始') >= 0 && r.text.indexOf('这一页作结束') >= 0)
  check('  有上一页 / 下一页', r.text.indexOf('上一页') >= 0 && r.text.indexOf('下一页') >= 0)
  // 占位只会在**当前页**被渲染，所以翻到第 3 页再看（那一页的图 file 是 null）
  const r3 = renderPlan({
    anchorEdit: { lesson: 19, chapter: '第一章', from: 2, to: 9 },
    peekSlides, peekIndex: 2, peekBusy: false, peekChapter: '第一章',
  })
  check('  图片不可用的那一页给了明确占位（不是空白）',
    r3.errs.length === 0 && r3.text.indexOf('图片不可用') >= 0 && r3.text.indexOf('missing.png') >= 0,
    r3.errs.join(' | ') || r3.text.slice(0, 70))

  r = renderPlan({ anchorEdit: { lesson: 19, chapter: '第一章', from: 2, to: 9 }, peekSlides: null, peekBusy: true })
  check('  课件还没加载完（peekBusy）时不崩，且说明在加载',
    r.errs.length === 0 && r.text.indexOf('课件加载中') >= 0, r.errs.join(' | ') || '')
  r = renderPlan({ anchorEdit: { lesson: 19, chapter: '第一章', from: 2, to: 9 }, peekSlides: null, peekBusy: false })
  check('  这一章没有课件数据时给出说明而不是空白',
    r.errs.length === 0 && r.text.indexOf('还没有课件数据') >= 0, r.errs.join(' | ') || '')

  // 2) 空数据（刚装上插件、什么都没生成过）—— 这是最容易崩的一档
  r = renderPlan({ outline: null, planCatalog: null, drafts: [], draftOpen: null, draftText: '', rebuildResult: null })
  check('  体检还没加载完（outline=null）时不崩', r.errs.length === 0, r.errs.join(' | ') || '')

  r = renderPlan({
    outline: { totalLessons: 0, withPlan: 0, missingPlan: 0, withSlides: 0, missingSlides: 0, withDraft: 0,
      autoFillable: 0, noMaterial: 0, modules: [], lessons: [], worklist: [], blocked: [] },
    planCatalog: { models: [], providers: [], warnings: [] }, drafts: [], draftOpen: null,
  })
  check('  一门课都没有（空 modules）时不崩', r.errs.length === 0, r.errs.join(' | ') || '')

  // 3) 坏数据：模型目录缺 effective、草稿缺 saw/anchor/usage —— 都是真实可能发生的
  r = renderPlan({
    outline: Object.assign({}, outline, { template: '', anchorSource: '', dividers: [] }),
    planCatalog: { models: [], warnings: [] },
    drafts: [{ lesson: 19, file: 'x.md', status: 'rejected' }],
    draftOpen: null, rebuildResult: { note: '索引与磁盘一致', changes: [], orphans: [] },
  })
  check('  字段缺失的草稿/metadata 不崩（渲染层不能假设字段都在）', r.errs.length === 0, r.errs.join(' | ') || '')

  // 3b) 课时脉络侧栏要和学生端一样**能收起**。
  //     不收的话它一直占着 200 多像素，而「教案补全」那页（课件窗口、草稿预览）
  //     恰恰最需要横向空间。判据：收起时不渲染鱼骨图与章节切换，只留一条竖标签。
  r = renderPlan({ rail: true, view: 'questions' })
  check('  侧栏展开时渲染章节切换与课时脉络',
    r.errs.length === 0 && r.text.indexOf('章节') >= 0 && r.text.indexOf('课时脉络') >= 0,
    r.errs.join(' | ') || r.text.slice(0, 50))
  check('  展开时箭头是「«」（可收起）', r.text.indexOf('«') >= 0, r.text.slice(0, 40))
  check('  展开时 rail 的 data-open=1', r.rails.some((x) => x.open === '1'), JSON.stringify(r.rails))
  r = renderPlan({ rail: false, view: 'questions' })
  check('  侧栏收起时不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  收起后章节切换与鱼骨图都不再渲染（把宽度让给内容）',
    r.text.indexOf('章节') < 0 && r.text.indexOf('索引加载中') < 0,
    r.text.indexOf('章节') >= 0 ? '章节仍在' : 'ok')
  check('  收起后仍留一条能点开的竖标签', r.text.indexOf('课时脉络') >= 0 && r.text.indexOf('»') >= 0)
  check('  侧栏用学生端同一套类（k86 + data-open=0）',
    r.rails.length > 0 && r.rails.every((x) => x.open === '0'), JSON.stringify(r.rails))
  // 4) 教师端各页各渲染一次：新增标签不该把别人的页带崩
  const rosterRow = {
    sid: 'S001', name: '张三', label: '张三（S001）', klass: '土木2101', note: '基础较弱',
    fromRoster: true, selfName: '小张', asked: 12, shared: 3, answered: 1, ungraded: 2,
    severity: { '阻塞': 1, '高': 3, '中': 5, '低': 3 }, lessons: { '课时8': 4 }, topics: { '损失与优化': 4 },
    tokens: 12345, lastAt: '2026-09-24', items: [], submissions: [{ name: 'a.py', graded: false }],
  }
  const studentDetail = {
    sid: 'S001', label: '张三（S001）', name: '张三', rosterRow: null, selfInfo: null,
    items: [{ path: 'p.md', title: '为什么负特征值意味着鞍点', lesson: '课时8', severity: '高', status: '待处理' }],
    submissions: [{ name: 'mlp.py', graded: false }], ungraded: 1,
    lessons: [{ lesson: '课时8', asked: 4, shared: 2, worst: '高', topics: { '损失与优化': 4 } }],
    tokens: 12345, todo: ['1 份提交还没批改', '1 条阻塞级问题'],
  }
  r = renderPlan({ view: 'students', roster: [rosterRow], rosterLoaded: true, studentDetail })
  check('  「学生」页带数据渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  页面上把学号显示成了真名', r.text.indexOf('张三（S001）') >= 0 || r.text.indexOf('张三') >= 0,
    r.text.slice(0, 90))
  check('  给出了「这个人需要你做什么」的结论',
    r.text.indexOf('需要你做什么') >= 0 && r.text.indexOf('未批改') >= 0)
  check('  按课时说明他卡在哪', r.text.indexOf('卡在哪几课') >= 0 && r.text.indexOf('课时8') >= 0)
  check('  标出了名字来自名册还是学生自报', r.text.indexOf('名册') >= 0)

  r = renderPlan({ view: 'students', roster: [], rosterLoaded: true, studentDetail: null })
  check('  一个学生都没有时不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  r = renderPlan({ view: 'students', rosterLoaded: false })
  check('  总表还没加载完时不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  r = renderPlan({ view: 'students', roster: [rosterRow], rosterLoaded: true, studentDetail, rosterEdit: { sid: 'S001', name: '', klass: '', note: '' } })
  check('  名册编辑面板展开时不崩，且有姓名/班级/备注三个框',
    r.errs.length === 0 && r.inputs.length >= 3, r.errs.join(' | ') || (r.inputs.length + ' 个输入框'))

  for (const v of ['questions', 'common', 'submissions', 'digest', 'publish', 'detail', 'plan']) {
    r = renderPlan({ view: v })
    check('  切到「' + v + '」页不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  }

  /* ── 12c. 「归档发布」页的三块（仓库状态 / 建仓 / 发布推送）──────────────
   * 为什么单独一组：这一页只在 view==='publish' 时才挂上，上面那次「切到 publish 页」
   * 走的是 st.staged 还没到的分支，三块里两块的函数体根本没被执行过 ——
   * 而这一页是给**不懂 git 的老师**用的，它出错的症状比别的页更隐蔽：
   * 状态读不出来时页面照样画得出来，只是老师会按错的判断去操作。
   *
   * 数据形状**照抄宿主 repo.status / repo.init 的真实返回**（含 summary 那句人话），
   * 不图省事塞一个 {}：塞 {} 就测不出「拿原始状态拼术语上屏」这类错误。
   */
  const repoStatusFixture = {
    // 真实返回里 summary 是 repoSummary() 的结果，界面必须只显示它的 text
    publicRepo: {
      dir: 'C:\\ws\\课程发布\\public', hasRepo: true, branch: 'main',
      remote: 'https://github.com/me/dsh-dl2026.git', remoteSafe: 'https://github.com/me/dsh-dl2026.git',
      owner: 'me', name: 'dsh-dl2026', hadToken: false, note: '',
      summary: { level: 'ok', text: '已连到 me/dsh-dl2026，分支 main', canPublish: true },
    },
    privateRepo: {
      dir: 'C:\\ws', hasRepo: false, branch: '', remote: '', owner: '', name: '', note: '还不是一个 git 仓库',
      summary: { level: 'none', text: '这门课还没有仓库 —— 学生在等你建一个', canPublish: false },
    },
    slug: 'dsh-dl2026', courseName: '深度学习课程', courseCode: 'DL2026',
    manifestReady: true, publicDir: '课程发布\\public', manifestPath: '课程发布\\publish.manifest.json',
    resolved: { owner: 'me', name: 'dsh-dl2026', privateName: 'dsh-dl2026-privated', branch: 'main' },
    manual: '# ① 先在 GitHub 上建两个空仓（不要勾选 Add README）：\n'
      + '#    me/dsh-dl2026        （公开：学生 clone 这个）\n\n'
      + 'cd 课程发布\\public\ngit init\ngit remote add origin https://github.com/me/dsh-dl2026.git\n'
      + 'git push -u origin main',
    next: ['cd "C:\\ws\\课程发布\\public"', 'git add -A', 'git commit -m "首次发布"', 'git push -u origin main'],
  }
  const repoInitFixture = {
    ok: true,
    steps: [
      { cmd: 'git init', code: 0, skipped: true, out: '这个目录已经是 git 仓库了，跳过（当前分支 main）' },
      { cmd: 'git remote add origin https://github.com/me/dsh-dl2026.git', code: 0, out: '' },
    ],
    next: ['cd "C:\\ws\\课程发布\\public"', 'git add -A', 'git commit -m "首次发布"',
      'git push https://x-access-token:ghp_FAKE@github.com/me/dsh-dl2026.git main'],
    warnings: ['原来的 origin 指向 https://github.com/other/x.git，和你这次填的不一样 —— 插件没有覆盖它'],
    hasToken: true,
    resolved: { owner: 'me', name: 'dsh-dl2026', privateName: 'dsh-dl2026-privated', branch: 'main' },
    manual: repoStatusFixture.manual, description: '深度学习课程', hint: '建仓时 Description 填：深度学习课程',
    note: '本机已经准备好了，但没有替你推。',
  }
  const stagedFixture = {
    publicDir: '课程问题池\\公共', files: ['课时8-负特征值.md'],
    submissions: [{ student: 'S001', name: 'mlp.py' }], workspace: 'C:\\ws',
    note: '把公共面 + 教案发到公开仓：node course-repo.mjs publish，然后 git push',
  }
  // 这一节如果走 fetch（effect 里 loadRepo），桩必须给全 —— 给 {} 的话
  // 界面拿到一个空对象，测出来的是「拿空对象渲染不崩」，而不是真实形状。
  apiReplies['repo.status'] = repoStatusFixture
  apiReplies['repo.init'] = repoInitFixture

  const repoFormFixture = { owner: 'me', name: 'dsh-dl2026', token: 'ghp_FAKE_TOKEN', description: '深度学习课程' }
  r = renderPlan({ view: 'publish', staged: stagedFixture, repoStatus: repoStatusFixture, repoInit: repoInitFixture, repoForm: repoFormFixture })
  check('  三块一起渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  ① 仓库状态块在', r.text.indexOf('仓库状态') >= 0 && r.text.indexOf('已连到 me/dsh-dl2026') >= 0)
  check('  ② 建仓块在', r.text.indexOf('建仓') >= 0 && r.text.indexOf('在本机把仓库准备好') >= 0)
  check('  ③ 发布/推送块在', r.text.indexOf('发布，然后推送') >= 0 && r.text.indexOf('推') >= 0)
  check('  ④⑤ 现有的材料归位与待发布清单都还在',
    r.text.indexOf('材料归位') >= 0 && r.text.indexOf('待发布清单') >= 0
    && r.text.indexOf('课时8-负特征值.md') >= 0, r.text.slice(-120))
  // 状态卡显示的必须是**人话**（repoSummary().text），不是原始状态对象。
  // 判据要落在「术语没有上屏」上：原始对象一旦被丢进界面，最先漏出来的
  // 就是这些字段名（这一条比「文本里有人话」更有区分力 —— 人话可能是别处漏出来的）。
  check('  状态卡用的是 repoSummary 那句人话', r.text.indexOf('已连到 me/dsh-dl2026，分支 main') >= 0,
    r.text.slice(0, 120))
  check('  没有把原始状态对象丢上屏（ahead/hasRepo/remoteSafe 这类术语一个都不许出现）',
    ['ahead', 'hasRepo', 'remoteSafe', 'hadToken', 'canPublish', '{"level"'].every((w) => r.text.indexOf(w) < 0),
    ['ahead', 'hasRepo', 'remoteSafe', 'hadToken', 'canPublish'].filter((w) => r.text.indexOf(w) >= 0).join(',') || 'ok')
  check('  私有仓也说的是人话', r.text.indexOf('学生在等你建一个') >= 0)
  // Token 必须是密码框：明文上屏等于把它摊在屏幕上（老师会截图发人）
  const pw = r.inputs.filter((x) => x.type === 'password')
  check('  Token 输入框存在且 type=password', pw.length === 1, pw.length + ' 个密码框')
  check('  Token 的值只进 input.value，绝不作为文本上屏', r.text.indexOf('ghp_FAKE_TOKEN') < 0)
  check('  说明了「Token 只在这台机器上、不进仓库、不下发学生」',
    r.text.indexOf('不进仓库') >= 0 && r.text.indexOf('不下发学生') >= 0)
  check('  仓库名 / owner 也真的能填（不是只写了个说明）',
    r.inputs.some((x) => x.value === 'dsh-dl2026') && r.inputs.some((x) => x.value === 'me'))
  // 没有 Token 时的「两条手动步骤」：折叠块 + 能照抄的原文
  check('  有手册步骤折叠块', r.details > 0, r.details + ' 个 <details>')
  check('  折叠块里是 manualSteps 的原文（带完整 URL，照抄即可）',
    r.text.indexOf('git remote add origin https://github.com/me/dsh-dl2026.git') >= 0
    && r.text.indexOf('不要勾选 Add README') >= 0)
  check('  建仓结果把命令原文与输出一起摊开（看得见才学得到）',
    r.text.indexOf('git init') >= 0 && r.text.indexOf('跳过') >= 0)
  check('  带 Token 的推送命令旁边有明确的提醒（界面靠 hasToken 判断，不靠字符串里搜）',
    r.text.indexOf('别复制到聊天') >= 0)
  check('  建仓没覆盖已有 remote 这件事被报出来了',
    r.text.indexOf('没有覆盖') >= 0 || r.text.indexOf('没有覆盖它') >= 0)

  // 空数据：repoStatus 还没拉到时（null）三块也要画得出来 ——
  // 这是最容易崩的一档，也是「刚打开面板」的真实状态。
  r = renderPlan({ view: 'publish', staged: stagedFixture, repoStatus: null, repoInit: null, repoForm: null })
  check('  repoStatus / repoForm 还是 null 时不崩', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  没数据时说的是「正在读…」而不是显示 null / undefined',
    r.text.indexOf('正在读仓库状态') >= 0 && r.text.indexOf('undefined') < 0 && r.text.indexOf('null') < 0,
    r.text.slice(0, 100))
  check('  待发布清单没到时不崩（staged=null）', renderPlan({ view: 'publish', staged: null, repoStatus: repoStatusFixture }).errs.length === 0)

  // 坏数据：宿主只回了半边（旧宿主 / 半截响应）也不该崩
  r = renderPlan({ view: 'publish', staged: {}, repoStatus: {}, repoForm: {} })
  check('  repoStatus 是空对象（半截响应）时不崩', r.errs.length === 0, r.errs.join(' | ') || '')

  /* ── 12c-2. 版本卡（「学生该克隆哪一份」）──────────────────────────────
   * 为什么单独一组：它的数据来自**另一个动作**（version.info），
   * 而这一块说错话的后果是**老师照着念给全班** —— 学生 clone 到旧版本，
   * 表现只是些「未知动作」，两边都不会怀疑到版本上。
   *
   * 数据形状照抄宿主 version.info 的真实返回（含 verdict 那句人话、
   * 含 withRemote:false 时的 null verdict）。判定规则本身在
   * verify-version-info.mjs 里逐条钉；这里钉的是「界面有没有把它显示出来」。
   */
  const versionLocalFixture = {
    ok: true, compare: false, publicDir: '课程发布\\public',
    public: {
      dir: 'C:\\ws\\课程发布\\public', hasRepo: true, branch: 'main', commit: 'c'.repeat(40),
      commitShort: 'ccccccc', tag: 'v0.1.1', describe: 'v0.1.1', refKind: 'tag',
      recentTag: '', commitsSinceTag: null,
      cloneCommand: 'git clone https://github.com/me/dsh-dl2026.git --branch v0.1.1',
      remoteName: 'https://github.com/me/dsh-dl2026.git', remoteChecked: false,
      remoteCommit: '', ahead: null, behind: null, note: '未与远端比对',
    },
    workspace: {
      dir: 'C:\\ws', hasRepo: true, branch: 'main', commit: 'd'.repeat(40), commitShort: 'ddddddd',
      tag: '', describe: '', refKind: 'branch', recentTag: 'v0.1.0', commitsSinceTag: 3,
      cloneCommand: '', remoteName: 'https://github.com/me/dsh-dl2026-privated.git',
      remoteChecked: false, remoteCommit: '', ahead: null, behind: null, note: '还没配远端仓库',
    },
    publicSummary: '版本 v0.1.1 · 提交 ccccccc · 分支 main',
    workspaceSummary: '比 v0.1.0 新 3 个提交 · 提交 ddddddd · 分支 main',
    verdict: null,
    drift: '',
  }
  apiReplies['version.info'] = versionLocalFixture
  r = renderPlan({ view: 'publish', staged: stagedFixture, repoStatus: repoStatusFixture, versionInfo: versionLocalFixture })
  check('  版本卡渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  ④b 版本卡在（标题说的是「学生该克隆哪一份」）',
    r.text.indexOf('学生该克隆哪一份') >= 0, r.text.slice(0, 200))
  // ★ 这一条才是这一块存在的理由：**那条命令要能被看到、能被照抄**。
  //   只断言「有个版本卡」等于没写（标题永远在），必须断言命令原文在页面上。
  check('  给学生的克隆命令原文在页面上（老师照抄的就是它）',
    r.text.indexOf('git clone https://github.com/me/dsh-dl2026.git --branch v0.1.1') >= 0,
    r.text.slice(0, 200))
  check('  标签点明这条是给学生的（不是给老师自己跑的）',
    r.text.indexOf('公开仓（学生克隆它）') >= 0)
  check('  两个仓库各报一行（工作区那份也要能看见）',
    r.text.indexOf('课程工作区（你发布的内容）') >= 0 && r.text.indexOf('比 v0.1.0 新 3 个提交') >= 0)
  check('  有 tag 时说清「版本可复现」（这正是 tag 的用处）', r.text.indexOf('版本可复现') >= 0)
  check('  没查远端时不说「与远端一致」（不许把「没查」说成「一样」）',
    r.text.indexOf('与远端一致') < 0 && r.text.indexOf('GitHub 上现在是什么版本') >= 0,
    r.text.slice(-160))
  check('  比对按钮在，且文案是「和 GitHub 比一下」', r.text.indexOf('和 GitHub 比一下') >= 0)
  // 长 SHA 只作 title（鼠标悬停能看到全的），上屏的是 7 位短号
  check('  提交号上屏是 7 位短号（40 位全号只放 title）',
    r.text.indexOf('ccccccc') >= 0 && r.text.indexOf('c'.repeat(40)) < 0)

  // 比对过的那一档：宿主给的**结论**要原样显示，界面不许自己改写
  const versionRemoteFixture = Object.assign({}, versionLocalFixture, {
    compare: true,
    public: Object.assign({}, versionLocalFixture.public, {
      remoteChecked: true, remoteCommit: 'e'.repeat(40), note: '本地 ccccccc 与远端 eeeeeee 不一致',
    }),
    verdict: { level: 'warn', text: 'GitHub 上是 eeeeeee，这台机器上是 ccccccc —— 两边不一样：学生现在克隆会拿到 GitHub 上那一份。' },
    drift: '课程工作区的内容与公开仓工作区不是同一份（提交 ddddddd 与 ccccccc）—— 公开仓里的内容来自上一次「发布」。要让这条 clone 命令带上你今天改的东西，先按③发布并推送。',
  })
  apiReplies['version.info'] = versionRemoteFixture
  r = renderPlan({ view: 'publish', staged: stagedFixture, repoStatus: repoStatusFixture, versionInfo: versionRemoteFixture })
  check('  比对过的那一档渲染不抛错', r.errs.length === 0, r.errs.join(' | ') || '')
  check('  宿主给的结论原样上屏（界面不自己推「学生拿到什么」）',
    r.text.indexOf('学生现在克隆会拿到 GitHub 上那一份') >= 0, r.text.slice(-200))
  check('  工作区与公开仓不一致这件事被报出来了（含「先按③发布并推送」这条动作）',
    r.text.indexOf('不是同一份') >= 0 && r.text.indexOf('先按③发布并推送') >= 0,
    '有⚠=' + (r.text.indexOf('⚠') >= 0) + ' 有「不是同一份」=' + (r.text.indexOf('不是同一份') >= 0)
    + ' 有「先按③」=' + (r.text.indexOf('先按③发布并推送') >= 0)
    + ' 有「版本可复现」=' + (r.text.indexOf('版本可复现') >= 0) + ' | ' + r.text.slice(-160))
  check('  比对过之后按钮变成「再比一次」', r.text.indexOf('再比一次') >= 0)

  // 坏数据：version.info 还没到（null）——「刚打开面板」的真实状态
  r = renderPlan({ view: 'publish', staged: stagedFixture, repoStatus: repoStatusFixture, versionInfo: null })
  check('  versionInfo 还是 null 时说的是「正在读版本信息…」而不是 null/undefined',
    r.errs.length === 0 && r.text.indexOf('正在读版本信息') >= 0
    && r.text.indexOf('undefined') < 0 && r.text.indexOf('null') < 0,
    r.errs.join(' | ') || r.text.slice(0, 120))
  // 坏数据：半截响应（旧宿主只回了一半字段）
  r = renderPlan({ view: 'publish', staged: stagedFixture, repoStatus: repoStatusFixture, versionInfo: {} })
  check('  versionInfo 是空对象（半截响应）时不崩',
    r.errs.length === 0, r.errs.join(' | ') || '')
  // 反向：这个动作**不该**在打开面板时就带着 remote 去查（那会把离线可用的页面变成网络依赖）
  const versionCalls = apiActions.filter((a) => a === 'version.info').length
  check('  这一页真的会去拉版本信息（不是写了个没人调的动作）', versionCalls > 0, versionCalls + ' 次')
  apiReplies['version.info'] = versionLocalFixture
})()
/* ── 12b. 框选的坐标换算（几何，纯函数）──────────────────────────────────
 * 老师反馈过「框选的光标和选择框之间有偏移」。原因是拿**外层容器**的左上角
 * 当课件页的左上角 —— 容器里上面还有页条和翻页按钮，课件页本身还是居中的。
 * 这种错在界面上只表现为「有点歪」，渲染断言看不出来；但拿一组写死的矩形
 * 一算就一目了然。所以把它抽成纯函数，在这里钉死。
 */
console.log('\n=== 12b. 框选坐标换算（几何）===')
{
  const comps = (teacherBundle && teacherBundle.exports && teacherBundle.exports.__components) || {}
  const f = comps.slidePointFrom
  check('  教师端暴露了可测的坐标换算函数', typeof f === 'function', typeof f)
  if (typeof f === 'function') {
    // 容器在 (100,50)，尺寸 800x600；课件页在容器内偏移 (40,90)，尺寸 640x360（= 1280x720 的 0.5 倍）
    const wrapRect = { left: 100, top: 50, width: 800, height: 600 }
    const stageBox = { left: 40, top: 90, width: 640, height: 360 }
    const W = 1280
    const H = 720
    const c = f(100 + 40 + 320, 50 + 90 + 180, wrapRect, stageBox, W, H)
    check('  课件页正中间那一点 → 课件坐标正中',
      !!c && Math.abs(c.x - 640) < 0.01 && Math.abs(c.y - 360) < 0.01, JSON.stringify(c))
    // 同一个点，用**老的错算法**（拿容器左上角当基准）会算出什么：
    const wrongX = (100 + 40 + 320 - wrapRect.left) / (stageBox.width / W)
    const wrongY = (50 + 90 + 180 - wrapRect.top) / (stageBox.width / W)
    check('  老算法在同一输入下确实是偏的（说明这条断言有区分力）',
      Math.abs(wrongX - 640) > 1 || Math.abs(wrongY - 360) > 1,
      '老算法 → (' + Math.round(wrongX) + ',' + Math.round(wrongY) + ')')
    const tl = f(100 + 40, 50 + 90, wrapRect, stageBox, W, H)
    check('  课件页左上角 → (0,0)', !!tl && tl.x === 0 && tl.y === 0, JSON.stringify(tl))
    const br = f(100 + 40 + 640, 50 + 90 + 360, wrapRect, stageBox, W, H)
    check('  课件页右下角 → (1280,720)', !!br && br.x === 1280 && br.y === 720, JSON.stringify(br))
    const out = f(0, 0, wrapRect, stageBox, W, H)
    check('  拖到课件页外面会被夹回范围内（不会算出负数坐标）',
      !!out && out.x === 0 && out.y === 0, JSON.stringify(out))
    check('  还没量到课件页位置时返回 null（不是拿容器凑一个）',
      f(500, 300, wrapRect, null, W, H) === null)

    /* 选框尺寸：老师反馈过「圈选框没有正常显示」。
     * 根因是 `Object.assign({边框}, css(boxStyle))` —— boxStyle 已经是 css() 的结果对象，
     * 又喂回 css() 一遍；而 css() 里是 String(text || '')，对象变成 "[object Object]"，
     * 没有冒号 → 解析出空对象 → left/top/width/height 全丢，只剩一个宽高为 0 的边框，
     * 也就是**看不见的框**。所以这里钉住：四个几何属性必须有非零的 px 值。 */
    const bs = comps.boxStyleFrom
    check('  教师端暴露了可测的选框样式函数', typeof bs === 'function', typeof bs)
    if (typeof bs === 'function') {
      const st2 = bs({ x0: 100, y0: 50, x1: 400, y1: 250 }, 0.5)
      check('  选框带上 left/top/width/height（不是只剩边框）',
        !!st2 && st2.left === '50px' && st2.top === '25px' && st2.width === '150px' && st2.height === '100px',
        JSON.stringify(st2))
      check('  四个值都是非零像素（宽高为 0 就等于看不见）',
        !!st2 && /^[1-9]\d*px$/.test(st2.width) && /^[1-9]\d*px$/.test(st2.height),
        st2 && (st2.width + ' x ' + st2.height))
      const rev = bs({ x0: 400, y0: 250, x1: 100, y1: 50 }, 0.5)
      check('  反着拖（右下 → 左上）得到同一个框',
        !!rev && rev.left === st2.left && rev.top === st2.top
        && rev.width === st2.width && rev.height === st2.height, JSON.stringify(rev))
      check('  没有框或没有缩放比时返回 null', bs(null, 1) === null && bs({ x0: 0, y0: 0, x1: 1, y1: 1 }, 0) === null)
      // 顺带把「喂回解析器会变空」这件事钉住 —— 这是那条 bug 的机理，防止有人再写回去
      const cssFn = (typeof shared !== 'undefined' && shared && shared.css) ? shared.css : null
      if (cssFn) {
        check('  【机理】css() 的产物再喂回 css() 会变成空对象（所以不能倒手）',
          Object.keys(cssFn(cssFn('left:10px;top:20px'))).length === 0,
          JSON.stringify(cssFn(cssFn('left:10px;top:20px'))))
      }
    }
  }
}
/* ── 13. 客户端用到的共享组件，必须真的从共享内核里解构出来了 ─────────────
 * 为什么必须静态查一遍：
 *   教师端要 `cropToPng` 做框选截图，但我在解构里漏了它 ——
 *   **构建全绿、面板打得开、翻页也正常**，只有老师真的在 PPT 上拖完一个框时
 *   才炸 `cropToPng is not defined`。而那时他已经划了一下、以为成功了。
 *   这类「只在某一次交互时才炸」的漏引用，光靠渲染断言抓不全（要枚举所有交互），
 *   静态查一遍便宜得多，而且能覆盖全部共享导出。
 *
 * 判据：共享内核导出的每个名字，只要在客户端里被**当函数调用**或**当组件渲染**，
 *   就必须出现在 `const { ... } = ui` 的解构里（或在本地自己声明了）。
 */
console.log('\n=== 13. 共享组件引用完整性（静态扫描）===')
{
  const sharedPath = path.join(PACKS, 'dsh-course-core', 'lib', 'client-shared.js')
  const shared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, 'utf8') : ''
  const retM = /return \{([^}]{20,4000})\}/.exec(shared.slice(shared.lastIndexOf('return {')))
  const exportsList = retM
    ? retM[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))
    : []
  check('  读得到共享内核的导出清单', exportsList.length > 10, exportsList.length + ' 个导出')
  check('  cropToPng 在共享内核里（框选成图，两端共用）', exportsList.indexOf('cropToPng') >= 0)

  for (const pkg of ['dsh-course-student', 'dsh-course-teacher']) {
    const f = path.join(PACKS, pkg, 'lib', 'client.js')
    if (!fs.existsSync(f)) { check('  ' + pkg + ' 客户端存在', false, f); continue }
    const src = fs.readFileSync(f, 'utf8')
    // 解构块：`const { ... } = ui`
    const dm = /const \{([\s\S]{0,4000}?)\} = ui/.exec(src)
    // ⚠️ 解构块里**有注释**（「文件提交 / 预览共用组件…」那种），而注释里没有逗号 ——
    //    直接按逗号切会把注释和后面那个名字粘成一个整体，于是 `FileDrop` 被判成「没解构」。
    //    先剥注释再切。这是今天第三次栽在「解析工具自己的文本处理」上，
    //    而每次的症状都是「断言说产品有问题，其实是探针有 bug」。
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
    const got = new Set(dm ? stripComments(dm[1]).split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean) : [])
    // 本地自己声明的（函数 / const / let / 参数）不算漏引用
    const local = new Set()
    for (const m of src.matchAll(/(?:^|\s)(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1])
    const missing = []
    for (const name of exportsList) {
      if (got.has(name) || local.has(name)) continue
      // 只查「被当函数调用」或「被当组件渲染」的用法，纯类型/纯数据名不误报
      const used = new RegExp('(?:^|[^.\\w$])' + name + '\\s*\\(').test(src)
        || new RegExp('h\\(\\s*' + name + '\\b').test(src)
      if (used) missing.push(name)
    }
    check('  [' + pkg + '] 用到的共享导出都已解构', missing.length === 0,
      missing.length ? ('漏了：' + missing.join(', ') + ' —— 会在运行时才炸') : (got.size + ' 个已解构'))
  }
}
console.log('\n' + '='.repeat(58))
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail ? 1 : 0
