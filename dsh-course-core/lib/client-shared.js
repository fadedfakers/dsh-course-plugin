/**
 * dsh-course-client-core —— 学生端与教师端客户端共享的渲染核心
 *
 * 这个文件是**构建产物**，由 课程发布/tools/extract-client-core.cjs 从已经
 * 验证过的客户端代码里抽段生成。请改源文件后重新构建，不要直接手改这里 ——
 * 手改会在下次构建时被覆盖，而且两边的公式/markdown 渲染会开始漂移。
 *
 * 含：样式与 KaTeX 加载、markdown→HTML（带 $公式$）、徽标与下拉、课程脉络树、图片组件。
 * 不含：任何视图、任何 API 调用、**任何面板专属配置**。
 *
 * ⚠️ 为什么这里一个路由前缀都没有（这是踩过大坑的地方）：
 *   ModuleLoader 是**按 id 记忆化**的 —— 这个模块在全页只执行一次。
 *   曾经的写法是在模块里读一个全局 __CIP_UI_CFG__ 并把 KATEX_BASE / CSS_URL
 *   冻成常量，由两个面板各自在 require 之前写那个全局。结果是：
 *   **先加载的面板把自己的前缀固化，另一个面板全部用错路由** ——
 *   教师面板会去请求 /cip-stu-api，满屏「未知动作」，样式也是学生那份。
 *   一个全页唯一的模块，绝不能持有「因调用方而异」的值。
 *   现在这些值一律**按调用点传参**：
 *       ui.ensureCss('/cip-tea.css', 'cip-tea-css')
 *       ...ui.loadKatex('/cip-tea-katex', { onDone })
 *   模块内部只保留真正的全局状态（katexState），那是全页共享才对的。
 *
 * 用法（各自的 client.js 里）：
 *     const ui = require('dsh-course-client-core')   // 直接拿到 ui 对象，无副作用
 *
 * 全部实现包在一个 IIFE 里，工厂**直接返回 ui 对象**。
 * 曾经的写法是返回一个 makeUI 函数 —— 那样调用方拿到的是一个函数而不是对象，
 * 第一个 ui.xxx 就抛 TypeError（物化测试抓到的就是这个）。ModuleLoader 的约定
 * 是 factory(require) → exports，别在这上面加一层。
 */
window.__ModuleLoader__.load({
  id: 'dsh-course-client-core',
  factory: (require) => {
    const React = require('react')
    return (function makeUI() {
    // 三个标签常量在源文件里位于抽取范围之外，但下面的 SECTIONS 引用了 AI_LABEL，
    // 所以必须一并重建 —— 漏了就会在浏览器里抛 ReferenceError（这里加注释是因为
    // 这正是物化测试抓到的问题，别再删）。
    const AI_LABEL = 'AI 答复'
    const THREAD_LABEL = '追问记录'
    const GRADE_LABEL = '作业批改'
    // loadKatex(base, hooks) 不传 base 时的兜底。仅用于单独调试这个模块；
    // 两个面板都会显式传自己的 /cip-*-katex，所以这个值正常情况下不会用到。
    // （它必须存在：源文件里保留了这个回退分支，而上面已经不再导出 KATEX_BASE，
    //   不在这里补一个就会变成 undefined，拼出 "/undefined/katex.min.js"。）
    const KATEX_BASE = '/cip-katex'
/* ── 常量与配色 / 路径前缀 ── */

const MODULES = ['模块一', '模块二', '模块三', '模块四', '模块五']
    const TYPES = ['概念问题', '代码报错', '环境问题', '数值稳定性', '作业疑问', '讲义问题', '内容建议']
    const SEVERITIES = ['阻塞', '高', '中', '低']
    const STATUS_COLOR = {
      待处理: 'var(--dsw-alias-state-warn-primary)', 已答复: 'var(--dsw-alias-brand-primary)',
      待复盘: '#c2410c', 已沉淀: 'var(--dsw-alias-state-success-primary)', 转教案修订: '#7c3aed',
    }
    const SEVERITY_COLOR = {
      阻塞: 'var(--dsw-alias-state-error-primary)', 高: 'var(--dsw-alias-state-warn-primary)',
      中: 'var(--dsw-alias-label-secondary)', 低: 'var(--dsw-alias-label-secondary)',
    }
    const FLOW = ['待处理', '已答复', '待复盘', '已沉淀', '转教案修订']
    const SECTIONS = ['原始提问', '现象', '初步判断', AI_LABEL, '处理结论', '复盘']
    const NL = String.fromCharCode(10)
    const ZOOM_MIN = 0.4
    const ZOOM_MAX = 4
    const FISH_COLORS = ['#4c8dff', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6']
    
    // 样式表 URL 与 id 由调用方传入，不从模块常量取。
    // 原因：共享内核是全页唯一的（ModuleLoader 按 id 记忆化），
    // 而两个面板的样式表不同 —— 把 URL 冻在模块里，后加载的面板会拿到别人的样式。
    // 兜底用字面量：这里**不能**引用 CSS_URL / CSS_ID，那两个常量在抽取产物里
    // 已被有意移除（就是不许调用方固化路径），引用它们会直接 ReferenceError。

/* ── 样式表注入 ── */

function ensureCss(href, id) {
      const url = href || '/cip-panel.css'
      const cssId = id || 'cip-panel-css'
      // 已经挂过同一张表就跳过；挂了**别的**面板的表则补上自己那张（两张可以共存）
      const existing = document.getElementById(cssId)
      if (existing) {
        if (!url || existing.getAttribute('href') === url) return
        existing.parentNode.removeChild(existing)
      }
      const l = document.createElement('link')
      l.id = cssId
      l.rel = 'stylesheet'
      l.href = url
      document.head.appendChild(l)
    }

/* ── 内联样式解析 ── */

function css(text) {
      const out = {}
      for (const part of String(text || '').split(';')) {
        const i = part.indexOf(':')
        if (i < 0) continue
        const k = part.slice(0, i).trim()
        const v = part.slice(i + 1).trim()
        if (!k || !v) continue
        out[k.replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v
      }
      return out
    }

/* ── React.createElement 快捷方式 ── */

function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

/* ── 徽标 ── */

function bdg(t, c, g) { return h('span', g ? { className: 'k50 k19' } : { className: 'k50', style: { '--bdg-color': c || 'inherit' } }, t) }

/* ── 下拉选择 ── */

function pick(options, value, onChange) {
      return h('select', { className: 'k61', value: value, onChange: (e) => onChange(e.target.value) },
        options.map((o) => h('option', { key: o, value: o }, o)))
    }

/* ── 侧栏图标 ── */

function RailIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v9A1.5 1.5 0 0 1 19.5 16h-6.2l-4.3 4v-4H4.5A1.5 1.5 0 0 1 3 14.5v-9Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('circle', { cx: 8.6, cy: 10, r: 1.05, fill: 'currentColor' }),
        h('circle', { cx: 12.2, cy: 10, r: 1.05, fill: 'currentColor' }),
        h('circle', { cx: 15.8, cy: 10, r: 1.05, fill: 'currentColor' }),
        h('path', { d: 'M15.4 3.2h5.4v5.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

/* ── KaTeX 状态 ── */

const katexState = { ready: false, error: '', loading: false, queued: [] }

/* ── KaTeX 加载 ── */

function loadKatex(base, hooks) {
      // 兼容旧的单参写法：loadKatex(hooks)
      if (base && typeof base === 'object' && hooks === undefined) { hooks = base; base = KATEX_BASE }
      const root = base || KATEX_BASE
      if (katexState.ready) { hooks.onDone(true, ''); return }
      katexState.queued.push(hooks)
      if (katexState.loading) return
      katexState.loading = true
      const flush = (ok, err) => {
        katexState.loading = false
        katexState.ready = ok
        katexState.error = err || ''
        const list = katexState.queued.slice()
        katexState.queued = []
        for (const x of list) { try { x.onDone(ok, err) } catch (e) { /* ignore */ } }
      }
      try {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = root + '/katex.min.css'
        document.head.appendChild(link)
        const s = document.createElement('script')
        s.src = root + '/katex.min.js'
        s.onload = () => flush(true, '')
        s.onerror = () => flush(false, 'KaTeX 脚本加载失败')
        document.head.appendChild(s)
      } catch (e) { flush(false, '注入 KaTeX 失败：' + (e && e.message ? e.message : String(e))) }
    }

/* ── HTML 转义 ── */

function esc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

/* ── 公式占位 ── */

function maskMath(text, store) {
      let out = String(text == null ? '' : text)
      const put = (tex, display) => { const key = '\u0000M' + store.length + '\u0000'; store.push({ tex: tex, display: display }); return key }
      out = out.replace(/\$\$([\s\S]+?)\$\$/g, (m, g) => put(g, true))
      out = out.replace(/\\\[([\s\S]+?)\\\]/g, (m, g) => put(g, true))
      out = out.replace(/\\\(([\s\S]+?)\\\)/g, (m, g) => put(g, false))
      out = out.replace(/\$([^$\n]+?)\$/g, (m, g) => put(g, false))
      return out
    }

/* ── 转义并保留占位 ── */

function escapeExceptPlaceholders(masked) {
      return String(masked).split(/(\u0000M\d+\u0000)/)
        .map((p) => (/^\u0000M\d+\u0000$/.test(p) ? p : esc(p))).join('')
    }

/* ── 公式渲染 ── */

function renderMathIn(htmlEscaped, store) {
      return htmlEscaped.replace(/\u0000M(\d+)\u0000/g, (m, i) => {
        const item = store[Number(i)]
        if (!item) return ''
        if (!katexState.ready || typeof window.katex === 'undefined' || !window.katex.renderToString) {
          return item.display ? ('<pre>' + esc(item.tex) + '</pre>') : ('<code>' + esc(item.tex) + '</code>')
        }
        try {
          return window.katex.renderToString(item.tex, { displayMode: item.display, throwOnError: false, output: 'htmlAndMathml' })
        } catch (e) { return '<code>' + esc(item.tex) + '</code>' }
      })
    }

/* ── markdown → HTML ── */

function markdownToHtml(src) {
      const store = []
      const masked = maskMath(src, store)
      const lines = masked.replace(/\r\n/g, '\n').split('\n')
      const out = []
      let i = 0
      const inline = (s) => {
        let x = escapeExceptPlaceholders(s)
        x = x.replace(/`([^`]+?)`/g, (m, g) => '<code>' + g + '</code>')
        x = x.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        x = x.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
        x = x.replace(/\*([^*]+?)\*/g, '<em>$1</em>')
        return x
      }
      const flushP = (buf) => { if (buf.length) { out.push('<p>' + buf.map(inline).join('<br/>') + '</p>'); buf.length = 0 } }
      const para = []
      while (i < lines.length) {
        const line = lines[i]
        if (/^\s*```/.test(line)) {
          flushP(para)
          const body = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i += 1 }
          i += 1
          out.push('<pre><code>' + esc(body.join('\n')) + '</code></pre>')
          continue
        }
        const hd = /^(#{1,6})\s+(.*)$/.exec(line)
        if (hd) { flushP(para); const lv = hd[1].length; out.push('<h' + lv + '>' + inline(hd[2]) + '</h' + lv + '>'); i += 1; continue }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushP(para); out.push('<hr/>'); i += 1; continue }
        if (/^\s*[-*+]\s+/.test(line)) {
          flushP(para)
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i += 1 }
          out.push('<ul>' + items.join('') + '</ul>')
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          flushP(para)
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i += 1 }
          out.push('<ol>' + items.join('') + '</ol>')
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          flushP(para)
          const body = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1 }
          out.push('<blockquote>' + inline(body.join(' ')) + '</blockquote>')
          continue
        }
        if (!line.trim()) { flushP(para); i += 1; continue }
        para.push(line)
        i += 1
      }
      flushP(para)
      return renderMathIn(out.join(''), store)
    }

/* ── Markdown 组件 ── */

function Markdown({ text }) {
      return h('div', { className: 'k63', dangerouslySetInnerHTML: { __html: markdownToHtml(text || '') } })
    }

/* ── 课程脉络树 ── */

function Fishbone({ tree, onPick, selected }) {
      if (!tree || !tree.modules) return h('div', { className: 'k21' }, '课程索引未加载')
      const mods = tree.modules
      const nodes = []
      nodes.push(h('div', { key: 'hd', className: 'k57', style: { marginBottom: '6px' } },
        '共 ' + tree.totalLessons + ' 课时 · 点课时进入作业批改'))
      mods.forEach((mod, mi) => {
        const color = FISH_COLORS[mi % FISH_COLORS.length]
        nodes.push(h('div', { key: 'mh' + mi, style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '6px 0 3px' } },
          h('span', { className: 'k74', style: { background: color, marginTop: 0 } }),
          h('span', { style: { color: color, fontWeight: 700, fontSize: '12px' } }, mod.name),
          h('span', { className: 'k57', style: { marginLeft: 'auto' } }, mod.range)))
        nodes.push(h('div', { key: 'ml' + mi, className: 'k57', style: { marginLeft: '15px', marginBottom: '3px' } }, mod.theme))
        nodes.push(h('div', { key: 'lg' + mi, className: 'k77' },
          mod.lessons.map((ls, li) => {
            const isSel = selected === ls.no
            // 课时标签从 title 派生 —— 课程结构索引里**没有** short 字段
            // （索引的 lesson 只有 no / title / plan）。曾经读 ls.short，
            // 于是每个格子都显示「L1 undefined」。完整标题放在 title 提示里。
            const label = String(ls.title || ('课时' + ls.no))
            const short = label.length > 9 ? (label.slice(0, 9) + '…') : label
            return h('div', {
              key: 'l' + mi + '-' + li, className: 'k78', 'data-sel': isSel ? '1' : '0',
              title: 'L' + ls.no + ' ' + label + (ls.hasPlan ? '' : '（教案未撰写）') + ((ls.knowledge && ls.knowledge.length) ? ('｜' + ls.knowledge.join(' / ')) : ''),
              onClick: () => onPick(ls, mod),
            },
              h('span', { className: 'k83' }, 'L' + ls.no),
              h('span', { className: 'k84' }, short),
              ls.hasPlan ? null : h('span', { className: 'k30' }))
          })))
      })
      return h('div', null, nodes)
    }

/* ── 文本宽度估算（鱼骨图用） ── */

function estWidth(text, ratio) {
      let w = 0
      for (const ch of String(text || '')) w += (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.53)
      return w * ratio
    }

/* ── SVG 文本截断（鱼骨图用） ── */

function clipText(text, maxPx, fontPx) {
      const s = String(text == null ? '' : text)
      if (estWidth(s, fontPx) <= maxPx) return s
      let out = ''
      for (const ch of s) {
        if (estWidth(out + ch + '…', fontPx) > maxPx) break
        out += ch
      }
      return (out || s.slice(0, 1)) + '…'
    }

/* ── 课程大纲鱼骨图 ── */

function OutlineFishbone({ tree, selected, onPick }) {
      if (!tree || !tree.modules || !tree.modules.length) {
        return h('div', { className: 'k21' }, '课程结构索引未加载 —— 请确认工作区里有「课程中心/课程结构索引.json」')
      }
      // ── 几何：先算清每个盒子在哪，再让画布围绕它们 ─────────────────────
      // 教训：这个函数我连着修了三轮越界，都是因为「先定画布、再用一串互相
      //       推导的常数去凑位置」。只要有一个常数含义变了，格子就会跑到画布外，
      //       而页面上只表现为「图糊成一团」，看不出是哪一格。
      //       现在改成**两趟**：第一趟算出格子的实际 y 区间（不看画布），
      //       第二趟按这些区间决定主骨位置与画布尺寸。位置与画布不再互相依赖。
      const CW = 104, CH = 27, CG = 6   // 格子宽 / 高 / 列间距
      const MX = 18, MSTEP = 186, PAD = 14, TITLE_H = 34, HEAD_R = 22
      const GAPB = 14   // 主骨到第一行格子的留白
      const cols = Math.max(1, Math.floor((MSTEP - MX - CG) / (CW + CG)))
      const mods = tree.modules

      // 第一趟：每个模块的「格子块高度」与方向
      const blocks = mods.map((mod, mi) => {
        const ls = mod.lessons || []
        const rows = Math.max(1, Math.ceil(ls.length / cols))
        const h = GAPB + rows * CH + (rows - 1) * CG
        return { mod: mod, lessons: ls, rows: rows, h: h, up: mi % 2 === 0 }
      })
      const bhUp = Math.max(0, ...blocks.filter((b) => b.up).map((b) => b.h))
      const bhDn = Math.max(0, ...blocks.filter((b) => !b.up).map((b) => b.h))
      // 画布纵向：上侧 = 留白 + 标题带 + 格子块；下侧同理。两侧都留足，
      // 于是主骨落在「上方总高的下沿」，任何模块的格子都不可能越界。
      const topUp = PAD + TITLE_H + bhUp
      const topDn = PAD + TITLE_H + bhDn
      const spineY = topUp
      const totalH = topUp + topDn
      const totalW = MX + (mods.length + 1) * MSTEP + 120

      const svgKids = []
      // 主骨 + 鱼头（鱼头画在右端的圆 + 两个计数）
      svgKids.push(h('line', { key: 'spine', x1: MX, y1: spineY, x2: totalW - 120, y2: spineY,
        stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 2 }))
      svgKids.push(h('circle', { key: 'head', cx: totalW - 108, cy: spineY, r: HEAD_R,
        fill: 'var(--surface-2)', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1.5 }))
      svgKids.push(h('text', { key: 'headT', x: totalW - 108, y: spineY - 1,
        className: 'k8p', textAnchor: 'middle' }, '课程'))
      svgKids.push(h('text', { key: 'headT2', x: totalW - 108, y: spineY + 12,
        className: 'k8p', textAnchor: 'middle' }, '目标'))
      svgKids.push(h('text', { key: 'headK', x: totalW - 108, y: spineY + HEAD_R + 13,
        className: 'k8q', textAnchor: 'middle' },
        String(tree.totalLessons || 0) + ' 课时 · ' + mods.length + ' 模块'))

      blocks.forEach((L, mi) => {
        const x = MX + (mi + 1) * MSTEP
        const up = L.up
        const col = FISH_COLORS[mi % FISH_COLORS.length]
        // 格子块的 y 区间（本趟只看块本身，与主骨无关）
        const y0 = up ? (spineY - L.h) : (spineY + GAPB)
        const tip = up ? y0 : (y0 + L.h)          // 离主骨最远的那一端
        // 主刺：从主骨伸到格子块之外一点
        const spineEnd = up ? (tip - GAPB) : (tip + GAPB)
        svgKids.push(h('line', { key: 'v' + mi, x1: x, y1: spineY, x2: x, y2: spineEnd,
          stroke: col, strokeWidth: 2.5, strokeLinecap: 'round' }))
        // 模块标题：放在主刺远端之外（那里一定是空的）
        const titleY = up ? (spineEnd - 20) : (spineEnd + 16)
        svgKids.push(h('text', { key: 'mn' + mi, x: x, y: titleY,
          className: 'k8p', textAnchor: 'middle', fill: col },
          clipText(L.mod.name, 96, 11.5)))
        svgKids.push(h('text', { key: 'mr' + mi, x: x, y: titleY + 13,
          className: 'k8q', textAnchor: 'middle' },
          clipText((L.mod.range ? L.mod.range + ' · ' : '') + L.lessons.length + ' 课时', 112, 10.5)))
        // 格子：从块的内侧（贴主骨那端）往外排
        L.lessons.forEach((ls, li) => {
          const row = Math.floor(li / cols)
          const colI = li % cols
          const bx = x - CW / 2 + (colI - (cols - 1) / 2) * (CW + CG)
          const by = y0 + (up ? (L.h - GAPB - (row + 1) * CH - row * CG) : (row * (CH + CG)))
          const sel = selected === ls.no
          const label = String(ls.title || ('课时' + ls.no))
          svgKids.push(h('g', {
            key: 'l' + mi + '-' + li, className: 'k8y',
            'data-sel': sel ? '1' : '0', 'data-plan': ls.hasPlan ? '1' : '0',
            onClick: () => onPick(ls, L.mod),
          },
            h('rect', { className: 'k8z', x: bx, y: by, width: CW, height: CH, rx: 6, strokeWidth: 1 }),
            h('title', null, 'L' + ls.no + ' ' + label
              + (ls.hasPlan ? '' : '（教案未撰写）')
              + ((ls.knowledge && ls.knowledge.length) ? ('｜' + ls.knowledge.join(' / ')) : '')),
            h('text', { className: 'k8o', x: bx + 7, y: by + CH / 2 + 3.6 }, 'L' + ls.no),
            h('text', { className: 'k8q', x: bx + 30, y: by + CH / 2 + 3.6 },
              clipText(label, CW - 36, 11)),
            ls.hasPlan ? null : h('circle', { cx: bx + CW - 6, cy: by + 5, r: 2.6,
              fill: 'var(--dsw-alias-state-warn-primary)' })))
        })
      })

      return h('div', { className: 'k8m' },
        // data-* 把画布尺寸与几何挂出来：几何错误（重叠/越界）在浏览器里只表现为
        // 「图糊成一团」，靠肉眼看不出是哪几格，靠这些属性可以在校验脚本里直接断言。
        h('svg', { className: 'k8n', width: totalW, height: totalH,
          viewBox: '0 0 ' + totalW + ' ' + totalH, role: 'img', 'aria-label': '课程大纲鱼骨图',
          'data-fish-w': String(totalW), 'data-fish-h': String(totalH),
          'data-fish-geo': 'spineY=' + spineY + ' up=' + bhUp + ' dn=' + bhDn + ' cols=' + cols,
          'data-fish-chips': String(mods.reduce((a, m) => a + (m.lessons || []).length, 0)) }, svgKids),
        h('div', { className: 'k8r' },
          h('span', { className: 'k8s' },
            h('span', { className: 'k8t', style: { background: 'var(--surface-2)' } }), '已有教案'),
          h('span', { className: 'k8s' },
            h('span', { className: 'k8t', style: { background: 'var(--surface-2)' } }),
            h('span', { style: { width: 6, height: 6, borderRadius: 99, display: 'inline-block',
              background: 'var(--dsw-alias-state-warn-primary)' } }),
            '教案未撰写'),
          h('span', { className: 'k8s' },
            h('span', { className: 'k8t', style: { background: '#2f6feb', borderColor: '#2f6feb' } }), '当前选中'),
          h('span', { style: { marginLeft: 'auto' } }, '点任意课时 → 跳到「作业批改」')))
    }

/* ── 图片组件 ── */

function MediaImage({ src, name, boxStyle, st, set }) {
      const failed = st.brokenMedia && st.brokenMedia[name]
      if (failed) return h('div', { className: 'k55', style: boxStyle, title: failed }, h('b', null, '加载失败'), h('span', null, name))
      return h('img', { src: src, alt: name, style: boxStyle, onError: () => {
        const next = Object.assign({}, st.brokenMedia || {}); next[name] = '加载失败'; set({ brokenMedia: next })
      } })
    }

/* ── 框选成图（两端共用） ── */

async function cropToPng(wrapEl, slide, box, scale) {
      const diag = { imgs: 0, drawn: 0, texts: 0, reason: '' }
      // scale 默认 2（提问截图够用了）；「拍照提交」走 3 —— 手推公式的下标与
      // 分式在 2 倍下糊成一团，而模型看不清就等于没交。
      const k = scale || 2
      if (!wrapEl) { diag.reason = '视口节点为空'; return { dataUrl: null, diag: diag } }
      const slideEl = wrapEl.querySelector('.k17')
      if (!slideEl) { diag.reason = '未找到幻灯片节点'; return { dataUrl: null, diag: diag } }
      const imgs = Array.prototype.slice.call(slideEl.querySelectorAll('img'))
      const media = (slide.media || []).filter((m) => m.file)
      diag.imgs = imgs.length
      const pairs = []
      for (let i = 0; i < imgs.length && i < media.length; i += 1) pairs.push({ img: imgs[i], m: media[i] })
      for (const p of pairs) if (!p.img.complete) await new Promise((r) => { p.img.onload = r; p.img.onerror = r })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(box.w * k))
      canvas.height = Math.max(1, Math.round(box.h * k))
      const g = canvas.getContext('2d')
      if (!g) { diag.reason = '无法获取 2d 上下文'; return { dataUrl: null, diag: diag } }
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height)
      for (const p of pairs) {
        if (!p.img.naturalWidth) continue
        try {
          g.drawImage(p.img, (p.m.x - box.x) * k, (p.m.y - box.y) * k, p.m.w * k, p.m.h * k)
          diag.drawn += 1
        } catch (e) { /* 单张失败不影响整体 */ }
      }
      // 文字层
      for (const s of (slide.shapes || [])) {
        const t = String(s.text || '')
        if (!t.trim()) continue
        const ox = Math.max(0, Math.min(s.x + s.w, box.x + box.w) - Math.max(s.x, box.x))
        const oy = Math.max(0, Math.min(s.y + s.h, box.y + box.h) - Math.max(s.y, box.y))
        if (ox <= 0 || oy <= 0) continue
        const size = s.maxPt ? Math.max(9, Math.min(30, s.maxPt * 0.92)) : 13
        g.fillStyle = '#1a1a1a'
        g.font = (s.bold ? '600 ' : '') + (size * k) + 'px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif'
        g.textBaseline = 'top'
        g.save()
        g.beginPath()
        g.rect((s.x - box.x) * k, (s.y - box.y) * k, s.w * k, s.h * k)
        g.clip()
        // 逐行画：画布的 fillText 不换行，整段丢进去会只有一行
        const lineH = size * k * 1.32
        let y = (s.y - box.y) * k
        for (const line of t.split(/\r?\n/)) {
          g.fillText(line, (s.x - box.x) * k, y)
          y += lineH
        }
        g.restore()
        diag.texts += 1
      }
      if (!diag.drawn && !diag.texts) { diag.reason = '框内没有可画的内容'; return { dataUrl: null, diag: diag } }
      try { return { dataUrl: canvas.toDataURL('image/png'), diag: diag } }
      catch (e) { diag.reason = 'canvas 被跨源污染'; return { dataUrl: null, diag: diag } }
    }

/* ── 读文件为 dataURL ── */

function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result || ''))
        fr.onerror = () => reject(new Error('读文件失败：' + (file && file.name)))
        fr.readAsDataURL(file)
      })
    }

/* ── 递归读拖入的目录 ── */

async function readDirEntry(entry, prefix, out, depth) {
      if (!entry || depth > 8) return
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej))
        out.push({ file: f, relPath: (prefix ? prefix + '/' : '') + f.name })
        return
      }
      if (!entry.isDirectory) return
      const myPrefix = prefix ? (prefix + '/' + entry.name) : entry.name
      const reader = entry.createReader()
      // readEntries 一次只回一批（Chrome 上限 100 条），必须循环读到空。
      // 只读一次的话，大文件夹会被**静默截断**成前 100 个文件 —— 学生看到
      // 「已选 100 个」，而缺的那些没有任何提示。
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        if (!batch || !batch.length) break
        for (const e of batch) await readDirEntry(e, myPrefix, out, depth + 1)
      }
    }

/* ── 整理提交内容 ── */

async function collectIncoming(items, opts) {
      const o = opts || {}
      const maxFiles = Number(o.maxFiles) > 0 ? Number(o.maxFiles) : 40
      const maxOne = Number(o.maxOne) > 0 ? Number(o.maxOne) : 12 * 1024 * 1024
      const out = []
      const rejected = []
      for (const it of (items || [])) {
        if (!it) continue
        const f = it.file || it
        const rel = it.relPath || f.webkitRelativePath || f.name || 'file'
        if (out.length >= maxFiles) { rejected.push(rel + '（超过 ' + maxFiles + ' 个文件的上限）'); continue }
        if (f.size > maxOne) {
          rejected.push(rel + '（' + Math.round(f.size / 1024) + ' KB，超过单个文件上限 '
            + Math.round(maxOne / 1024) + ' KB）')
          continue
        }
        try {
          out.push({
            name: f.name || rel.split('/').pop(),
            relPath: String(rel).replace(/\\/g, '/'),
            dataUrl: await readFileAsDataUrl(f),
            bytes: f.size || 0,
          })
        } catch (e) { rejected.push(rel + '（读取失败）') }
      }
      return { files: out, rejected: rejected }
    }

/* ── 文件拖放区 ── */

function FileDrop(props) {
      const st = props.st || {}
      const set = props.set
      const disabled = props.disabled
      const k = props.dropKey || 'drop'
      const busy = st[k + 'Busy']
      const over = st[k + 'Over']
      const pick = (dir) => {
        if (disabled) return
        if (typeof document === 'undefined' || !document.createElement) return
        const el = document.createElement('input')
        el.type = 'file'
        el.multiple = true
        // 选文件夹：webkitdirectory 让浏览器把整棵目录树交出来，
        // 每个 File 自带 webkitRelativePath（含顶层目录名）。
        if (dir) el.setAttribute('webkitdirectory', '')
        el.style.display = 'none'
        el.onchange = async () => {
          try {
            const r = await collectIncoming(Array.from(el.files || []).map((f) => ({ file: f })), props)
            props.onFiles(r.files, r.rejected)
          } finally { if (el.parentNode) el.parentNode.removeChild(el) }
        }
        document.body.appendChild(el)
        el.click()
      }
      const onDrop = async (e) => {
        if (e && e.preventDefault) e.preventDefault()
        if (disabled) return
        if (set) set({ [k + 'Over']: false, [k + 'Busy']: true })
        const collected = []
        const rejected = []
        try {
          const dt = e && e.dataTransfer
          const raw = (dt && dt.items) ? Array.from(dt.items) : []
          const flat = []
          for (const it of raw) {
            if (it.kind !== 'file') continue
            // webkitGetAsEntry 是拿到「目录」的唯一途径；拿不到就按普通文件处理
            const en = (typeof it.webkitGetAsEntry === 'function') ? it.webkitGetAsEntry() : null
            if (en && en.isDirectory) { await readDirEntry(en, '', flat, 0); continue }
            if (en && en.isFile) {
              const f = await new Promise((res, rej) => en.file(res, rej))
              flat.push({ file: f, relPath: f.name })
              continue
            }
            const f = it.getAsFile && it.getAsFile()
            if (f) flat.push({ file: f, relPath: f.name })
          }
          const r = await collectIncoming(flat, props)
          collected.push.apply(collected, r.files)
          rejected.push.apply(rejected, r.rejected)
        } catch (err) {
          rejected.push('读取拖入内容失败：' + ((err && err.message) || err))
        }
        if (set) set({ [k + 'Busy']: false })
        props.onFiles(collected, rejected)
      }
      const stop = (e) => { if (e && e.stopPropagation) e.stopPropagation() }
      return h('div', {
        className: 'kd7', 'data-on': over ? '1' : '0',
        onClick: () => pick(false),
        onDragOver: (e) => { if (e && e.preventDefault) e.preventDefault(); if (set) set({ [k + 'Over']: true }) },
        onDragLeave: () => { if (set) set({ [k + 'Over']: false }) },
        onDrop: onDrop,
      },
        h('div', { className: 'kc9', style: { textAlign: 'center' } },
          busy ? '正在读取…' : (over ? '松手就放进来' : (props.title || '把文件或整个文件夹拖到这里'))),
        h('div', { className: 'kd1' }, props.hint
          || '也可以点下面按钮选文件；zip 会在服务端解开，里面的代码批改时能逐行读到。'),
        h('div', { className: 'kca', style: { justifyContent: 'center' } },
          h('button', {
            className: 'k42', disabled: disabled || busy,
            onClick: (e) => { stop(e); pick(false) },
          }, '选文件'),
          props.allowDir === false ? null : h('button', {
            className: 'k42', disabled: disabled || busy,
            onClick: (e) => { stop(e); pick(true) },
          }, '选文件夹')))
    }

/* ── 已选文件清单 ── */

function FileList(props) {
      const list = Array.isArray(props.files) ? props.files : []
      if (!list.length) return null
      const total = list.reduce((a, f) => a + (f.bytes || 0), 0)
      return h('div', null,
        h('div', { className: 'kce' },
          h('span', { className: 'k57' }, '已选 ' + list.length + ' 个文件 · ' + Math.round(total / 1024) + ' KB'),
          props.note ? h('span', { className: 'k57' }, props.note) : null),
        list.map((f, i) => h('div', { key: (f.relPath || f.name || '') + i, className: 'kd8' },
          h('span', { className: 'k57' }, f.relPath || f.name),
          h('span', { className: 'k57' }, Math.round((f.bytes || 0) / 1024) + ' KB'),
          props.onRemove ? h('button', { className: 'k42', onClick: () => props.onRemove(i) }, '移除') : null)))
    }

/* ── 预览框 ── */

function PreviewBox(props) {
      const has = !(props.children === undefined || props.children === null || props.children === '')
      return h('div', null,
        props.title ? h('div', { className: 'k64', style: { marginTop: 0 } }, props.title) : null,
        props.hint ? h('div', { className: 'kd1' }, props.hint) : null,
        h('div', { className: 'kd5', 'data-flat': props.flat ? '1' : '0' },
          has ? props.children : h('div', { className: 'k21' }, props.empty || '（还没有内容可预览）')))
    }

      return { ensureCss, css, h, bdg, pick, RailIcon, Markdown, markdownToHtml, loadKatex, Fishbone, OutlineFishbone, MediaImage, esc, MODULES, AI_LABEL, THREAD_LABEL, GRADE_LABEL, FLOW, SECTIONS, STATUS_COLOR, SEVERITY_COLOR, TYPES, SEVERITIES, FISH_COLORS, ZOOM_MIN, ZOOM_MAX, NL, readFileAsDataUrl, collectIncoming, FileDrop, FileList, PreviewBox, cropToPng }
    })()
  },
});

// DSH 在加载 dsh-course-core/client.js 时，要求该 bundle 至少注册出与包名一致的模块 id。
// 同时，学生端与教师端历史上一直通过 require('dsh-course-client-core') 取共享 UI 内核。
// 因此这里做“双注册”：
//   1. dsh-course-client-core：给两个面板继续消费
//   2. dsh-course-core：给 DSH 的 client-modules 作为合法客户端插件加载
window.__ModuleLoader__.load({
  id: 'dsh-course-core',
  factory: (require) => ({
    name: 'course-panel-core-client',
    apply() {
      // no-op: 共享 UI 内核已在同文件前半段注册为 dsh-course-client-core。
    },
  }),
});
