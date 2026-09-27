// L1「换一门课只改配置」的**端到端**验收。
//
// 为什么不能只测 layout.js 的纯函数：纯函数测的是「配置 → 布局」，而这一路真正
// 会断的地方在中间 —— `readCourseConfig` 只搬 COURSE_DEFAULTS 里那 5 个字符串字段，
// `layout` / `topics` 这类对象**在读完配置的那一刻就被丢掉了**。
// 症状是「配置写了、面板毫无反应」，而且不报错：看起来像解析器坏了。
// 这个漏就是本文件第一次跑出来的（6 条红），所以它必须在流水线里常驻。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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
const C = await import(pathToFileURL(path.join(ROOT, '课程中心/course-plugin/dsh-course-core/src/index.js')).href)

let pass = 0
let fail = 0
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n + (x ? '  ' + x : '')) } else { fail++; console.log('  ✗ ' + n + '  ' + (x || '')) } }
const stub = { get: () => undefined, effect: () => () => {} }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-layout-'))
const mk = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text, 'utf8') }

// 一门**形状完全不同**的课：讲次 / 讲稿 / 讲义幻灯片 / 答疑 / 作业 / 不同的章节与词表
const WS = path.join(tmp, 'ws')
mk(WS, '课程中心/课程结构索引.json', JSON.stringify({
  course: '数据结构', totalLessons: 2,
  modules: [{
    id: 'P1', name: '第一部分', dir: '第一部分_线性结构', planDir: '讲稿', theme: 't', range: '讲次 1-2',
    lessons: [{ no: 1, title: '绪论', plan: '讲次1_绪论.md' }, { no: 2, title: '线性表', plan: '' }],
  }],
}))
mk(WS, '第一部分_线性结构/讲稿/讲次1_绪论.md', '# 讲次 1：绪论\n')
mk(WS, '课程配置.json', JSON.stringify({
  title: '数据结构', code: 'DS01',
  layout: {
    chapters: ['绪论', '线性表'], planDir: '讲稿', questionsRel: '答疑', submitRel: '作业',
    slidesDir: '讲义/幻灯片',
  },
  topics: ['复杂度分析', '指针与内存'], issueTypes: ['概念不清'],
}))

process.env.CIP_WORKSPACE = WS
delete process.env.CIP_COURSE_CODE
delete process.env.CIP_COURSE_DIR
const site = C.createCore(stub, { prefix: '/t', role: 'teacher', pkgRoot: ROOT, label: 'T' })
const info = site.info()

console.log('\n=== 1. 换一门课：只写 课程配置.json，代码一行没动 ===')
ck('课程名 / 课程码跟着配置走', info.course.title === '数据结构' && info.course.code === 'DS01',
  info.course.title + ' / ' + info.course.code)
ck('章节名（不再是写死的「第一章..三」）',
  JSON.stringify(info.layout.chapters) === JSON.stringify(['绪论', '线性表']), info.layout.chapters.join('、'))
ck('知识领域词表（进提示词与下拉框，换课必须一起换）',
  JSON.stringify(info.defaults.topics) === JSON.stringify(['复杂度分析', '指针与内存']), info.defaults.topics.join('、'))
ck('问题性质词表', JSON.stringify(info.defaults.types) === JSON.stringify(['概念不清']), info.defaults.types.join('、'))
ck('教案目录 → 讲稿', info.layout.planDir === '讲稿', info.layout.planDir)
ck('课件目录 → 讲义\\幻灯片（正斜杠被统一，避免两边解析出不同字符串）',
  info.layout.slidesDir === '讲义\\幻灯片', info.layout.slidesDir)
ck('教案骨架没配 → 用默认值（这正是「零改动」该有的表现）',
  JSON.stringify(info.defaults.planSections) === JSON.stringify(['目标', '推导', '实操', '验收标准', '当堂交付物']))

console.log('\n=== 2. 目录跟着走 —— 这才是「换课」真正生效的地方 ===')
const pub = site.abs('答疑\\公共\\a.md')
ck('私有数据落到配置的问题池目录', pub.indexOf(path.join(path.resolve(WS), '答疑')) === 0, pub.replace(WS, '.'))
ck('info 下发的目录名也是配置的',
  info.publicDir === '答疑\\公共' && info.submitDir === '作业', info.publicDir + ' / ' + info.submitDir)
const tree = await site.getTree()
ck('结构索引读得出来（用的就是配置里那个路径）',
  !!(tree && tree.modules[0].lessons.length === 2), '课程 ' + (tree && tree.course))
ck('教案路径也能按配置找到',
  (await site.planPathFor(1)) === '第一部分_线性结构\\讲稿\\讲次1_绪论.md', await site.planPathFor(1))
ck('自检报告指出「这一项还是内置默认值」',
  info.layoutReport.rows.some((r) => r.isDefault && r.note.indexOf('换课时记得改') >= 0))

console.log('\n=== 3. 老工作区零改动（回归：默认值不许被改动）===')
process.env.CIP_WORKSPACE = ROOT
const old = C.createCore(stub, { prefix: '/t', role: 'teacher', pkgRoot: ROOT, label: 'T' }).info()
ck('章节名仍是 第一章..三', JSON.stringify(old.layout.chapters) === JSON.stringify(['第一章', '第二章', '第三章']))
ck('问题池仍是 课程问题池\\公共', old.publicDir === '课程问题池\\公共', old.publicDir)
ck('教案目录仍是 详细教案', old.layout.planDir === '详细教案')
ck('结构索引仍是 课程中心\\课程结构索引.json', old.layout.indexRel === '课程中心\\课程结构索引.json')
ck('整体被认成「全是默认值」', old.layoutReport.allDefault === true)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exitCode = fail ? 1 : 0
