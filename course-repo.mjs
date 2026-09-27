#!/usr/bin/env node
/**
 * 课程发布工具 —— 把「教师私有工作区」里被显式勾选的内容，同步到「学生可见的公开仓」。
 *
 * 设计原则（重要，别改）：
 *   1. 默认什么都不发布。public 仓里出现的每一个文件，都必须来自 publish.manifest.json 的显式声明。
 *   2. 发布是「复制」，不是「过滤」。未勾选的内容永远不进 public 仓，学生即使 clone 也看不到。
 *   3. 教案只认「课时N_*.md」这种命名。README.md、补充材料、提示词等一律不进——它们不是课时教案。
 *   4. public 仓里出现了 manifest 之外的文件，视为「泄漏」，工具会报警并列出，绝不静默删除。
 *
 * 用法：
 *   node course-repo.mjs check     只检查，不写文件（先跑这个）
 *   node course-repo.mjs publish   执行发布
 *   node course-repo.mjs status    对比 manifest 与实际内容，报告差异
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 注意：import.meta.url 里的非 ASCII 是百分号编码的，必须用 fileURLToPath 解码，
// 否则中文路径会变成 %E6%9A%91... 导致 ENOENT。
const HERE = path.dirname(fileURLToPath(import.meta.url))
/**
 * 课程工作区：**发布的对象**。
 *
 * 默认按「工具就在 <工作区>/课程发布/ 里」推出来 —— 这是课程仓库自带工具时的布局。
 * 但这个工具现在也是**插件仓库**的一部分（`tools/course-repo.mjs`），
 * 从 GitHub 装插件的人本地并没有 <工作区>/课程发布/ 这个目录，
 * 那时按 HERE 推出来的「工作区」会指向插件仓库的父目录 —— **错的**，
 * 而且症状很隐蔽：它不报错，只是把内容发到别处（或者报一堆「找不到课时」）。
 *
 * 所以给一个显式覆盖口。插件调用时会自动带上它（见 dsh-course-teacher 的 publish 动作），
 * 于是「工具在哪」和「发的是哪个工作区」这两件事就解耦了。
 */
const WORKSPACE = process.env.CIP_WORKSPACE
  ? path.resolve(process.env.CIP_WORKSPACE) : path.resolve(HERE, '..')
/**
 * 四个路径都可以用环境变量覆盖 —— 这是**端侧全流程测试的前提**。
 *
 * 原来它们是写死的：发布工具只认本目录下的 public/ 与 publish.manifest.json。
 * 后果是「想测一遍完整流程」就必然动到真实公开仓，于是没人敢测。
 * 覆盖之后，测试工作区可以整套跑在别的地方：
 *
 *   CIP_PUBLIC_DIR=D:\test\课程发布\public
 *   CIP_MANIFEST=D:\test\课程发布\publish.manifest.json
 *
 * ── 默认值挂在哪：看 CIP_WORKSPACE 有没有给 ─────────────────────────────
 * 工具现在有两种安放方式，默认值必须各自成立：
 *   · 老样子（课程仓库自带）：工具在 <工作区>/课程发布/ 里 → HERE/.. 就是工作区，
 *     而 public/ 与 manifest 就在工具**旁边**（HERE）。
 *   · 新样子（插件仓库的 tools/ 下，CIP_WORKSPACE 被显式传入）：
 *     工具旁边**没有** public/ 与 manifest —— 它们在课程工作区里。
 *     这时若还按 HERE 找，会报「找不到 publish.manifest.json：<插件仓库>/tools/…」，
 *     看起来像工具坏了，其实是找错了地方。
 * 所以：给了 CIP_WORKSPACE 就一律挂到那个工作区的 课程发布/ 下（配置与发布面
 * 都属于课程仓库，这是本项目的约定布局）；没给就沿用老规矩。
 *
 * ⚠️ 只在启动时读一次，且**不打印路径**（它可能带用户名）。
 *    真要用错，危险的只有 publish —— status/check 都是只读的。
 */
const REPO_HOME = process.env.CIP_WORKSPACE ? path.join(WORKSPACE, '课程发布') : HERE
const PUBLIC_DIR = process.env.CIP_PUBLIC_DIR
  ? path.resolve(process.env.CIP_PUBLIC_DIR) : path.join(REPO_HOME, 'public')
const MANIFEST_PATH = process.env.CIP_MANIFEST
  ? path.resolve(process.env.CIP_MANIFEST) : path.join(REPO_HOME, 'publish.manifest.json')
const INDEX_PATH = path.join(WORKSPACE, '课程中心', '课程结构索引.json')

const LESSON_RE = /^课时(\d+)_(.+)\.md$/

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('找不到 publish.manifest.json：' + MANIFEST_PATH)
    process.exit(1)
  }
  return readJson(MANIFEST_PATH)
}

function loadIndex() {
  return readJson(INDEX_PATH)
}

/** 收集某一个模块下允许发布的课时教案 */
function collectPlans(idx, manifest) {
  const out = []
  for (const mod of idx.modules) {
    const setting = manifest.modules && manifest.modules[mod.name]
    if (!setting || setting.publish !== true) continue
    const planDir = path.join(WORKSPACE, mod.dir, mod.planDir)
    if (!fs.existsSync(planDir)) continue
    const allow = Array.isArray(setting.lessons) ? new Set(setting.lessons) : null
    for (const f of fs.readdirSync(planDir)) {
      const m = LESSON_RE.exec(f)
      if (!m) continue                       // 只认课时N_*.md，README/补充材料一律跳过
      const no = Number(m[1])
      if (allow && !allow.has(no)) continue  // 白名单里没写这一课，就不发
      out.push({ lessonNo: no, module: mod.name, src: path.join(planDir, f), name: f })
    }
  }
  return out
}

/** 收集代码示例 */
function collectCode(idx, manifest) {
  const out = []
  for (const mod of idx.modules) {
    const setting = manifest.modules && manifest.modules[mod.name]
    if (!setting || setting.publishCode !== true) continue
    const dir = path.join(WORKSPACE, mod.dir, '代码示例')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      if (f === 'README.md' && !manifest.includeReadme) continue
      out.push({ module: mod.name, src: path.join(dir, f), name: f })
    }
  }
  return out
}

/** 收集已沉淀的 FAQ */
function collectFaq(manifest) {
  const out = []
  if (!manifest.publishFaq) return out
  const dir = path.join(WORKSPACE, '课程问题池', 'FAQ')
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) out.push({ src: path.join(dir, f), name: f })
  }
  return out
}

/** 生成学生端要读的目录清单：只描述已发布的内容 */
function buildCourseJson(idx, plans, code, faq, manifest) {
  const byModule = new Map()
  for (const p of plans) {
    if (!byModule.has(p.module)) byModule.set(p.module, [])
    byModule.get(p.module).push(p)
  }
  const modules = []
  for (const mod of idx.modules) {
    const ps = (byModule.get(mod.name) || []).sort((a, b) => a.lessonNo - b.lessonNo)
    if (!ps.length) continue
    modules.push({
      name: mod.name,
      theme: mod.theme,
      range: mod.range,
      lessons: ps.map((p) => {
        const meta = mod.lessons.find((l) => l.no === p.lessonNo) || {}
        return {
          no: p.lessonNo,
          title: meta.title || p.name,
          planPath: '教案/' + mod.name + '/' + p.name,
        }
      }),
    })
  }
  return {
    generatedAt: new Date().toISOString(),
    course: idx.course,
    publishedLessons: plans.length,
    totalLessons: idx.totalLessons,
    note: '本清单只包含教师已发布的内容。未发布的课时在本文件中不存在。',
    chapters: manifest.chapters || [],
    modules,
    code: code.map((c) => ({ module: c.module, path: '代码示例/' + c.module + '/' + c.name })),
    faq: faq.map((f) => ({ path: 'FAQ/' + f.name })),
    gradingDimensions: manifest.publishGradingDimensions ? idx.gradingDimensions : [],
  }
}

/** 列出 public 目录里现有的所有文件（相对路径） */
function walk(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '.git') continue
      walk(full, base, acc)
    } else {
      acc.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return acc
}

/** 插件本体：课程中心/course-plugin/ 下的三个包 → public/panel/<包名>/
 *
 *  为什么不用 tarball：
 *    插件要读「课程工作区」。工作区路径的解析允许用配置文件指定，
 *    而配置文件由 install.ps1 写 —— 写什么路径，取决于学生把仓 clone 到了哪里。
 *    直接发源码目录，学生拿到的是可读的 JS，能自己核对插件做了什么；
 *    tarball 只是一层不必要的封装，而且每次改代码都要重新 pack。
 *
 *  为什么发三个包：
 *    学生端与教师端是两个可独立安装的插件（各自的路由前缀与侧栏入口），
 *    共享一个内核包。三个包必须**并排放在同一个父目录**下 —— 内核的装载靠的是
 *    「相对本包位置算出的绝对路径」（见各包 src/core-loader.js），不是靠
 *    node_modules 的裸名解析，所以相对位置不能变。
 *  只发运行必需的文件，node_modules / 临时文件一律不发。 */
function collectPanel() {
  const out = []
  const root = path.join(WORKSPACE, '课程中心', 'course-plugin')
  if (!fs.existsSync(root)) return out
  const topReadme = path.join(root, 'README.md')
  if (fs.existsSync(topReadme)) out.push({ to: 'panel/README.md', src: topReadme, kind: '插件' })

  const INCLUDE = ['src', 'lib', 'package.json', 'cordis.patch.yml', 'README.md']
  for (const pkg of fs.readdirSync(root, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    if (pkg.name.indexOf('dsh-course-') !== 0) continue
    const pkgDir = path.join(root, pkg.name)
    const walkP = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        const r = rel ? rel + '/' + e.name : e.name
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue
          walkP(full, r)
        } else {
          out.push({ to: 'panel/' + pkg.name + '/' + r, src: full, kind: '插件' })
        }
      }
    }
    for (const top of INCLUDE) {
      const p = path.join(pkgDir, top)
      if (!fs.existsSync(p)) continue
      if (fs.statSync(p).isDirectory()) walkP(p, top)
      else out.push({ to: 'panel/' + pkg.name + '/' + top, src: p, kind: '插件' })
    }
  }
  return out
}

/**
 * 课件图要不要**随公开仓分发**。
 *
 * 默认发（`--no-media` 才不发）—— 理由：媒体源是「可选增强」，
 * 而课程包里的那份是**离线兜底**。把默认值改成「不发」会让所有
 * 还没配 `mediaBase` 的学生立刻看不到课件，那是个不可接受的默认。
 *
 * 什么时候该加 `--no-media`：媒体已经在别处托管好了（jsDelivr / 对象存储 / NAS），
 * 而且**已经用 `tools/verify-media-source.mjs` 逐字节核对过远程那份完整**。
 * 那时公开仓从 14.3 MB 掉到 ~0.7 MB，学生 clone 快得多，
 * 而图片走 CDN 按需取（看过一次就落进 课程中心\.cache\media\，之后断网也能看）。
 *
 * ⚠️ 顺序不能反：**先核对、再摘**。反过来做的话，学生那边一打开课件页
 *    全是「图片不可用」占位框，而老师本机一切正常（他本地有图）——
 *    这种「只有学生看得见」的故障最难查。所以 verify-media-source.mjs
 *    会在远程缺任何一张时报错退出，而这里只在它绿了之后才该被调用。
 */
const NO_MEDIA = process.argv.includes('--no-media')

/** 课程数据：学生端面板要读的东西，必须放在工作区里。
 *
 *  布局是硬约束 —— 插件的 WORKSPACE 解析会检查「工作区里有没有 课程中心 目录」，
 *  而面板读的文件名是写死的：
 *    课程中心/课程结构索引.json
 *    课程中心/预览数据/<章>.json
 *    课程中心/预览数据/media/<章>/<图片>
 *  所以这里不能自由发挥，只能按插件期望的结构摆放。
 *
 *  media 走 webp 目录（由 tools/to_webp.py 生成），MP4 不进公开仓：
 *  单个 mp4 就有 34 MB，而它们本来就是 PPT 里嵌的录屏片段，不是课程主体。 */
function collectCourseData(manifest) {
  const out = []
  const idx = path.join(WORKSPACE, '课程中心', '课程结构索引.json')
  if (fs.existsSync(idx)) out.push({ to: '课程中心/课程结构索引.json', src: idx, kind: '课程数据' })

  // 面板样式表：**必须发布**，否则学生机器上的排版是坏的。
  //
  // 踩过的坑（端侧实测，学生机器上真实复现）：插件的样式表加载有**两级候选**
  // （见 dsh-course-core/src/host.js 的 cssCandidates）：
  //     ① 课程中心\_插件源码\panel.css   ← 工作区副本，优先
  //     ② <插件包>\lib\panel.css         ← 插件内置那份
  // 而 ① 以前**不在发布清单里**，学生 clone 下来没有它 → 直接退回 ②。
  // 那份 lib/panel.css 是个陈旧的构建产物（11941 字节，而权威版是 48888 字节），
  // 结果 69 个 class 没有任何样式定义：鱼骨图失去布局、课时脉络塌成竖排字符、
  // 提问列表只剩纯文字。**看起来像布局代码写错了，其实是根本没有样式。**
  //
  // 为什么是发这一份而不是改 lib/panel.css：
  //   两级候选本来就是为「本机覆盖」设计的，工作区那份是权威版；
  //   发它等于顺着现有机制走，不用去动插件包里那份死副本。
  const panelCss = path.join(WORKSPACE, '课程中心', '_插件源码', 'panel.css')
  if (fs.existsSync(panelCss)) {
    out.push({ to: '课程中心/_插件源码/panel.css', src: panelCss, kind: '面板样式' })
  }

  const webpRoot = manifest.webpDir
    ? path.resolve(WORKSPACE, manifest.webpDir)
    : path.join(WORKSPACE, '.webp-out')
  const rawRoot = path.join(WORKSPACE, '课程中心', '预览数据')
  let skippedMedia = 0
  for (const ch of ['第一章', '第二章', '第三章']) {
    const j = path.join(rawRoot, ch + '.json')
    if (fs.existsSync(j)) out.push({ to: '课程中心/预览数据/' + ch + '.json', src: j, kind: '课程数据' })
    const dir = path.join(webpRoot, ch)
    if (!fs.existsSync(dir)) continue
    // --no-media：课件图不随仓分发（它们已经在别处托管好了，见 NO_MEDIA 的注释）。
    // 注意**只跳过图**：<章>.json 必须留着 —— 没有它，连「这一章有几页、
    // 每张图放在哪」都不知道，面板连占位框都画不出来（那一页会是全白）。
    if (NO_MEDIA) { skippedMedia += fs.readdirSync(dir).length; continue }
    for (const f of fs.readdirSync(dir)) {
      out.push({ to: '课程中心/预览数据/media/' + ch + '/' + f, src: path.join(dir, f), kind: '课件图片' })
    }
  }
  if (NO_MEDIA && skippedMedia) {
    console.log('  （--no-media）课件图不随仓分发，跳过 ' + skippedMedia + ' 张 ——')
    console.log('     前提：它们已经在别处托管好，且 课程配置.json 里的 mediaBase 指向那里。')
    console.log('     摘之前请先跑 node tools/verify-media-source.mjs 逐字节核对远程那份完整。')
  }
  return out
}

/** 学生端的固定文件（README、issue 模板）来自 templates/，由工具统一发布 */
function collectTemplates() {
  const out = []
  const base = path.join(HERE, 'templates')
  if (!fs.existsSync(base)) return out
  const walkT = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walkT(full, r)
      else out.push({ to: r, src: full })
    }
  }
  walkT(base, '')
  return out
}

/**
 * 公开问答的**正文**：课程问题池/公共/ 下的 .md 与 .thread.json → public/课程问题池/公共/
 *
 * 为什么必须发（端侧实测踩到的）：`buildPublicQa` 会生成 `公开问答.json`，
 * 面板的「公开问答」页照它渲染出若干条、每条都可点 —— 但**正文从来没被发布过**。
 * 于是那整页是死链：索引说 3 条，点进去必然是「条目不存在」。
 * 学生会以为「老师公开了但我的面板坏了」，而真相是仓库里就是没有那些文件。
 *
 * 所以规则很简单：**索引里出现的每一条，正文必须一起发出去**。
 * 只读 `公共/`，绝不碰 `学生/` —— 那是原则问题（学生私有提问不进公开仓）。
 */
function collectPublicQa() {
  const out = []
  const dir = path.join(WORKSPACE, '课程问题池', '公共')
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).sort()) {
    // 只收问答正文与线程记录；别的文件（临时文件、笔记）不发
    if (!/\.md$/i.test(f) && !/\.thread\.json$/i.test(f)) continue
    out.push({ to: '课程问题池/公共/' + f, src: path.join(dir, f), kind: '公开问答' })
  }
  return out
}

/**
 * 把 课程问题池/公共/ 汇总成一份机器可读的公开问答索引。
 *
 * 为什么单独做这个（而不是让学生端自己去解析 markdown）：
 *   · 面板要展示的是「老师公开了哪些问题 + 每个问题的总结」，逐个 .md 解析
 *     既慢又脆（markdown 是给人读的，格式随时可能微调）。
 *   · 公共面是「共同数据库」的公开那一半。有一份结构化清单，别的工具
 *     （比如以后做个网页版题库）也能直接读走，不必理解我们的目录约定。
 *   · 教师答复轮次要能被识别出来（by:'teacher'），学生端才能把它和 AI 答复分开显示。
 *
 * 只读 公共/ 目录 —— 学生私有目录里的东西绝不进这份索引，那是原则问题。
 */
function buildPublicQa(workspace) {
  const dir = path.join(workspace, '课程问题池', '公共')
  const items = []
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.md$/i.test(f)) continue
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      const fields = {}
      const m = /^---\n([\s\S]*?)\n---/.exec(text)
      if (m) {
        for (const line of m[1].split('\n')) {
          const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line)
          if (!kv) continue
          let v = kv[2].trim()
          if (v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1)
          fields[kv[1]] = v
        }
      }
      // 线程单独存 JSON，读它才知道有几轮、其中几轮是老师答复的
      let turns = []
      const tf = path.join(dir, f.replace(/\.md$/i, '') + '.thread.json')
      if (fs.existsSync(tf)) {
        try { turns = JSON.parse(fs.readFileSync(tf, 'utf8')).turns || [] } catch (e) { turns = [] }
      }
      const teacherTurns = turns.filter((t) => t.by === 'teacher').length
      items.push({
        path: '课程问题池/公共/' + f,
        id: fields.id || '',
        title: fields.title || f,
        summary: fields.summary || '',
        module: fields.module || '',
        lesson: fields.lesson || '',
        type: fields.type || '',
        severity: fields.severity || '',
        status: fields.status || '',
        created: fields.created || '',
        updated: fields.updated || '',
        student: fields.student || '',
        aiTurns: turns.length - teacherTurns,
        teacherTurns: teacherTurns,
        hasTeacherAnswer: teacherTurns > 0,
      })
    }
  }
  items.sort((a, b) => String(b.created + b.id).localeCompare(String(a.created + a.id)))
  return {
    generatedAt: new Date().toISOString(),
    note: '本清单只含老师审核后公开的问题。学生私有的提问不在其中，也不会出现在这个仓库的任何地方。',
    count: items.length,
    withTeacherAnswer: items.filter((x) => x.hasTeacherAnswer).length,
    items,
  }
}

function plan() {
  const idx = loadIndex()
  const manifest = loadManifest()
  const plans = collectPlans(idx, manifest)
  const code = collectCode(idx, manifest)
  const faq = collectFaq(manifest)

  const writes = []
  for (const t of collectTemplates()) writes.push({ to: t.to, src: t.src, kind: '学生端文件' })
  for (const p of collectPanel()) writes.push(p)
  for (const q of collectPublicQa()) writes.push(q)
  for (const c of collectCourseData(manifest)) writes.push(c)
  for (const p of plans) writes.push({ to: '教案/' + p.module + '/' + p.name, src: p.src, kind: '教案' })
  for (const c of code) writes.push({ to: '代码示例/' + c.module + '/' + c.name, src: c.src, kind: '代码示例' })
  for (const f of faq) writes.push({ to: 'FAQ/' + f.name, src: f.src, kind: 'FAQ' })

  return { idx, manifest, plans, code, faq, writes }
}

function doCheck() {
  const { writes, plans, idx } = plan()
  console.log('=== 将要发布的内容 ===')
  const byKind = {}
  for (const w of writes) byKind[w.kind] = (byKind[w.kind] || 0) + 1
  console.log('  教案 ' + (byKind['教案'] || 0) + ' 份 · 代码示例 ' + (byKind['代码示例'] || 0) + ' 份 · FAQ ' + (byKind['FAQ'] || 0) + ' 份')
  console.log('  插件 ' + (byKind['插件'] || 0) + ' 个文件 · 课程数据 ' + (byKind['课程数据'] || 0) + ' 份 · 课件图片 ' + (byKind['课件图片'] || 0) + ' 张')
  console.log('  已发布课时 ' + plans.length + ' / ' + idx.totalLessons)
  console.log('')
  // 图片动辄几百张，逐条列出没有意义，只按章汇总
  const imgByCh = {}
  for (const w of writes) {
    const m = /^课程中心\/预览数据\/media\/(.+?)\//.exec(w.to)
    if (m) imgByCh[m[1]] = (imgByCh[m[1]] || 0) + 1
  }
  for (const w of writes) {
    if (w.kind === '课件图片') continue
    if (w.kind === '插件') continue
    console.log('  + ' + w.to)
  }
  const pluginFiles = writes.filter((w) => w.kind === '插件')
  if (pluginFiles.length) {
    console.log('  + panel/（三个包）…共 ' + pluginFiles.length + ' 个文件')
    for (const w of pluginFiles) {
      if (w.to.indexOf('/lib/') >= 0) continue
      console.log('      ' + w.to.replace('panel/', ''))
    }
  }
  for (const ch of Object.keys(imgByCh)) console.log('  + 课程中心/预览数据/media/' + ch + '/ …共 ' + imgByCh[ch] + ' 张')
  const skipped = []
  for (const mod of idx.modules) {
    const dir = path.join(WORKSPACE, mod.dir, mod.planDir)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md') && !LESSON_RE.test(f)) skipped.push(mod.name + '/' + f)
    }
  }
  if (skipped.length) {
    console.log('')
    console.log('=== 刻意跳过（不是课时教案，需要你显式确认才发）===')
    for (const s of skipped) console.log('  - ' + s)
  }
  if (!writes.length) {
    console.log('')
    console.log('当前没有任何已勾选内容。请在 publish.manifest.json 里把要发布的模块设为 publish: true。')
  }
}

function doPublish() {
  const { writes, manifest } = plan()
  /**
   * ⚠️ `--no-media` 之前的三道自检。
   *
   * 这一档是**唯一会让学生看到坏界面**的发布方式：摘掉图之后，
   * 老师本机一切正常（他本地有图），只有学生那边全是「图片不可用」。
   * 所以这里宁可啰嗦：
   *   ① 摘之前，public/ 里那些图**先数一遍**（下面 publish 完会用到）
   *   ② 必须配了 mediaBase，否则摘了就没人能补上
   *   ③ 提示先跑 verify-media-source.mjs（真正的逐字节核对在那边）
   */
  if (NO_MEDIA) {
    const cfgPath = path.join(WORKSPACE, '课程配置.json')
    let mediaBase = ''
    try { mediaBase = String(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mediaBase || '').trim() } catch (e) { /* 没配置 */ }
    const before = walk(path.join(PUBLIC_DIR, '课程中心', '预览数据', 'media')).length
    console.log('\n== --no-media：课件图不随仓分发 ==')
    console.log('  这次 publish 会从 public/ 里**删掉** ' + before + ' 张课件图（原来已经发布过的那份）')
    if (!mediaBase) {
      console.error('  ✗ 但没有配 mediaBase（课程配置.json）—— 摘掉之后学生没有地方能取到图。')
      console.error('    先在 课程配置.json 里写一行 mediaBase，再重跑。已中止，public/ 没有被改动。')
      process.exit(2)
    }
    console.log('  媒体源 mediaBase = ' + mediaBase)
    console.log('  ⚠️ 请先确认远程那份是完整的：node tools/verify-media-source.mjs')
    console.log('     （它逐字节比对本地与远程。远程缺任何一张，学生就会看到「图片不可用」。）')
  }
  let n = 0
  for (const w of writes) {
    const dest = path.join(PUBLIC_DIR, w.to)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(w.src, dest)
    n++
  }
  const courseJson = buildCourseJson(loadIndex(), plan().plans, plan().code, plan().faq, manifest)
  const cj = path.join(PUBLIC_DIR, '课程.json')
  fs.mkdirSync(path.dirname(cj), { recursive: true })
  fs.writeFileSync(cj, JSON.stringify(courseJson, null, 2), 'utf8')
  console.log('已写入 ' + n + ' 个文件到 public/，并重新生成 课程.json')
  console.log('公开课时 ' + courseJson.publishedLessons + ' / ' + courseJson.totalLessons)

  // 公开问答索引：把 课程问题池/公共/ 里的条目汇总成一份机器可读的清单。
  // 为什么要有它：公共面是「共同数据库」的公开那一半，学生端要能**整体**看到
  // 「老师公开了哪些问题、每个问题的总结是什么」，而不是逐个文件去猜。
  // 同时它也是一份可以直接被别人读走的数据（外部工具不必解析 markdown）。
  const qaPath = path.join(PUBLIC_DIR, '公开问答.json')
  const qa = buildPublicQa(WORKSPACE)
  fs.writeFileSync(qaPath, JSON.stringify(qa, null, 2), 'utf8')
  console.log('公开问答索引：' + qa.items.length + ' 条（含教师答复 ' + qa.items.filter((x) => x.teacherTurns > 0).length + ' 条）')

  // 泄漏检查：public 里出现 manifest 之外的文件就要报警
  // keepInPublic 是人工维护的仓库级文件（LICENSE 等），不属于自动生成，但合法存在
  const keep = new Set(manifest.keepInPublic || [])
  const expected = new Set(['课程.json', '公开问答.json', ...keep, ...writes.map((w) => w.to)])
  const actual = walk(PUBLIC_DIR).filter((f) => !f.startsWith('.git/'))
  const extra = actual.filter((f) => !expected.has(f))
  if (extra.length) {
    console.log('')
    console.log('⚠ 以下文件在 public/ 里但不在本次发布清单中（可能是上次发布会残留，也可能是不该公开的东西）：')
    for (const e of extra) console.log('  ! ' + e)
    console.log('  请确认：该删的删，该加进 manifest 的加。工具不会替你删。')
  } else {
    console.log('泄漏检查：public/ 中无清单外文件 ✓')
  }
  console.log('')
  console.log('下一步（git 在本机 D:\\Git\\cmd\\git.exe，未加入 PATH）：')
  console.log('  cd 课程发布/public && git add -A && git commit -m "publish: ..." && git push')
}

function doStatus() {
  const { writes, manifest } = plan()
  const keep = new Set(manifest.keepInPublic || [])
  // 课程.json 与 公开问答.json 都是 publish 时自动生成的，不在 manifest 里但合法
  const expected = new Set(['课程.json', '公开问答.json', ...keep, ...writes.map((w) => w.to)])
  const actual = new Set(walk(PUBLIC_DIR).filter((f) => !f.startsWith('.git/')))
  const missing = [...expected].filter((f) => !actual.has(f))
  const extra = [...actual].filter((f) => !expected.has(f))
  console.log('manifest 期望 ' + expected.size + ' 个文件，public/ 实际 ' + actual.size + ' 个')
  console.log('尚未发布 : ' + (missing.length ? missing.length + ' 个' : '无'))
  missing.slice(0, 20).forEach((f) => console.log('  - ' + f))
  console.log('清单外文件: ' + (extra.length ? extra.length + ' 个' : '无'))
  extra.slice(0, 20).forEach((f) => console.log('  ! ' + f))
  // 公开问答索引的内容摘要：老师最关心的是「公开了多少、其中多少有我的答复」
  const qaPath = path.join(PUBLIC_DIR, '公开问答.json')
  if (fs.existsSync(qaPath)) {
    try {
      const qa = JSON.parse(fs.readFileSync(qaPath, 'utf8'))
      console.log('公开问答 : ' + qa.count + ' 条，其中 ' + qa.withTeacherAnswer + ' 条含教师答复')
    } catch (e) { console.log('公开问答 : 解析失败 ' + e.message) }
  } else {
    console.log('公开问答 : 尚未生成（跑一次 publish 会生成）')
  }
}

const cmd = process.argv[2] || 'check'
if (cmd === 'check') doCheck()
else if (cmd === 'publish') doPublish()
else if (cmd === 'status') doStatus()
else {
  console.log('用法: node course-repo.mjs [check|publish|status]')
  process.exit(1)
}
