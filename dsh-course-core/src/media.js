/**
 * 媒体（课件图 / 视频 / 讲义 PDF）的**取用策略**：本地优先 → 远程回退 → 本地缓存。
 *
 * ── 为什么要有这个模块（老师提的问题）──────────────────────────────────
 * 「公开仓里没有 PPT，有没有更好的仓库能更好地支持这个插件？」
 *
 * 查清的事实：课件**图**其实在仓里（293 张 webp / 13.6 MB，
 * `课程中心/预览数据/media/<章>/`），面板从来不读 `.pptx` 原件 ——
 * 它读 `第一章.json` 的坐标 + 碎片图，在客户端拼回整页。
 * 所以「没有 PPT」不是漏发，是设计如此。
 *
 * 但那个问题指向的是一个真问题：**一个仓同时装了三类更新频率差两个数量级的东西**。
 *   课程骨架 / 教案 / 公开问答   0.3 MB   每周改
 *   插件本体                     1.1 MB   每轮改
 *   课件图（将来还有视频、原件）  13.6 MB  基本不变
 * 现在老师改一个错别字 → 重新 publish → 学生重新 clone 14 MB；
 * 而哪天要发录播视频或原始 PPT，GitHub 直接出局（单文件 100 MB 硬限、
 * 仓库 1 GB 软限，而且**历史会永久背着它**，clone 再也瘦不回来）。
 *
 * ── 这一层的做法：把「媒体放在哪」变成一个开关 ──────────────────────────
 * 插件不再假设媒体一定在工作区里：
 *   ① 本地有 → 直接给（**离线优先**，行为与今天完全一样）
 *   ② 本地没有、但配了 `mediaBase` → 去取回来给客户端，**同时落一份缓存**
 *   ③ 取到了缓存之后 → 下次就走本地那一档（断网也能看）
 *   ④ 都没配 / 取不到 → 现在那个「图片不可用」占位框，不假装成功
 *
 * 于是「换仓库」不再是插件的事：今天挂 GitHub raw、明天换 Cloudflare R2、
 * 后天用学校 NAS，都只改 `课程配置.json` 的一行。
 *
 * ── 这个文件里只有**纯函数** ────────────────────────────────────────────
 * 真正的取用（fetch、写缓存、回响应）在 host.js 的 registerMedia 里。
 * 这里放的是**判断**：地址合不合法、URL 怎么拼、缓存路径怎么算。
 * 理由与 setup.js 一样 —— 这三件事说错了都不会当场报错：
 * 拼错 URL 是 404（看着像「图本来就没有」），算错缓存路径会**写到目录外面去**
 * （路径穿越），而「没配 mediaBase」与「配错了」在界面上长得一样。
 */
import path from 'node:path'

/** 允许的扩展名：取回来的东西必须长得像媒体，否则不写进缓存 */
export const MEDIA_EXT = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.webm', '.pdf']

/**
 * 校验一个媒体源地址。**只接受 https / http 的裸源**，并且要过三关：
 *
 *   ① 不能带凭据（`https://user:token@host/...`）—— 这个地址会写进
 *      `课程配置.json`、会被下发到学生机上、会在界面上显示。插件从第一天起的
 *      口径是「不放任何人的密钥」，而对象存储的预签名 URL/令牌恰恰最容易粘在这里。
 *   ② 必须是 http(s)：`file://` 会让「远程回退」变成「读本机任意文件」，
 *      `javascript:` 之类更要直接拒。
 *   ③ 结尾统一成**一个斜杠都没有**，拼 URL 时只在一处加 ——
 *      两处各加一次会拼出 `//`，而多数 CDN 对 `//` 是 404 而不是 301，
 *      症状是「图全都加载不出来」但配置看起来完全正确。
 *
 * @returns {{ok:boolean, base?:string, why?:string}}
 */
export function validateMediaBase(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return { ok: false, why: '空' }
  if (!/^https?:\/\//i.test(s)) {
    return { ok: false, why: '只支持 http/https 地址（现在填的是「' + s.slice(0, 40) + '」）。'
      + 'file:// 与相对路径会让「远程回退」变成读本机任意文件，所以这里直接拒。' }
  }
  const afterScheme = s.slice(s.indexOf('://') + 3)
  const hostPart = afterScheme.split('/')[0]
  if (hostPart.indexOf('@') >= 0) {
    return { ok: false, why: '地址里带了账号或令牌。这个地址会写进 课程配置.json、'
      + '也会显示在界面上，所以插件不收带凭据的写法 —— 请用不带凭据的地址。' }
  }
  if (!hostPart || hostPart.indexOf('.') < 0) {
    return { ok: false, why: '地址里没有像样的主机名：「' + s.slice(0, 40) + '」' }
  }
  // 去掉结尾的斜杠（可以有好几个），拼 URL 时只加一次
  const base = s.replace(/\/+$/, '')
  return { ok: true, base }
}

/**
 * 拼一条远程媒体 URL。
 *
 * ⚠️ 每一段都要 `encodeURIComponent`：课件目录名是中文（`第一章`），
 * 文件名里也可能有空格。不编码时浏览器会替我们编，而 Node 侧拼出来的字符串
 * 与缓存路径就对不上了 —— 症状是「每次都重新下载」，因为算出来的缓存键不一样。
 * 中文经 encodeURIComponent 是 %E7%AC%AC...，GitHub raw 与 R2 都吃这一套。
 */
export function mediaRemoteUrl(base, chapter, fileName) {
  const v = validateMediaBase(base)
  if (!v.ok) return ''
  const ch = String(chapter || '').trim()
  const nm = String(fileName || '').trim()
  if (!ch || !nm) return ''
  return v.base + '/' + encodeURIComponent(ch) + '/' + encodeURIComponent(nm)
}

/**
 * 缓存文件该落在哪。
 *
 * ⚠️ **这是本模块里唯一有安全后果的函数。**
 *    章节名与文件名都来自 HTTP 请求（`/cip-stu-media/<章>/<文件>`），
 *    也就是说**是外部输入**。直接 `path.join(cacheRoot, ch, nm)` 的话，
 *    一个 `..%2F..%2F` 就能把「写缓存」变成「往本机任意位置写文件」。
 *    所以这里做两件事，而不是只查 `..` 子串（那种检查在 Windows 上
 *    会被 `%5C`、盘符、以及 `....//` 绕过）：
 *      ① 两段都只允许**安全字符**（白名单，不是黑名单）；
 *      ② 拼完之后再 `path.resolve` 一次，确认结果**真的**落在 cacheRoot 里面。
 *    两道都要 —— 白名单挡住绝大多数，resolve 那道是兜底（万一白名单写漏了）。
 *
 * @returns {string} 绝对路径；调用方拿到后应直接使用（它已经过校验）
 * @throws {Error} 段名不安全、或解析结果落在缓存根之外
 */
export function mediaCachePath(cacheRootAbs, chapter, fileName) {
  const root = path.resolve(cacheRootAbs)
  const safeSeg = (s, what) => {
    const v = String(s || '').trim()
    // 白名单：中文、字母数字、点、下划线、短横、空格、括号。
    // 课件文件名长这样：slide001_image1.webp / 图 1-2（公式）.png
    if (!v || v === '.' || v === '..') throw new Error('非法的' + what + '：' + JSON.stringify(s))
    if (!/^[\w\u4e00-\u9fff .()\-]+$/.test(v)) throw new Error('非法的' + what + '（含不允许的字符）：' + JSON.stringify(s))
    return v
  }
  const ch = safeSeg(chapter, '章节名')
  const nm = safeSeg(fileName, '文件名')
  const full = path.resolve(root, ch, nm)
  // 兜底：解析结果必须仍在缓存根里（比较时补上分隔符，避免 /cache2 命中 /cache）
  const withSep = root.endsWith(path.sep) ? root : root + path.sep
  if (full !== root && full.indexOf(withSep) !== 0) {
    throw new Error('缓存路径落在缓存根之外：' + full)
  }
  return full
}

/**
 * 「这个文件值不值得缓存」。
 *
 * 判断顺序是**刻意的：先看 Content-Type，再看扩展名**。
 * 第一版写反了（先看扩展名），于是「名字叫 x.webp、内容其实是一个 404 页面」
 * 这种情况会被判成「是媒体」并**原样写进缓存** —— 症状是那张图永久损坏，
 * 而且重启、重连、清缓存之前怎么刷都是坏的。是 verify-media-fallback.mjs
 * 里那条端到端断言把它抓出来的（它让假远程源回 text/html 配 .webp 名字）。
 *
 * 两边的宽容度不一样是有意的：
 *   · Content-Type 说 image/* / video/* / pdf → 直接信（对象存储与 CDN 在这一项上是权威）
 *   · Content-Type 是明确的**文本类**（text/html、application/json…）→ 直接拒
 *   · Content-Type 含糊（application/octet-stream、没给）→ 才看扩展名
 * 这样「对象存储把 webp 回成 octet-stream」这种常见情况仍然能过，
 * 而「取回来一个 HTML 错误页」不会再被当成图。
 */
export function looksLikeMedia(fileName, contentType) {
  const nm = String(fileName || '').toLowerCase()
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim()
  if (/^(image|video)\//.test(ct) || ct === 'application/pdf') return { ok: true, why: '' }
  if (ct && /^(text\/|application\/(json|xml|xhtml))/.test(ct)) {
    return {
      ok: false,
      why: '取回来的东西是文本（' + ct + '），不是媒体 —— 多半是地址填错、取回了一个 404 页面。'
        + '已丢弃，没有写进缓存。',
    }
  }
  if (MEDIA_EXT.some((x) => nm.endsWith(x))) return { ok: true, why: '' }
  return {
    ok: false,
    why: '取回来的东西不像媒体（名字 ' + JSON.stringify(fileName) + '，类型 ' + JSON.stringify(contentType || '未给')
      + '）—— 多半是地址填错、取回了一个 404 页面。已丢弃，没有写进缓存。',
  }
}

/**
 * 认出来的媒体类型 → HTTP Content-Type。
 * 与 host.js 里原来那张表同一个口径，抽到这里是为了让「本地读到的」与
 * 「远程取回来的」用**同一个**判断（两处各写一份必然漂移）。
 */
export function contentTypeOf(fileName) {
  const nm = String(fileName || '').toLowerCase()
  if (nm.endsWith('.webp')) return 'image/webp'
  if (nm.endsWith('.png')) return 'image/png'
  if (nm.endsWith('.jpg') || nm.endsWith('.jpeg')) return 'image/jpeg'
  if (nm.endsWith('.gif')) return 'image/gif'
  if (nm.endsWith('.svg')) return 'image/svg+xml'
  if (nm.endsWith('.mp4')) return 'video/mp4'
  if (nm.endsWith('.webm')) return 'video/webm'
  if (nm.endsWith('.pdf')) return 'application/pdf'
  // 纯文本两类：提交附件与说明文件走同一个路由（见 host.js 的 registerSubmissions）
  if (nm.endsWith('.txt')) return 'text/plain; charset=utf-8'
  if (nm.endsWith('.md')) return 'text/markdown; charset=utf-8'
  return 'application/octet-stream'
}
