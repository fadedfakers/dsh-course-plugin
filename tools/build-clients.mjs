#!/usr/bin/env node
/**
 * 一条命令重建三个包的客户端并校验。当前 **13 步**（0..12），全绿才算过。
 *
 *   0.  校验多课程路由（工作区解析：旧布局 / 共享式布局 / 课程码；含「端侧不许
 *       从内核模块上解构目录常量」这条静态断言）
 *   1.  校验课程布局解析（L1 可配置）
 *   2.  校验 L1 端到端（换一门课只改 课程配置.json，代码一行不动）
 *   3.  校验教案补全（骨架 / 锚点 / 草稿区 / 采纳 / 索引重建 / 真实工作区体检）
 *   4.  校验仓库管理（发布页后端：仓名 slug / remote 解析 / 状态人话 / 脱敏）
 *   5.  校验「起子进程并收回输出」（沙箱不给管道 —— 这条守的是那个静默的 EPERM）
 *   6.  校验发布工具「在哪」与「发哪个工作区」已解耦（从 GitHub 装的形态）
 *   7.  校验材料归位建议引擎（认不出就待定、要模块就必须选模块）
 *   8.  从「已固化的旧客户端」抽出共享渲染核心 → dsh-course-core/lib/client-shared.js
 *   9.  校验组件回调传递完整性（漏传的症状是「按钮点了没反应」，构建发现不了）
 *   10. 校验三个 bundle 能否真的物化执行（语法 + 运行时引用）
 *   11. 校验宿主半区能加载、两个插件能同时挂载、路由不冲突（临时工作区）
 *   12. 真机验收：发布页（**只读**，用真实工作区与两个真仓库）
 *
 * 为什么要抽而不是复制：
 *   markdown/公式渲染这段在两个插件里必须**逐字一致**。复制一份出来，
 *   改一处忘一处，两边就会开始漂移 —— 这个项目已经因为「客户端与宿主对同一个
 *   字段的理解不一致」吃过一次大亏（m.file 双前缀，所有图片都加载不出来）。
 *
 * 用法：node build-clients.mjs [--skip-verify]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELEASE_DIR = path.resolve(HERE, '..')
const WORKSPACE = path.resolve(RELEASE_DIR, '..')

const PACKS = path.join(WORKSPACE, '课程中心', 'course-plugin')
const OLD_CLIENT = path.join(WORKSPACE, '课程中心', 'course-panel-plugin', 'lib', 'client.js')
const CORE_CLIENT = path.join(PACKS, 'dsh-course-core', 'lib', 'client-shared.js')

function run(label, cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: WORKSPACE })
  if (r.status !== 0) {
    console.error('\n✗ ' + label + ' 失败（exit ' + r.status + '）')
    process.exit(r.status || 1)
  }
  return true
}

// 多课程路由：先把「工作区解析」验掉。它是所有后续步骤的前提 ——
// 解析错了，后面每一步都会拿着错误的工作区跑，报出来的错还各不相同。
console.log('== 0/14  校验多课程路由 ==')
run('路由校验', process.execPath, [path.join(HERE, 'verify-routing.mjs')])

// 「解析不到工作区」这条分支**在教师本机上永远走不到**（兜底是教师机绝对路径，
// 而这个目录在教师本机上确实存在），所以它以前是「写坏了也没人知道」。
// 换台机器（新电脑/学生机/CI）才会真正踩到 —— 那时若还是静默，
// 用户看到的就是「面板空着，一句提示也没有」。这两步专门守它。
console.log('\n== 0b/14  校验「解析不到工作区」时不再静默 ==')
run('工作区未解析校验', process.execPath, [path.join(HERE, 'verify-workspace-unresolved.mjs')])
run('工作区提示校验', process.execPath, [path.join(HERE, 'verify-workspace-warning.mjs')])

// 公开仓的「公开问答」索引必须与正文一致。
// 端侧实测踩到过：索引渲染出 3 条、每条都可点，而正文从来没被发布过 ——
// 整页是死链，且不报错、不崩，只是点一个坏一个。
console.log('\n== 0c/14  校验公开问答索引无死链 ==')
run('公开问答校验', process.execPath, [path.join(HERE, 'verify-public-qa.mjs')])

// 学生机形态下的 hasPlan / published。
// 这两个 bug **在教师机上永远复现不出来**（教师机有模块教案目录、有 课程.json），
// 所以必须用「教案平铺 + 只声明部分课时已发布」的夹具来守。
console.log('\n== 0d/14  校验学生机形态的 hasPlan / published ==')
run('学生机形态校验', process.execPath, [path.join(HERE, 'verify-hasplan-student-shape.mjs')])

// 「拉取更新」失败时的归因与建议。
// 端侧实测踩到：真实原因是连不上 github，却报成「本地有未提交的改动」；
// 而且原来那句 hint 建议 `git checkout -- .` —— 它会丢弃工作区改动，
// 当时正好又有忽略规则漏掉学生提问的 bug，照做存在真丢数据的风险。
console.log('\n== 0e/14  校验「拉取更新」失败的归因与建议 ==')
run('同步提示校验', process.execPath, [path.join(HERE, 'verify-sync-hint.mjs')])

// 「这条路径属不属于我」。端侧报告 + 静态审查共同指出：原来三处各写各的字符串前缀比较，
// 其中 followup 的守卫条件恒为假（死代码），本机任何进程都能给已公开条目追加内容；
// 而且学号互为前缀时会误判、`..` 也没拦。这条守它。
console.log('\n== 0f/14  校验条目路径归属与访问守卫 ==')
run('路径归属校验', process.execPath, [path.join(HERE, 'verify-path-ownership.mjs')])

// 版本控制信息。老师要照抄这里生成的克隆命令给学生 —— 命令错了就是把学生
// 引到错的版本，而拿错版本的症状（某些动作报未知动作）学生无从判断。
// 它还会读 `.git` 并 spawn git describe，所以各条退化路径都必须给能看的结果。
console.log('\n== 0g/14  校验版本控制信息 ==')
run('版本信息校验', process.execPath, [path.join(HERE, 'verify-version-info.mjs')])

// install.ps1 的「4c 课程标识」那一步：从索引生成 课程配置.json。
// 端侧实测发现面板顶栏显示的是占位名「深度学习课程」，而真实课名就在索引里 ——
// 因为没人写 课程配置.json。这条守「写出来的能被面板读到」，
// 并专门盯「PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM」那个坑
// （带 BOM 的 JSON 会让 Node 的 JSON.parse 直接抛错）。
console.log('\n== 0h/14  校验 install.ps1 写出的课程配置 ==')
run('课程配置校验', process.execPath, [path.join(HERE, 'verify-install-config.mjs')])

// 首次启动向导：一台**没配过工作区**的机器上唯一该看到的东西。
// 端侧报告里「面板空着、一句提示也没有」的根因就是这个 ——
// 解析链的兜底原来是教师机绝对路径，在别的机器上必然落空且静默。
// 这条同时守住「绝不覆盖用户已有目录」这条不可逆的事。
console.log('\n== 0i/14  校验首次启动向导（含「绝不覆盖」与「两份副本不许漂移」）==')
run('首次启动向导校验', process.execPath, [path.join(HERE, 'verify-setup-wizard.mjs')])

// 媒体的取用策略：本地优先 → 远程回退 → 落缓存。
// 为什么单列一步：它决定「课件图能不能不随课程包分发」—— 也就是
// 「改一个错别字要不要全班重下十几兆」以及「将来发录播视频放哪」。
// 这条路上每一环出错都是静默的（地址里的令牌被写进课程包、缓存路径穿越、
// 中文名不编码导致每次都重下、本地优先被写反导致离线用不了）。
// 它用**本地假远程源**端到端跑，不依赖外网。
console.log('\n== 0j/14  校验媒体取用（本地优先 / 远程回退 / 落缓存）==')
run('媒体取用校验', process.execPath, [path.join(HERE, 'verify-media-fallback.mjs')])

// 「资料」：课件原件 / 讲义 PDF 怎么发给学生、怎么在线看。
// 老师那句「教师课件、ppt、资料放哪，学生从哪连接到该仓库」的落点。
// 这一层的失败全是静默的（清单写错 → 那项消失；文件不在 → 学生 404；
// pptx 没配 PDF → 能下载但看不了），所以每一条都单独钉。
console.log('\n== 0k/14  校验「资料」清单与文件路由（含路径穿越）==')
run('资料清单校验', process.execPath, [path.join(HERE, 'verify-materials-list.mjs')])

// 文档里的安装说明与真实行为一致 —— 老师提的「readme 上要声明：
// 学生端只装核 + 学生端插件」逼出来的。
// 为什么值得进构建门：文档不像代码，写错了**不会报错**，只会让人按错的步骤做，
// 然后卡在一个看起来像"插件坏了"的地方。README 原来就写着「三个包都要装」，
// 而且装法写的是本机路径（新机器上没有那个目录）—— 错了很久，没有任何东西会红。
console.log('\n== 0l/14  校验文档里的安装说明与真实行为一致 ==')
run('安装文档校验', process.execPath, [path.join(HERE, 'verify-docs-install.mjs')])

// 教案补全：教师端最核心的一步，而且它会**写课程结构索引**（共享内容）。
// 单独一步、在独立临时工作区里跑（真实工作区那段只读）——
// 跑挂了立刻停，不让后面的步骤拿着一个坏索引继续。
// L1「可配置」：换一门课只改 课程配置.json。这一层是后面所有分离工作的地基，
// 而它最容易悄悄坏掉的方式是「默认值被改动」—— 那会让老工作区跟着变。
console.log('\n== 1/14  校验课程布局解析（L1 可配置）==')
run('布局校验', process.execPath, [path.join(HERE, 'verify-layout.mjs')])

// L1 的**端到端**验收：写一份布局完全不同的配置，看插件是不是真的跟着变。
// 纯函数测试测不出「配置在中途被丢掉」——那个漏就是这么抓到的。
console.log('\n== 2/14  校验 L1 端到端（换一门课只改配置）==')
run('L1 端到端校验', process.execPath, [path.join(HERE, 'verify-layout-e2e.mjs')])

console.log('\n== 3/14  校验教案补全 ==')
run('教案校验', process.execPath, [path.join(HERE, 'verify-plans.mjs')])

// 材料归位建议：纯函数，不碰工作区。放在这里是因为它贯穿「上传→归位→发布」整条路，
// 而那三步都要用到同一套判据（认不出就待定、要模块就必须选模块）。
// 仓库管理（发布页后端）：仓名 slug、remote 解析、状态读取、无 Token 时的手动步骤。
// 硬要求只有一条 —— 返回对象里任何位置都不能出现 token（第一版就漏了两次）。
console.log('\n== 4/14  校验仓库管理 ==')
run('仓库校验', process.execPath, [path.join(HERE, 'verify-repo.mjs')])

console.log('\n== 5/14  校验「起子进程并收回输出」 ==')
run('子进程校验', process.execPath, [path.join(HERE, 'verify-run.mjs')])

console.log('\n== 6/14  校验发布工具「在哪」与「发哪个工作区」已解耦 ==')
// 这一条守的是**分发形态**：从 GitHub 装插件的人，工具在插件仓库的 tools/ 下，
// 而他本地没有 <工作区>/课程发布/。工具原来按「自己所在目录的上一层」猜工作区 ——
// 猜错**不报错**，只是把内容发到别处。所以必须显式验：换个位置放工具，
// 靠 CIP_WORKSPACE 照样发正确的那个工作区。
run('发布工具解耦校验', process.execPath, [path.join(HERE, 'verify-repo-tool.mjs')])

console.log('\n== 7/14  校验材料归位建议引擎 ==')
run('归位建议校验', process.execPath, [path.join(HERE, 'verify-materials.mjs')])

console.log('\n== 8/14  抽取共享渲染核心 ==')
if (!fs.existsSync(OLD_CLIENT)) {
  console.error('找不到源客户端：' + OLD_CLIENT)
  process.exit(1)
}
run('抽取', process.execPath, [path.join(HERE, 'extract-client-core.cjs'), OLD_CLIENT, CORE_CLIENT])

// ⚠️ 这一步是补一个**真实踩到的盲点**：上面刚用工具重写了 client-shared.js，
//    而第 10 步只校验三个**包**里的 bundle，不直接校验这个中间产物。
//    结果本轮我给 client-shared.js 加了一句判断、少写一个右括号，
//    **构建门全绿**，是 `node --check` 手工跑才发现的 —— 那时它已经进了发布副本。
//    语法错误在浏览器里的表现是「整个面板白屏」，而构建说没问题，最难查。
console.log('\n== 8b/14  校验共享渲染核心的语法 ==')
run('共享核心语法校验', process.execPath, ['--check', CORE_CLIENT])

// ⚠️ 样式表也要同步 —— 这一步是**实机截图逼出来的**。
// 面板样式有**两级候选**：工作区里的 `课程中心\_插件源码\panel.css`（权威）优先，
// 退回插件内置的 `dsh-course-core\lib\panel.css`。而那份内置副本长期陈旧
// （11941 字节，缺 69 个 class：侧栏 .k86、主区 .k8c、卡片 .kcb/.kce/.kca、
// 说明段 .kd1…）—— 工作区里没有权威版时（新机器 / 旧 clone / 换目录），
// 用户看到的就是那一份：侧栏与主区**塌成一条 30 像素宽的竖排文字**，
// 卡片挤在一起、按钮和正文颜色接近。看起来像布局写错了，其实是根本没样式。
// 上一轮把权威版发进了公开仓（治发布侧），这一步治**本机这一侧**。
console.log('\n== 8c/14  同步面板样式表（两级候选不许给出两个界面）==')
run('样式表同步', process.execPath, [path.join(HERE, 'sync-panel-css.mjs')])

if (process.argv.includes('--skip-verify')) {
  console.log('\n（已跳过校验）')
  process.exit(0)
}

// 组件回调传递完整性：onRevise 漏传过一次 —— 点击抛 TypeError，而
// **事件处理器里的异常不被 React 错误边界捕获**，表现是「按钮点了没反应」，
// 构建与渲染断言都发现不了。这一条是静态查的，便宜且覆盖全部组件。
console.log('\n== 9/14  校验组件回调传递完整性 ==')
run('回调传递校验', process.execPath, [path.join(HERE, 'verify-props.mjs')])

console.log('\n== 10/14  校验三个客户端 bundle 能否物化执行 ==')
run('客户端校验', process.execPath, [path.join(HERE, 'verify-clients.mjs'), PACKS])

console.log('\n== 11/14  校验宿主半区与双插件挂载 ==')
// ⚠️ 必须用**隔离的临时工作区**，不能拿真实工作区跑。
//    harness 会真的提问、批改、审计 —— 审计为「值得共享」时会在
//    课程问题池/公共/ 写下副本，而公共面是给全班看的地方。
//    踩过一次：跑完发现公共面里躺着 S001 的测试提问。
const harness = path.join(HERE, 'dual-plugin-harness.mjs')
if (!fs.existsSync(harness)) {
  console.warn('找不到 dual-plugin-harness.mjs，跳过宿主校验')
  process.exit(0)
}

const tmp = path.join(WORKSPACE, '.tmp-harness-ws')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, '课程中心', '预览数据'), { recursive: true })
const seed = [
  ['课程中心/课程结构索引.json', '课程中心/课程结构索引.json'],
  ['课程中心/预览数据/第一章.json', '课程中心/预览数据/第一章.json'],
  // 课程.json 不在教师工作区里 —— 它是 publish 时生成、只存在于公开仓的。
  // 但「课时 → 教案」的可靠映射就在它里面，学生端靠它找教案，所以要种进去。
  [path.join(RELEASE_DIR, 'public', '课程.json'), '课程.json'],
]
let seeded = 0
for (const [from, to] of seed) {
  const src = path.isAbsolute(from) ? from : path.join(WORKSPACE, from)
  if (!fs.existsSync(src)) continue
  fs.copyFileSync(src, path.join(tmp, to))
  seeded += 1
}
// 教案：优先用原始模块目录里的，没有就用公开仓的平铺目录
const pubPlans = path.join(RELEASE_DIR, 'public', '教案')
if (fs.existsSync(pubPlans)) fs.cpSync(pubPlans, path.join(tmp, '教案'), { recursive: true })
// 课件图片用第三章（最小），够验证媒体路由与扩展名回退
const webp = path.join(WORKSPACE, '.webp-out', '第三章')
if (fs.existsSync(webp)) fs.cpSync(webp, path.join(tmp, '课程中心', '预览数据', 'media', '第三章'), { recursive: true })

if (seeded < 3) {
  console.warn('真实工作区里缺课程数据，跳过宿主校验')
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}
console.log('  临时工作区：' + tmp + '（用完即删，不污染真实数据）')
try {
  run('宿主校验', process.execPath, [harness, tmp, PACKS])
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// 真机验收（**只读**）：拿真实工作区与两个真仓库，验发布页在那台机器上
// 到底会显示什么。它是唯一一条「用真数据而不是自己造的夹具」的检查 ——
// 而发布页这一块恰恰最需要它：假 .git/config 永远造不出「owner 大小写不一样」
// 「url 带不带 .git」这些真实差异。
//
// 为什么必须常驻流水线：它抓到过一个只有真配置才暴露的漏 ——
// 端侧从**内核模块**上解构目录常量（拿到的是默认形状），而 core 实例上那份
// 才是按课程配置算的。两种写法在默认课程上表现完全一样，
// 只有把 questionsRel 配成别的目录才会分叉：界面显示一个目录、文件写进另一个。
console.log('\n== 12/14  真机验收：发布页（只读，用真实工作区）==')
run('发布页真机验收', process.execPath, [path.join(HERE, 'acceptance-publish.mjs'), WORKSPACE, PACKS])

console.log('\n全部构建与校验通过 ✓')