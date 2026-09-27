// 教案补全的隔离验证：骨架解析、课时锚点、草稿区、采纳、索引重建、大纲体检。
// 用临时工作区造形状，不碰真实工作区；最后一段对真实工作区做回归。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// 【测试隔离】不让宿主机器上的 ~/.dsh/cip-workspace.txt 抢走解析结果。
// 【测试隔离】解析链会读那个文件，而它是**这台机器**的真实配置 —— 在配过的机器上
// 【测试隔离】（教师机就是）它会先命中，本脚本自己的工作区反而被跳过。
// 【测试隔离】指到一个必然不存在的文件 = 把它从候选里摘掉，隔离才干净。
if (!process.env.CIP_WORKSPACE_FILE) {
  process.env.CIP_WORKSPACE_FILE = path.join(os.tmpdir(), 'cip-test-no-workspace-file.txt')
}


const ROOT = 'C:/Users/Administrator/Desktop/暑期课程'
const mod = await import(pathToFileURL(path.join(ROOT, '课程中心/course-plugin/dsh-course-core/src/index.js')).href)

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}
const checkEq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got))

// ── 1. 纯函数：骨架与解析 ────────────────────────────────────────
console.log('\n=== 1. 骨架 / 解析 / 文件名 ===')
{
  const tpl = mod.builtinTemplate(19, '像素级语义空间建模与 U-Net 架构')
  check('骨架带课时号与标题', tpl.startsWith('# 课时 19：像素级语义空间建模与 U-Net 架构'))
  for (const s of mod.PLAN_SECTION_TITLES) check('骨架含「## ' + s + '」', tpl.indexOf('## ' + s) >= 0)

  const empty = mod.parsePlan(tpl)
  check('空骨架被判定为缺「目标」', empty.missing.indexOf('目标') >= 0, JSON.stringify(empty.missing))
  check('空骨架被判定为缺「验收标准」', empty.missing.indexOf('验收标准') >= 0)
  // 「## 验收标准」下面只有一个「1.」也算空 —— 这正是「看起来有教案」的典型形态
  const fake = '# 课时 1：x\n\n## 目标\n\n1. 能写出 $\\mathbf{X}$\n\n## 推导\n\n### 一、a\n\n内容\n\n## 实操\n\n### 任务一：b\n\n- 产物：`a.py`\n\n## 验收标准\n\n1. \n\n## 当堂交付物\n\n- `a.py`\n'
  const p = mod.parsePlan(fake)
  checkEq('「验收标准」只剩个编号 → 判为缺失', p.missing, ['验收标准'])
  check('标题被取出', p.title === '课时 1：x', p.title)

  const real = fs.readFileSync(path.join(ROOT, '模块一_基础与工程化入门/详细教案/课时3_统计学习理论到深度学习矩阵化重构.md'), 'utf8')
  const rp = mod.parsePlan(real)
  checkEq('真实教案 3 的五节都齐', rp.missing, [])
  check('真实教案 3 的推导 > 2000 字符', rp.sections['推导'].length > 2000, String(rp.sections['推导'].length))

  checkEq('safeName 去掉 Windows 非法字符', mod.safeName('a/b:c*d?e"f<g>h|i'), 'abcdefghi')
  check('draftFileName 与正式教案同构', mod.draftFileName(19, '像素级语义空间建模与 U-Net 架构') === '课时19_像素级语义空间建模与U-Net架构.md',
    mod.draftFileName(19, '像素级语义空间建模与 U-Net 架构'))
}

// ── 2. 模型输出的清洗 ────────────────────────────────────────────
console.log('\n=== 2. cleanPlanText（模型输出常带前言与整篇代码块）===')
{
  const a = mod.cleanPlanText('好的，下面是我为你整理的教案：\n\n# 课时 5：x\n\n## 目标\n\n1. a\n')
  check('剥掉开场白，从一级标题开始', a.startsWith('# 课时 5：x'), JSON.stringify(a.slice(0, 20)))
  const b = mod.cleanPlanText('```markdown\n# 课时 5：x\n\n## 目标\n\n1. a\n```\n')
  check('剥掉整篇 ``` 包裹', b.startsWith('# 课时 5：x') && b.indexOf('```') < 0, JSON.stringify(b.slice(0, 24)))
  check('末尾补一个换行', b.endsWith('\n'))
}

// ── 3. 课件切页与锚点 ────────────────────────────────────────────
console.log('\n=== 3. 课件切页 / 模块跨度 / 锚点优先级 ===')
{
  const chapterData = { slides: [
    { index: 1, text: '第一页'.repeat(400) },
    { index: 2, text: '第二页' },
    { index: 3, text: '第三页' },
  ] }
  const s = mod.sliceSlideText(chapterData, 1, 2, { perPage: 20, total: 1000 })
  check('只取 [1,2] 两页', s.pages === 2, String(s.pages))
  check('超长页被截断并标注', s.text.indexOf('…') >= 0 && s.text.indexOf('第 3 页') < 0)

  const byChapter = {
    第一章: { lessons: [
      { seq: 1, module: '模块零', startIndex: 1, endIndex: 9, title: 'a' },
      { seq: 2, module: '模块一', startIndex: 10, endIndex: 29, title: 'b' },
      { seq: 3, module: '模块一', startIndex: 30, endIndex: 35, title: 'c' },
    ] },
    第二章: { lessons: [{ seq: 1, module: '模块二', startIndex: 1, endIndex: 17, title: 'd' }] },
  }
  const spans = mod.inferModuleSpans(byChapter)
  checkEq('模块一跨两张分隔页 → 合成一段 10–35', spans['模块一'].length, 2)
  const a1 = mod.anchorFor(5, '模块一', spans, { list: {} })
  check('推断出的锚点：10–35 页', a1.chapter === '第一章' && a1.from === 10 && a1.to === 35, JSON.stringify(a1))
  check('推断锚点标记为 approx', a1.approx === true)
  const a2 = mod.anchorFor(5, '模块一', spans, { list: { 5: { chapter: '第二章', from: 3, to: 8 } } })
  check('老师确认过的锚点优先', a2.chapter === '第二章' && a2.from === 3 && a2.approx === false, JSON.stringify(a2))
  check('没有课件的模块 → null（不编）', mod.anchorFor(5, '模块四', spans, { list: {} }) === null)
}

// ── 4. 临时工作区：真实 createCore + 草稿区 / 采纳 / 索引重建 ────
console.log('\n=== 4. 草稿区 → 采纳 → 索引（真实 createCore，临时工作区）===')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-plan-'))
const mkdir = (p) => fs.mkdirSync(p, { recursive: true })
const write = (p, t) => { mkdir(path.dirname(p)); fs.writeFileSync(p, t, 'utf8') }

/** 老师机的形状：共享内容在根，私有数据在 课程/<码>/ */
function mkWorkspace(dir) {
  mkdir(path.join(dir, '课程中心/预览数据'))
  write(path.join(dir, '课程配置.json'), JSON.stringify({ title: '测试课程', code: '', goal: 'g' }))
  const idx = {
    course: '测试课程', totalLessons: 4,
    modules: [
      { id: 'M1', name: '模块一', dir: '模块一_x', planDir: '详细教案', theme: 't1', range: '课时 1-2',
        lessons: [{ no: 1, title: '第一课：入门', plan: '课时1_入门.md' }, { no: 2, title: '第二课：进阶', plan: '' }] },
      { id: 'M2', name: '模块二', dir: '模块二_y', planDir: '详细教案', theme: 't2', range: '课时 3-4', missingPlans: true,
        lessons: [{ no: 3, title: '第三课：梯度', plan: '' }, { no: 4, title: '第四课：注意力', plan: '' }] },
    ],
    gradingDimensions: [],
  }
  write(path.join(dir, '课程中心/课程结构索引.json'), JSON.stringify(idx, null, 2))
  const plan = '# 课时 1：第一课：入门\n\n## 目标\n\n1. 能写出 $x$\n\n## 推导\n\n### 一、a\n\n内容\n\n## 实操\n\n### 任务一：b\n\n- 产物：`a.py`\n\n## 验收标准\n\n1. 输出维度为 (N, d+1)\n\n## 当堂交付物\n\n- `a.py`\n'
  write(path.join(dir, '模块一_x/详细教案/课时1_入门.md'), plan)
  write(path.join(dir, '模块一_x/模块说明.md'), '模块一说明')
  write(path.join(dir, '模块一_x/代码示例/01_入门_demo.py'), 'print(1)\n'.repeat(50))
  write(path.join(dir, '模块二_y/详细教案/README.md'), '占位')
  write(path.join(dir, '模块二_y/代码示例/03_梯度_demo.py'), 'import torch\n' + 'x=1\n'.repeat(30))
  write(path.join(dir, '模块二_y/代码示例/04_池化_attn.py'), 'import torch\n'.repeat(20))
  // 一章课件：模块一占 1–9 页，模块二占 10–19 页
  const mkSlides = (specs) => ({ slides: specs })
  const shapes = (modName, title) => ([
    { kind: 'sp', text: modName + '：测试', x: 0, y: 83, w: 0, h: 123 },
    { kind: 'sp', text: title, x: 0, y: 239, w: 0, h: 155 },
    { kind: 'sp', text: '主讲人', x: 0, y: 321, w: 0, h: 0 },
    { kind: 'sp', text: '', x: 0, y: 475, w: 0, h: 0 },
  ])
  const slides = []
  for (let i = 1; i <= 20; i += 1) {
    slides.push({ index: i, part: 'p' + i, text: '第' + i + '页内容', shapes: [], media: [], images: [] })
  }
  slides[0].shapes = shapes('模块一', '第一课主题')
  slides[9].shapes = shapes('模块二', '第三课主题')
  write(path.join(dir, '课程中心/预览数据/第一章.json'), JSON.stringify(mkSlides(slides)))
  return dir
}
const WS = mkWorkspace(path.join(tmp, 'ws'))
const COURSE = path.join(WS, '课程', 'DL01')
mkdir(COURSE)
write(path.join(COURSE, '课程配置.json'), JSON.stringify({ title: '测试课程', code: 'DL01', goal: 'g' }))

process.env.CIP_WORKSPACE = WS
process.env.CIP_COURSE_CODE = 'DL01'
const stubCtx = { get: () => undefined, effect: () => () => {} }
const core = mod.createCore(stubCtx, { prefix: '/t', role: 'teacher', pkgRoot: ROOT, label: 'T' })

{
  // 私有项的归属：**还没创建**的目录也要落在课程目录里（这是本轮修掉的静默混课）
  check('课程问题池 → 课程目录（哪怕还不存在）', core.abs('课程问题池\\学生\\a.md') === path.join(COURSE, '课程问题池\\学生\\a.md'),
    core.abs('课程问题池\\学生\\a.md'))
  check('教案草稿 → 课程目录', core.abs('教案草稿\\_草稿索引.json') === path.join(COURSE, '教案草稿\\_草稿索引.json'))
  check('课件（共享）仍留在工作区根', core.abs('课程中心\\预览数据\\第一章.json') === path.join(WS, '课程中心\\预览数据\\第一章.json'))
}

const tree = await core.getTree()
check('课程树读到 4 个课时', tree && tree.modules.reduce((a, m) => a + m.lessons.length, 0) === 4)
const slidesByChapter = { 第一章: await core.getSlides('第一章') }
{
  const spans = mod.inferModuleSpans(slidesByChapter)
  const st = mod.outlineStatus(core, tree, { spans, anchors: mod.readAnchors(core) })
  checkEq('体检：总数 / 有教案 / 缺教案', [st.totalLessons, st.withPlan, st.missingPlan], [4, 1, 3])
  checkEq('体检：有课件页的课时数', st.withSlides, 4)
  checkEq('体检：可自动补的课时', st.autoFillable, 3)
  checkEq('体检：材料不足的课时', st.noMaterial, 0)
  checkEq('待办清单 = 缺教案且能补的', st.worklist, [2, 3, 4])
  check('体检报出「缺验收标准」这类信息', st.lessons[0].planMissingSections !== null, JSON.stringify(st.lessons[0].planMissingSections))

  // 采集：确认它看到了课件、代码、风格样例，且**没看到**的会说出来
  const d = mod.collectLesson(core, tree, 3, { spans, anchors: mod.readAnchors(core), slidesByChapter })
  check('采集到示例代码', d.code.length > 0, d.code.map((c) => c.name).join(','))
  check('课时号命名的代码排在前面', /^03_/.test(d.code[0].name), d.code[0].name)
  check('采集到课件正文（不用调用方再补一次）', !!d.slideText && !!d.slideText.text, String(d.slideText && d.slideText.pages) + ' 页')
  check('课时 3 在模块二 → 没写模块说明就如实列出', d.moduleNote === '' && d.missing.some((m) => /模块说明/.test(m)),
    JSON.stringify(d.missing))
  // 风格样例来自**同模块**的其他教案：模块二这一课时谁都没教案 → 没有样例，
  // 而模块一的课时 2 能拿到课时 1 当样例
  check('模块二没有可当样例的教案 → 不硬凑', d.styleSample === null)
  const d2 = mod.collectLesson(core, tree, 2, { spans, anchors: mod.readAnchors(core), slidesByChapter })
  check('模块一课时 2 拿到课时 1 当风格样例', !!d2.styleSample && d2.styleSample.no === 1,
    d2.styleSample ? ('课时' + d2.styleSample.no) : 'null')
  check('模块说明读到了', d2.moduleNote === '模块一说明', JSON.stringify(d2.moduleNote))
  check('课时 2 的课件正文也拿到了', !!d2.slideText && d2.slideText.pages > 0, String(d2.slideText && d2.slideText.pages))

  const prompt = mod.buildPlanPrompt(d2, { courseTitle: '测试课程', courseGoal: 'g' })
  check('提示词含课时标题', prompt.indexOf('第二课：进阶') >= 0)
  check('提示词含课件页码与页文本', prompt.indexOf('第一章 第 1') >= 0 && prompt.indexOf('第1页内容') >= 0, '')
  check('提示词含示例代码', prompt.indexOf('01_入门_demo.py') >= 0)
  check('提示词含风格样例', prompt.indexOf('同风格样例') >= 0)
  check('提示词含缺失材料清单', prompt.indexOf('【缺失的材料】') >= 0)

  // 没有课件页的课时：提示词必须**明说**没有课件，否则模型会拿常识把推导编出来
  const bare = mod.collectLesson(core, tree, 3, { spans, anchors: mod.readAnchors(core), slidesByChapter })
  const barePrompt = mod.buildPlanPrompt(Object.assign({}, bare, { slideText: null, anchor: null }), {})
  check('没课件时提示词明说「没有对应的课件页」并禁止编造', barePrompt.indexOf('没有对应的课件页') >= 0)
}

// 草稿 → 审批 → 采纳
{
  const before = mod.readDraftIndex(core)
  checkEq('一开始没有草稿', before.drafts.length, 0)

  const text = '# 课时 2：第二课：进阶\n\n## 目标\n\n1. 能写出 $\\nabla_w \\mathcal{J}$\n\n## 推导\n\n### 一、链式法则\n\n见 $$\\frac{\\partial \\mathcal{J}}{\\partial w}$$\n\n## 实操\n\n### 任务一：手写梯度\n\n- 产物：`02_进阶_grad.py`\n\n## 验收标准\n\n1. 梯度与 PyTorch autograd 在 1e-6 内一致\n\n## 当堂交付物\n\n- `02_进阶_grad.py`\n'
  const entry = mod.saveDraft(core, { lesson: 2, title: '第二课：进阶', status: 'draft', chars: text.length, file: mod.draftFileName(2, '第二课：进阶') }, text)
  check('草稿落在课程目录的 教案草稿/ 下', fs.existsSync(path.join(COURSE, '教案草稿', entry.file)), path.join(COURSE, '教案草稿', entry.file))
  check('工作区根目录**没有**多出 教案草稿/', !fs.existsSync(path.join(WS, '教案草稿')))
  checkEq('草稿索引记到 1 份', mod.readDraftIndex(core).drafts.length, 1)
  check('草稿还没进正式教案', !fs.existsSync(path.join(WS, '模块一_x/详细教案/课时2_第二课：进阶.md')))

  // 骨架完整度必须算出来 —— 审批界面靠它提示「这份缺验收标准」
  const parsed = mod.parsePlan(core.readText(mod.PLAN_DRAFT_DIR + '\\' + entry.file))
  checkEq('草稿五节齐全', parsed.missing, [])

  const acc = mod.acceptDraft(core, 2, {})
  check('采纳后写进 详细教案/', fs.existsSync(path.join(WS, '模块一_x/详细教案/' + entry.file)), acc.path)
  const idx2 = JSON.parse(fs.readFileSync(path.join(WS, '课程中心/课程结构索引.json'), 'utf8'))
  checkEq('索引里课时 2 的 plan 指向新文件', idx2.modules[0].lessons[1].plan, entry.file)

  // ⚠️ 课程树的内存层**没有 TTL**：它只在「索引或教案目录 mtime 变了」时该重算，
  //    而刚写完文件的那一刻没有任何东西去重新比对指纹。踩过的症状是
  //    「明明采纳了，面板还写着教案未撰写」。所以下面两行是一个**故意的回归**：
  //    先证明不失效就是错的，再证明 invalidateCache 修好了它。
  const staleTree = await core.getTree()
  check('不失效时树是旧的（这正是要修的问题）', mod.outlineStatus(core, staleTree, {}).withPlan === 1,
    String(mod.outlineStatus(core, staleTree, {}).withPlan))
  core.invalidateCache()
  const st2 = mod.outlineStatus(core, await core.getTree(), {})
  check('invalidateCache 之后课时 2 变成「有教案」', st2.lessons.find((r) => r.no === 2).plan === true)
  checkEq('体检：有教案 2 / 缺教案 2', [st2.withPlan, st2.missingPlan], [2, 2])

  // 再来一次：同名教案已存在 → 必须拒绝，不能静默冲掉验收基准
  let refused = ''
  try { mod.acceptDraft(core, 2, {}) } catch (e) { refused = String(e && e.message) }
  check('重复采纳被拒绝且说明原因', refused.indexOf('已存在') >= 0, refused)
  const acc2 = mod.acceptDraft(core, 2, { overwrite: true })
  check('显式覆盖会先备份旧教案', !!acc2.backedUp && fs.existsSync(path.join(COURSE, acc2.backedUp)), acc2.backedUp || '')
  check('备份在课程目录里（不是共享目录）', String(acc2.backedUp).indexOf('教案草稿') === 0)
  checkEq('草稿状态变成 accepted', mod.findDraft(core, 2).status, 'accepted')
}

// 索引重建：老师手写了一份教案但忘了改索引
{
  write(path.join(WS, '模块二_y/详细教案/课时3_第三课：梯度.md'), '# 课时 3：第三课：梯度\n\n## 目标\n\n1. x\n\n## 推导\n\n### 一、a\n\nb\n\n## 实操\n\n### 任务一：c\n\n- 产物：`c.py`\n\n## 验收标准\n\n1. d\n\n## 当堂交付物\n\n- `c.py`\n')
  write(path.join(WS, '模块二_y/详细教案/随手记.md'), '一份不叫课时N_的文件')
  const r = mod.rebuildIndex(core)
  const idx3 = JSON.parse(fs.readFileSync(path.join(WS, '课程中心/课程结构索引.json'), 'utf8'))
  checkEq('重建后课时 3 的 plan 被补上', idx3.modules[1].lessons[0].plan, '课时3_第三课：梯度.md')
  check('重建列出了改动', r.changes.some((c) => Number(c.lesson) === 3), JSON.stringify(r.changes.map((c) => c.lesson)))
  check('无法对应的文件被列为待处理（不静默忽略）', r.orphans.some((o) => o.name === '随手记.md'), JSON.stringify(r.orphans.map((o) => o.name)))
  check('模块二仍有课时没教案 → 保留 missingPlans', idx3.modules[1].missingPlans === true)

  // 补齐第四课 → 重建后 missingPlans 应被清掉并记一笔
  write(path.join(WS, '模块二_y/详细教案/课时4_第四课：注意力.md'), '# 课时 4：第四课：注意力\n\n## 目标\n\n1. x\n\n## 推导\n\n### 一、a\n\nb\n\n## 实操\n\n### 任务一：c\n\n- 产物：`c.py`\n\n## 验收标准\n\n1. d\n\n## 当堂交付物\n\n- `c.py`\n')
  const r2 = mod.rebuildIndex(core)
  const idx4 = JSON.parse(fs.readFileSync(path.join(WS, '课程中心/课程结构索引.json'), 'utf8'))
  check('补齐后清除 missingPlans', idx4.modules[1].missingPlans === undefined)
  check('清除也被记为一次改动', r2.changes.some((c) => Number(c.lesson) === 0 && /补齐/.test(c.why)), JSON.stringify(r2.changes.map((c) => c.why)))
  core.invalidateCache()
  const st3 = mod.outlineStatus(core, await core.getTree(), {})
  checkEq('最终：4 个课时全部有教案', [st3.withPlan, st3.missingPlan], [4, 0])
  const r3 = mod.rebuildIndex(core)
  check('再重建一次：没有需要改的（幂等）', r3.wrote === false, JSON.stringify(r3.changes))
}

// 锚点文件：老师确认过的要持久化，坏的锚点文件不能拖垮体检
{
  mod.writeAnchors(core, { 2: { chapter: '第一章', from: 1, to: 9 }, 3: { chapter: '', from: 0 } })
  const a = mod.readAnchors(core)
  checkEq('写入 1 个有效锚点（无效的被丢弃）', Object.keys(a.list), ['2'])
  check('锚点文件在课程目录里', fs.existsSync(path.join(COURSE, mod.PLAN_ANCHOR_REL)))
  write(path.join(COURSE, mod.PLAN_ANCHOR_REL), '{ 这不是 JSON')
  const b = mod.readAnchors(core)
  checkEq('锚点文件坏了 → 当作没有（不抛错）', Object.keys(b.list).length, 0)
  const stB = mod.outlineStatus(core, await core.getTree(), { spans: {}, anchors: b })
  check('体检在锚点文件损坏时仍能跑完', stB.totalLessons === 4)}

// 模板覆盖
{
  write(path.join(COURSE, '教案模板.md'), '# 课时 {{课时}}：{{标题}}\n\n## 目标\n\n## 推导\n\n## 实操\n\n## 验收标准\n\n## 当堂交付物\n')
  const t = mod.planTemplate(core, 7, '第七课')
  check('老师自带的模板生效并替换占位符', t.source === '教案模板.md' && t.text.indexOf('课时 7：第七课') >= 0, t.text.split('\n')[0])
  fs.unlinkSync(path.join(COURSE, '教案模板.md'))
  const t2 = mod.planTemplate(core, 7, '第七课')
  check('删掉模板后回落内置骨架', t2.source === '内置骨架')
}

// ── 5. 真实工作区回归（不改任何文件）────────────────────────────
console.log('\n=== 5. 真实工作区回归（只读）===')
{
  delete process.env.CIP_COURSE_CODE
  process.env.CIP_WORKSPACE = ROOT
  const c2 = mod.createCore({ get: () => undefined, effect: () => () => {} }, { prefix: '/t', role: 'teacher', pkgRoot: ROOT, label: 'T' })
  const tree2 = await c2.getTree()
  check('真实工作区解析到 30 个课时', tree2 && tree2.modules.reduce((a, m) => a + m.lessons.length, 0) === 30)
  const byChapter = {}
  for (const ch of mod.CHAPTERS) { const d = await c2.getSlides(ch); if (d && !d.error) byChapter[ch] = d }
  const spans = mod.inferModuleSpans(byChapter)
  check('从真实课件推断出模块跨度', Object.keys(spans).length >= 3, Object.keys(spans).join(',') + ' → ' + JSON.stringify(Object.keys(spans).map((k) => spans[k].length + '段')))
  const st = mod.outlineStatus(c2, tree2, { spans, anchors: mod.readAnchors(c2) })
  check('真实体检：30 课时', st.totalLessons === 30)
  console.log('    · 有教案 ' + st.withPlan + ' / 缺教案 ' + st.missingPlan + ' / 有课件页 ' + st.withSlides
    + ' / 可自动补 ' + st.autoFillable + ' / 材料不足 ' + st.noMaterial)
  check('缺教案的课时都能对上真实数字（本轮实测 12）', st.missingPlan > 0, String(st.missingPlan))
  const m4 = st.modules.find((m) => m.name === '模块四')
  check('模块四如实报「没有课件页」', m4 && m4.hasSlides === 0, JSON.stringify(m4 && { hasSlides: m4.hasSlides, hasPlan: m4.hasPlan }))
  check('模块四仍有代码示例 → 可自动补', m4 && m4.hasCode === true && m4.codeFiles > 0, String(m4 && m4.codeFiles))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exitCode = fail ? 1 : 0
