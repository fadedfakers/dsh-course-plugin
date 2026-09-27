// 多课程路由的隔离验证：新布局（共享内容在根 + 课程码子目录）与旧布局都要能解析。
// 用临时目录造两种形状，不碰真实工作区。
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


const CORE = 'C:/Users/Administrator/Desktop/暑期课程/课程中心/course-plugin/dsh-course-core/src/host.js'
const mod = await import(pathToFileURL(CORE).href)
const { resolveWorkspace, listCourses } = mod

let pass = 0, fail = 0
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cip-route-'))
const mkdir = (p) => fs.mkdirSync(p, { recursive: true })
// 夹具工厂：造一个「像工作区」的目录 —— 必须带 课程结构索引.json，
// 那是解析器判定「这里是共享课程内容」的依据（只有空 课程中心/ 目录不算）。
const mkWorkspace = (dir) => {
  mkdir(path.join(dir, '课程中心'))
  fs.writeFileSync(path.join(dir, '课程中心', '课程结构索引.json'), '{}', 'utf8')
}
// 造一门课：课程目录根部放 课程配置.json（不是放进共享的 课程中心/）。
const mkCourse = (rootDir, code, title) => {
  const dir = path.join(rootDir, '课程', code)
  mkdir(path.join(dir, '课程问题池', '公共'))
  fs.writeFileSync(path.join(dir, '课程配置.json'), JSON.stringify({ title }), 'utf8')
  return dir
}

// ---- 形状 A：旧布局（根目录本身就是课程）----
const A = path.join(root, 'A')
mkWorkspace(A)
mkdir(path.join(A, '课程问题池', '公共'))

// ---- 形状 B：共享式布局（根放共享内容，课程码子目录放私有数据）----
const B = path.join(root, 'B')
mkWorkspace(B)
mkCourse(B, 'DL2026', '深度学习')
mkCourse(B, 'CV2027', '计算机视觉')

// ---- 形状 C：课程目录里**没有**共享内容（全在父目录）----
const C = path.join(root, 'C')
mkWorkspace(C)
mkdir(path.join(C, '课程', 'X1', '课程问题池'))

console.log('\n=== 1. 旧布局（CIP_WORKSPACE 指向课程本身）===')
delete process.env.CIP_COURSE_CODE
delete process.env.CIP_COURSE_DIR
process.env.CIP_WORKSPACE = A
{
  const ws = resolveWorkspace()
  check('解析到该目录', ws.dir === path.resolve(A), ws.dir)
  check('courseDir 等于工作区（没有独立的课程目录）', ws.courseDir === path.resolve(A))
  check('courseCode 为空', ws.courseCode === '', JSON.stringify(ws.courseCode))
}

console.log('\n=== 2. 共享式布局 + 指定课程码 ===')
process.env.CIP_WORKSPACE = B
process.env.CIP_COURSE_CODE = 'DL2026'
{
  const ws = resolveWorkspace()
  check('工作区（共享内容）在根目录', ws.dir === path.resolve(B), ws.dir)
  check('课程目录指向 课程/DL2026', ws.courseDir === path.join(path.resolve(B), '课程', 'DL2026'), ws.courseDir)
  check('courseCode = DL2026', ws.courseCode === 'DL2026')
  check('标记为 shared 布局', ws.shared === true)
}

console.log('\n=== 3. 共享式布局 + 不指定课程码（应自动挑第一个）===')
delete process.env.CIP_COURSE_CODE
process.env.CIP_WORKSPACE = B
{
  const ws = resolveWorkspace()
  check('工作区仍是根目录', ws.dir === path.resolve(B), ws.dir)
  check('自动挑到一门课', ws.courseCode === 'CV2027' || ws.courseCode === 'DL2026', ws.courseCode)
  check('课程目录与课程码一致', ws.courseDir === path.join(path.resolve(B), '课程', ws.courseCode))
  const all = listCourses(path.resolve(B))
  check('列出全部课程（按码排序）', all.length === 2 && all[0].code === 'CV2027' && all[1].code === 'DL2026',
    all.map((c) => c.code + (c.title ? '(' + c.title + ')' : '')).join(', '))
  check('课程标题从各自 课程配置.json 读出', all.find((c) => c.code === 'DL2026').title === '深度学习')
}

console.log('\n=== 4. 课程目录里没有课程中心（共享内容全在父目录）===')
process.env.CIP_WORKSPACE = C
process.env.CIP_COURSE_CODE = 'X1'
{
  const ws = resolveWorkspace()
  check('工作区回落到父目录', ws.dir === path.resolve(C), ws.dir)
  check('课程目录仍是 课程/X1', ws.courseDir === path.join(path.resolve(C), '课程', 'X1'), ws.courseDir)
}

console.log('\n=== 5. CIP_COURSE_DIR 最高优先级 ===')
process.env.CIP_COURSE_DIR = path.join(B, '课程', 'CV2027')
{
  const ws = resolveWorkspace()
  check('直接把它当课程目录', ws.courseDir === path.join(path.resolve(B), '课程', 'CV2027'), ws.courseDir)
  check('工作区找到共享内容', fs.existsSync(path.join(ws.dir, '课程中心')), ws.dir)
}

console.log('\n=== 6. 真实工作区仍然解析成功（回归）===')
delete process.env.CIP_COURSE_DIR
delete process.env.CIP_COURSE_CODE
process.env.CIP_WORKSPACE = 'C:/Users/Administrator/Desktop/暑期课程'
{
  const ws = resolveWorkspace()
  check('解析到真实工作区', ws.dir === path.resolve('C:/Users/Administrator/Desktop/暑期课程'), ws.dir)
  check('courseDir 也是它（当前是单课程布局）', ws.courseDir === ws.dir)
}

console.log('\n=== 7. 端侧不许从**模块**上解构目录常量（必须走 core 实例）===')
// 这一条是静态查的，因为踩过一次而且症状很隐蔽：
//
//   createCore 为了让「换一门课只改配置」不必改 270 处，用**局部同名 const**
//   把 INDEX_REL / PUBLIC_ITEMS_REL 这一组遮蔽掉了（见 host.js 的 L1 注释）。
//   于是内核**模块级**导出的那份永远是默认形状，实例上的那份才是按配置算的。
//   两个名字长得一模一样、值不一样。
//
//   端侧若写 `const { PUBLIC_ITEMS_REL } = C`，拿到的是默认值那一份。
//   后果不是报错，而是**两条路径分叉**：core.writeItem 写进配置目录
//   （答疑\公共\...），端侧却按默认目录（课程问题池\公共\...）去找 ——
//   老师共享给学生的那条，学生在面板里看不到。
//
// 静态扫描足够：这类解构一共只有两种写法，而两种都很好认。
{
  const ends = ['dsh-course-student', 'dsh-course-teacher']
  for (const pkg of ends) {
    const raw = fs.readFileSync(
      path.join('C:/Users/Administrator/Desktop/暑期课程/课程中心/course-plugin', pkg, 'src', 'host.js'), 'utf8')
    // ⚠️ 先去掉注释再扫。踩过一次：这段检查的**说明注释**里提到了
    //    `const { PUBLIC_ITEMS_REL } = C` 这个反面示例，
    //    于是检查把自己的注释判成了违规 —— 报了红，而被查的代码其实是对的。
    //    凡是静态扫描，都必须先剥注释，否则「怎么解释这条规则」会改变检查结果。
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
    // ① 从内核对象上解构出来
    const destructured = /const\s*\{[^}]*\b(PUBLIC_ITEMS_REL|STUDENT_ITEMS_REL|SUBMIT_ROOT_REL)\b[^}]*\}\s*=\s*C\b/s.test(src)
    // ② 裸用（没有 core. 前缀）
    const bare = src.split(/\r?\n/)
      .filter((l) => /(?<![.\w])(PUBLIC_ITEMS_REL|STUDENT_ITEMS_REL|SUBMIT_ROOT_REL)\b/.test(l))
    check(pkg + '：没有从模块上解构目录常量', !destructured)
    check(pkg + '：没有裸用模块级目录常量（都走 core.）', bare.length === 0,
      bare.length ? bare.map((s) => s.trim()).join(' | ').slice(0, 160) : '')
  }
}

fs.rmSync(root, { recursive: true, force: true })
console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exitCode = fail ? 1 : 0
