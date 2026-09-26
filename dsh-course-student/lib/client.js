/**
 * dsh-course-student —— 学生端客户端半区
 *
 * 学生端承担模型费用，所以这一侧的界面必须让三件事一眼可见：
 *   · 我这次提问/批改花了多少 token（额度页）
 *   · 哪些问题是「只属于我」的，哪些是老师公开给全班的
 *   · 追问每一轮都会真的调模型（不是「同上」）
 */
window.__ModuleLoader__.load({
  id: 'dsh-course-student',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const PANEL_ID = 'course-student'
    const API = '/cip-stu-api'
    const MEDIA = '/cip-stu-media'
    // 本面板自己的静态资源路径。**不能**写进共享内核 —— 那是个全页唯一的模块，
    // 谁先加载就把谁的前缀固化，另一个面板会拿到错的路由（教师面板去请求
    // /cip-stu-api，满屏「未知动作」）。所以这里自己持有，按调用点传进去。
    const CFG = {
      css: '/cip-stu.css', cssId: 'cip-stu-css',
      katex: '/cip-stu-katex', media: MEDIA,
    }

    const ui = require('dsh-course-client-core')
    const {
      ensureCss, css, h, bdg, Markdown, loadKatex, Fishbone, OutlineFishbone, MediaImage,
      STATUS_COLOR, SEVERITY_COLOR, ZOOM_MIN, ZOOM_MAX,
      MODULES, TYPES, SEVERITIES,
      // 文件提交 / 预览共用组件 —— 与教师端 require 到的是**同一份代码**
      FileDrop, FileList, PreviewBox, cropToPng,
    } = ui

    async function api(action, args) {
      const res = await fetch(API + '/' + encodeURIComponent(action), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      })
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch (e) {
        throw new Error('返回不是 JSON（HTTP ' + res.status + '，前 60 字：' + text.slice(0, 60).replace(/\s+/g, ' ') + '）')
      }
      // 「未知动作」只有一个成因：**宿主半区没重启**。改完宿主代码要重启 DSH，
      // 只刷新浏览器不够（客户端是即时生效的，宿主不是）。
      // 把这句话拼进错误里，是为了让它在界面上自己说清楚 ——
      // 否则看到的是一条很抽象的技术报错，得回来翻文档才知道要干什么。
      if (data && typeof data.error === 'string' && data.error.indexOf('未知动作') === 0) {
        throw new Error(data.error + ' —— 宿主半区没重启。改完宿主代码要重启 DSH（只刷新浏览器不够）。')
      }
      if (data && data.error) throw new Error(data.error)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return data
    }

    // 侧栏图标：对话气泡 + 问号，与教师端的图标区分开
    function StuIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9A1.5 1.5 0 0 1 18.5 16H11l-4.2 4v-4H5.5A1.5 1.5 0 0 1 4 14.5v-9Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M9.6 8.2a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.8.6-.8 1.1v.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 13.9, r: 0.95, fill: 'currentColor' }))
    }

    // ── 课件：框选一块图区，或拖选文字 ──
    /* ── 课件页：跨章节、跨页的「多块」收集 ──────────────────────────────
       为什么必须支持多块：一个知识点的推导经常横跨好几页（这一页给公式、
       下一页给直觉解释、再下一页给代码），只能框一块就等于逼学生把问题
       拆成三次提问，而拆开问出来的答案也不完整。

       设计要点：
       · 收集区是**数组**（st.picked），翻页/换章不清空 —— 这正是跨页的前提
       · 每块自己记住 chapter + page，所以「证据」能精确回指到哪一章哪一页
       · 框选模式下关掉文本选择（否则拖动会带出一片蓝色高亮，看着像内容被选中）
       · 收到块之后浮出「就此内容提问」，点它就跳到右侧提问区
    */
    const MAX_PICK = 6
    /** 多块证据拼起来的文字上限。受控是为了不让一次提问把上下文顶满
        （费用是学生自己出的，而「证据」只是辅助，问题本身才是主体）。 */
    const MAX_SUB_TEXT = 6000
    /** 错误信息压成一行，放进界面时不撑破布局 */
    function oneLineMsg(e) {
      return String((e && e.message) || e || '未知错误').replace(/\s+/g, ' ').slice(0, 120)
    }
    /** 几何取字：把与框重叠的形状文字拼起来。用几何而不是 DOM 选区，
        因为框选走的是 mousedown 拖拽，浏览器里根本没有产生 Selection。 */
    function textInBox(slide, box) {
      const hit = []
      for (const s of (slide.shapes || [])) {
        const ox = Math.max(0, Math.min(s.x + s.w, box.x + box.w) - Math.max(s.x, box.x))
        const oy = Math.max(0, Math.min(s.y + s.h, box.y + box.h) - Math.max(s.y, box.y))
        if (ox > 0 && oy > 0 && String(s.text || '').trim()) hit.push(s.text)
      }
      return hit.join('\n')
    }

    /** 把框内的内容画成一张 PNG（图片 + 文字都画）。
        ⚠️ 为什么必须真的截图：这门课的课件大量用「截图」代替公式和长篇论述，
           框内的文字常常是空的 —— 只把坐标和文字发给模型，等于什么都没给它。
        ⚠️ 为什么文字也要画：反过来也有纯文字的页（推导、结论），只画图片会得到一张白纸。
           两条都画，取到的那块才和学生在屏幕上看到的一致。
        scale=2：按 2 倍分辨率导出，公式里的角标才看得清。 */
    // cropToPng 已移入共享内核（dsh-course-client-core），从上面的解构里取。
    // 教师端「圈重点改教案」用的是同一份 —— 两端各留一份的后果不是重复，
    // 而是**画出来的图会不一样**（改了坐标换算只改一边），而截图是喂给模型的证据。

    function pickLabel(p) {
      if (p.kind === 'page') return p.chapter + ' 第 ' + p.page + ' 页 · 整页'
      if (p.kind === 'text') {
        const t = String(p.text || '').replace(/\s+/g, ' ').trim()
        return p.chapter + ' 第 ' + p.page + ' 页 · ' + (t.length > 18 ? t.slice(0, 18) + '…' : t)
      }
      return p.chapter + ' 第 ' + p.page + ' 页 · 图区 ' + Math.round(p.box.w) + '×' + Math.round(p.box.h)
    }

    function Slides({ st, set, onAddPick, pageHasPick, slideRef }) {
      const data = st.slides
      const wrapRef = React.useRef(null)
      // 把视口节点交给面板：整页截图要用它做裁剪。
      // ⚠️ 不能用 document.querySelector('.k0') —— 学生端与教师端可能同时挂在同一个
      //    页面上，那样会截到**教师面板**的课件，而且看起来「截图成功了」。
      React.useEffect(() => {
        if (slideRef) slideRef.current = wrapRef.current
        return () => { if (slideRef) slideRef.current = null }
      })
      if (!data || !data.slides || !data.slides.length) return h('div', { className: 'k21' }, '课件未加载')
      const idx = Math.min(Math.max(0, st.slideIndex || 0), data.slides.length - 1)
      const slide = data.slides[idx]
      const zoom = st.zoom || 1
      const W = data.slideWidth
      const H = data.slideHeight
      const picks = asPicks(st.picked)
      const pagePicks = picks.filter((p) => p.chapter === st.chapter && p.page === slide.index)

      const pos = (ev) => {
        const r = wrapRef.current.getBoundingClientRect()
        const k = r.width / W
        return { x: (ev.clientX - r.left) / k, y: (ev.clientY - r.top) / k }
      }
      const onDown = (ev) => {
        if (st.mode !== 'region' || ev.button !== 0 || !wrapRef.current) return
        const p = pos(ev)
        set({ dragging: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } })
      }
      const onMove = (ev) => {
        if (!st.dragging || !wrapRef.current) return
        const p = pos(ev)
        set({ dragging: Object.assign({}, st.dragging, { x1: p.x, y1: p.y }) })
      }
      const onUp = () => {
        const d = st.dragging
        if (!d) return
        const box = {
          x: Math.max(0, Math.min(d.x0, d.x1)), y: Math.max(0, Math.min(d.y0, d.y1)),
          w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
        }
        set({ dragging: null })
        if (box.w < 8 || box.h < 8) return
        addPick({ kind: 'region', box: box, chapter: st.chapter, page: slide.index, text: textInBox(slide, box) })
      }
      /** 拖选文字模式：用浏览器自己的选区，取文字 + 位置。
          与框选的区别是「用鼠标划过的文字」，所以文字一定非空 ——
          这条路正是给「教案式长文」用的（用户可以拖选一整段）。 */
      const onTextUp = () => {
        if (st.mode !== 'text' || !wrapRef.current) return
        let sel = null
        try { sel = window.getSelection() } catch (e) { sel = null }
        if (!sel || sel.isCollapsed || !String(sel.toString() || '').trim()) return
        const text = String(sel.toString()).trim()
        let box = null
        try {
          const rect = sel.getRangeAt(0).getBoundingClientRect()
          const wr = wrapRef.current.getBoundingClientRect()
          const kz = wr.width / W
          box = { x: (rect.left - wr.left) / kz, y: (rect.top - wr.top) / kz, w: rect.width / kz, h: rect.height / kz }
        } catch (e) { box = null }
        addPick({ kind: 'text', text: text, box: box, chapter: st.chapter, page: slide.index })
      }
      /** 统一的入队口：截好小图再入队（拿不到就退化成纯坐标/文字，不阻断提问） */
      const addPick = async (snip) => {
        const box = snip.box || { x: 0, y: 0, w: W, h: H }
        let dataUrl = null
        let note = ''
        try {
          const r = await cropToPng(wrapRef.current, slide, box, 2)
          dataUrl = r.dataUrl
          if (!dataUrl) note = r.diag.reason || '截图失败'
        } catch (e) { note = '截图异常：' + oneLineMsg(e) }
        const full = Object.assign({}, snip, { box: box, dataUrl: dataUrl, note: note })
        full.label = pickLabel(full)
        if (onAddPick) onAddPick(full)
      }

      const dragging = st.dragging
      const dragBox = dragging ? {
        left: Math.min(dragging.x0, dragging.x1), top: Math.min(dragging.y0, dragging.y1),
        width: Math.abs(dragging.x1 - dragging.x0), height: Math.abs(dragging.y1 - dragging.y0),
      } : null

      return h('div', { className: 'ka4' },
        h('div', { className: 'k20', style: { marginBottom: 0 } },
          h('button', { className: 'k42', onClick: () => set({ slideIndex: Math.max(0, idx - 1), dragging: null }) }, '← 上一页'),
          h('span', { className: 'k57' }, st.chapter + ' ' + slide.index + ' / ' + data.slides.length),
          h('button', { className: 'k42', onClick: () => set({ slideIndex: Math.min(data.slides.length - 1, idx + 1), dragging: null }) }, '下一页 →'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k43', 'data-on': st.mode === 'region' ? '1' : '0', onClick: () => set({ mode: 'region' }) }, '框选图区'),
          h('span', { className: 'k43', 'data-on': st.mode === 'text' ? '1' : '0', onClick: () => set({ mode: 'text' }) }, '拖选文字'),
          h('button', { className: 'k42', onClick: () => set({ zoom: Math.max(ZOOM_MIN, zoom / 1.25) }) }, '－'),
          h('button', { className: 'k42', onClick: () => set({ zoom: Math.min(ZOOM_MAX, zoom * 1.25) }) }, '＋'),
          h('span', { className: 'k57' }, st.mode === 'region' ? '在页面上拖一个框（可跨页连续收集）' : '选中文字后点浮出的按钮')),
        // 跨页收集的页码导航：有收集内容的页标出来，点一下直接跳过去。
        // 没有它的话，「我到底在哪几页收过东西」只能靠翻页找。
        picks.length ? h('div', { className: 'ka9', style: { marginTop: '6px' } },
          h('span', { className: 'k57' }, '已收集 ' + picks.length + ' 块 · 跳回：'),
          h('div', { className: 'kb0' }, data.slides.filter((s) => pageHasPick && pageHasPick(s.index)).map((s) => h('button', {
            key: 'pg' + s.index, className: 'kb1', 'data-has': '1',
            title: picks.filter((p) => p.page === s.index).map((p) => p.label).join('\n'),
            onClick: () => set({ slideIndex: s.index - 1, dragging: null }),
          }, String(s.index))))) : null,
        h('div', {
          ref: wrapRef, className: 'k0', 'data-mode': st.mode === 'region' ? 'region' : 'text',
          style: { width: (W * zoom) + 'px', height: (H * zoom) + 'px' },
          onMouseDown: onDown, onMouseMove: onMove, onMouseUp: () => { onUp(); onTextUp() }, onMouseLeave: onUp,
        },
          h('div', { className: 'k17', style: { width: W + 'px', height: H + 'px', transform: 'scale(' + zoom + ')', transformOrigin: '0 0' } },
            slide.shapes.map((s, i) => h('div', {
              key: 's' + i, className: 'k47',
              style: css('left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px;font-size:' + (s.maxPt ? Math.max(9, Math.min(30, s.maxPt * 0.92)) : 13) + 'px;font-weight:' + (s.bold ? 600 : 400) + ';'),
            }, s.text)),
            (slide.media || []).map((m, i) => {
              const bs = css('left:' + m.x + 'px;top:' + m.y + 'px;width:' + m.w + 'px;height:' + m.h + 'px;')
              if (!m.file) return h('div', { key: 'm' + i, className: 'k55', style: bs }, h('b', null, '图片不可用'), h('span', null, m.name))
              // 路由在这里拼：宿主返回的是**裸文件名**。它曾经自己拼过一次前缀，
              // 两边各拼一次 → /cip-stu-media/第一章//cip-stu-media/第一章/x.png → 400，
              // 表现就是「所有图片都加载不出来」。
              const src = MEDIA + '/' + encodeURIComponent(st.chapter) + '/' + encodeURIComponent(m.file)
              return h(MediaImage, { key: 'm' + i, src, name: m.name, boxStyle: bs, st, set })
            }),
            // 本页已收集的框：虚线 + 编号，与「正在拖」的实线框区分开
            pagePicks.map((p, i) => p.kind === 'region' ? h('div', {
              key: 'pk' + i, className: 'ka7',
              style: css('left:' + p.box.x + 'px;top:' + p.box.y + 'px;width:' + p.box.w + 'px;height:' + p.box.h + 'px;'),
            }, h('span', { className: 'ka8' }, '已收集 ' + (picks.indexOf(p) + 1))) : null),
            dragBox ? h('div', { className: 'k48', style: css('left:' + dragBox.left + 'px;top:' + dragBox.top + 'px;width:' + dragBox.width + 'px;height:' + dragBox.height + 'px;') }) : null,
            // 「就此内容提问」：始终显示在页面上（不是选中后才出现，否则学生不知道有这个入口）。
            // 已有收集 → 直接去提问区写问题；没有收集 → 就把本页整页截下来作为证据。
            h('button', {
              className: 'ka6',
              style: css('right:10px;bottom:10px;'),
              title: picks.length ? '就已收集的 ' + picks.length + ' 块内容提问' : '还没有收集内容，点这里把本页整页作为证据',
              onClick: async () => {
                set({ qMode: 'ask' })
                if (!picks.length) {
                  await addPick({ kind: 'page', chapter: st.chapter, page: slide.index,
                    box: { x: 0, y: 0, w: W, h: H }, text: textInBox(slide, { x: 0, y: 0, w: W, h: H }) })
                }
              },
            }, '就此内容提问'),
            // 「用作作业照片」：作业里常有「手推公式」，而课件上正好有那个公式。
            // 从这里取材比拍照更准，也不需要摄像头权限。它会跳到课时页，
            // 由面板按 3 倍分辨率重裁一次（页面上的这块是缩放后的，直接截会糊）。
            h('button', {
              className: 'ka6', style: css('right:118px;bottom:10px;'),
              title: '把这一块作为作业照片（跳到课时作业）',
              onClick: () => {
                set({ cameraShot: true, cameraOpen: false })
              },
            }, '用作作业照片'),
            st.cameraShot ? h('div', { className: 'ka4 kbe' },
              '取材模式：在页面上框一块 → 自动跳回课时作业并截成照片') : null)))
    }

    // ── 提问区（右侧常驻列）──────────────────────────────────────────────
    /**
     * 为什么从「底部一条」改成「右侧一列」：
     *   原来它挂在滚动视口 .k27 的底部，一选中内容就和课件互相挤，
     *   三个下拉框被压成竖排。提问是这个面板的主要动作，值一个固定宽度的列。
     */
    function AskPanel({ st, set, onAsk, onRemovePick, onClearPicks }) {
      const picks = asPicks(st.picked)
      const canAsk = !st.asking && (String(st.q || '').trim().length > 0)
      return h('div', { className: 'k92' },
        h('div', { className: 'k93' },
          h('span', { className: 'k94' }, '就选中的内容提问'),
          h('span', { className: 'k54' }),
          picks.length ? h('button', { className: 'k42', onClick: onClearPicks, title: '清空已收集的内容' }, '清空') : null),
        h('div', { className: 'k95' },
          picks.length ? h('div', { className: 'k97' }, picks.map((p, i) => h('div', { key: 'p' + i, className: 'k98' },
            h('span', { className: 'k99' }, String(i + 1)),
            h('span', { className: 'ka0', title: p.label + (p.text ? ('\n\n' + p.text.slice(0, 200)) : '') }, p.label),
            h('button', { className: 'ka1', title: '移除这一块', onClick: () => onRemovePick(i) }, '×'))))
            : h('div', { className: 'ka2' },
              h('div', null, h('b', null, '① 在左边课件上框选一块')),
              h('div', null, '② 翻到别的页/别的章节继续框（可以攒 ' + MAX_PICK + ' 块）'),
              h('div', null, '③ 回到这里写问题 → 提交')),
          h('label', { className: 'ka3' },
            h('input', {
              type: 'checkbox', checked: st.pageWide === true,
              onChange: (e) => set({ pageWide: e.target.checked }),
            }),
            '同时附上当前整页截图（有些推导要看整页才完整）'),
          // 选了不支持图片的模型、却收了截图 —— 必须**提交前**说。
          // 事后才提示等于让学生白花一次钱，而且他会以为「截图提问坏了」。
          (st.modelVision === false && picks.length)
            ? h('div', { className: 'k52 k53' },
              '当前模型不支持图片：这次会把 ' + picks.filter((p) => p.dataUrl).length
              + ' 张截图降级成「位置 + 文字」发给它。想让它真的看到图，请在右上角换一个标着「可看图」的模型。')
            : null),
        h('div', { className: 'k96' },
          h('textarea', {
            className: 'k60', rows: 4, placeholder: '你想问什么？比如：这个 NLL 到平均损失的变形为什么要除以 N？',
            value: st.q || '', onChange: (e) => set({ q: e.target.value }),
          }),
          h('div', { className: 'k66' },
            h('select', { className: 'kcc', value: st.f.module, onChange: (e) => set({ f: Object.assign({}, st.f, { module: e.target.value }) }) }, MODULES.map((x) => h('option', { key: x, value: x }, x))),
            h('select', { className: 'kcc', value: st.f.type, onChange: (e) => set({ f: Object.assign({}, st.f, { type: e.target.value }) }) }, TYPES.map((x) => h('option', { key: x, value: x }, x))),
            h('select', { className: 'kcc', value: st.f.severity, onChange: (e) => set({ f: Object.assign({}, st.f, { severity: e.target.value }) }) }, SEVERITIES.map((x) => h('option', { key: x, value: x }, x))),
            h('input', { className: 'kcc', placeholder: '课时号', value: st.f.lesson, onChange: (e) => set({ f: Object.assign({}, st.f, { lesson: e.target.value }) }) })),
          h('button', { className: 'k42 k11', disabled: !canAsk, onClick: onAsk, style: { width: '100%', padding: '7px 12px' } },
            st.asking ? 'AI 作答中…' : ('提交提问' + (picks.length ? '（' + picks.length + ' 块证据）' : ''))),
          h('div', { className: 'k57' }, '提交后会：① 凝练一句统一风格的标题 ② AI 作答 ③ 生成问题总结。之后每一轮追问都会重新调用模型，费用记在你自己账号上。')))
    }

    // ── 问答详情：完整多轮 + 教师答复 + 继续追问 ──
    function ThreadView({ st, set, onFollowup }) {
      const t = st.thread
      if (!t) return h('div', { className: 'k21' }, '从左边选一条提问。')
      const turns = t.turns || []
      const teacherTurns = turns.filter((x) => x.by === 'teacher')
      return h('div', { className: 'k46' },
        h('div', { className: 'k10' }, t.fields.title || '(无标题)'),
        h('div', { className: 'k70' },
          bdg(t.fields.lesson || '未标注', 'var(--dsw-alias-bg-layer-1)'),
          bdg(t.fields.severity || '中', SEVERITY_COLOR[t.fields.severity] || 'gray'),
          bdg(t.fields.status || '', STATUS_COLOR[t.fields.status] || 'gray'),
          t.fields.audit === 'shared' ? bdg('已公开给全班', 'var(--dsw-alias-state-success-primary)') : bdg('仅我可见', 'var(--dsw-alias-label-secondary)'),
          teacherTurns.length ? bdg('教师已答复', 'var(--dsw-alias-brand-primary)') : null,
          t.fields.tokens ? h('span', { className: 'k57' }, 'tokens ' + t.fields.tokens) : null),
        t.fields.summary ? h('div', { className: 'k58' }, '总结：' + t.fields.summary) : null,
        // 教师答复单独提到最前面 —— 它是老师写的，可信度和 AI 草稿不是一个级别，
        // 埋在几十轮对话里等于没有。这是学生最该先看的东西。
        teacherTurns.length ? h('div', { className: 'kcb' },
          h('div', { className: 'k64' }, '教师答复（' + teacherTurns.length + ' 条）'),
          teacherTurns.map((x, i) => h('div', { key: 'tt' + i, className: 'k58' },
            h(Markdown, { text: x.a || '' }),
            h('div', { className: 'k57' }, (x.author ? ('—— ' + x.author) : '—— 老师') + (x.at ? (' · ' + String(x.at).slice(0, 10)) : ''))))) : null,
        h('div', { className: 'k64' }, '完整问答（AI ' + (turns.length - teacherTurns.length + 1) + ' 轮' + (teacherTurns.length ? (' + 教师 ' + teacherTurns.length) : '') + '）'),
        h(Markdown, { text: t.body || '' }),
        t.fields.audit === 'shared'
          ? h('div', { className: 'k57' }, '这条已被老师标为「值得共享」，全班都能看到完整问答。')
          : h('div', { className: 'k57' }, '这条目前只有你能看到。老师审核后才可能共享给全班。'),
        h('div', { className: 'k51', style: { marginTop: '10px' } },
          h('div', { className: 'k58' }, '继续追问',
            h('span', { className: 'k54' }),
            h('span', { className: 'k57' }, '已 ' + turns.length + ' 轮 · 每一轮都真的调模型，不会说「同上」')),
          h('div', { className: 'k96', style: { borderTop: 'none' } },
            // 追问与首次提问用**同一个** AttachComposer：文本 / 文件 / 图片（可粘贴）。
            // 用户明确要求追问也要支持多种方式上传 —— 而且这里不复制一份代码，
            // 复制出来的那份迟早和主提问漂移。
            h(AttachComposer, {
              tab: st.fuTab || 'text', setTab: (v) => set({ fuTab: v }),
              text: st.followup || '', setText: (v) => set({ followup: v }),
              files: st.fuFiles || [], setFiles: (v) => set({ fuFiles: v }),
              images: st.fuImages || [], setImages: (v) => set({ fuImages: v }),
              allowPick: false,
              rows: 3,
              placeholder: '再问一轮：可以打字，也可以直接 Ctrl+V 粘贴截图，或选文件。',
            }),
            h('div', { className: 'k20', style: { marginBottom: 0 } },
              h('button', {
                className: 'k42 k11',
                disabled: st.asking || (!(st.followup || '').trim() && !(st.fuFiles || []).length && !(st.fuImages || []).length),
                onClick: () => onFollowup(t.path, st.followup || '', st.fuFiles || [], st.fuImages || []),
              }, st.asking ? 'AI 作答中…' : '发送追问'),
              h('span', { className: 'k57' },
                ((st.fuFiles || []).length + (st.fuImages || []).length)
                  ? ('附带 ' + ((st.fuFiles || []).length + (st.fuImages || []).length) + ' 个文件/图片')
                  : '这一轮也会重新作答并计入你的额度')))))
    }

    // ── 公开问答：老师策展后给全班看的那一份 ──
    function PublicQA({ st, set, onOpen, onSync }) {
      const idx = st.publicIdx
      if (!idx) return h('div', { className: 'k21' }, '公开问答加载中…')
      const items = idx.items || []
      const s = st.syncResult
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '老师公开给全班的问题（' + items.length + ' 条）'),
        h('div', { className: 'k57' }, '来源：' + idx.source + (idx.generatedAt ? (' · 生成于 ' + String(idx.generatedAt).slice(0, 19)) : '')
          + ' · 其中 ' + (idx.withTeacherAnswer || 0) + ' 条有教师答复'),
        h('div', { className: 'k57' }, '这份清单只含老师审核后公开的问题。别人私有的提问不在其中，也不会出现在这个仓库的任何地方。'),
        // 老师公开了新内容、推上去了，本地这份不会自动变 —— 要有拉取动作，
        // 否则「学生能看到老师公开的问答」只是理论上的。
        h('div', { className: 'kca' },
          h('button', { className: 'k42', disabled: st.busy, onClick: onSync }, st.busy ? '拉取中…' : '从远端拉取更新'),
          h('span', { className: 'k57' }, '只做 git pull --ff-only：快进合并，不会产生 merge commit，也不会动你自己的提问与作业（它们在 .gitignore 里）')),
        s ? h('div', { className: 'kc7' },
          h('div', { className: 'k64' }, s.ok ? (s.changed ? ('已更新 ' + s.before + ' → ' + s.after) : '已经是最新的') : ('拉取失败：' + s.error)),
          s.hint ? h('div', { className: 'k57' }, s.hint) : null,
          s.detail ? h('pre', { className: 'k63', style: { maxHeight: '160px', overflow: 'auto' } }, s.detail) : null) : null,
        items.length ? items.map((it) => h('div', {
          key: it.path, className: 'kd9', onClick: () => onOpen(it.path),
        },
          h('div', { className: 'k64', style: { margin: 0 } }, it.title),
          it.summary ? h('div', { className: 'k57' }, it.summary) : null,
          h('div', { className: 'k70' },
            bdg(it.lesson || '未标注', 'var(--dsw-alias-bg-layer-1)'),
            it.severity ? bdg(it.severity, SEVERITY_COLOR[it.severity] || 'gray') : null,
            it.hasTeacherAnswer ? bdg('有教师答复', 'var(--dsw-alias-brand-primary)') : null,
            h('span', { className: 'k57' }, it.created || '')))) : h('div', { className: 'k21' }, '老师还没有公开任何问题'))
    }

    // ── 问题列表：我的 / 已公开 ──
    function ThreadList({ st, set, onOpen, onShare, onShareBatch }) {
      const mine = st.mine || []
      const pub = st.publicItems || []
      const sharedCount = mine.filter((x) => x.audit === 'shared').length
      const selectable = mine.filter((x) => x.scope !== 'legacy')
      /**
       * 一行。
       *
       * 「公开」必须在这里能操作：作业批改一次判出十几条问题，原来全部自动流向
       * 教师端 —— 老师那边堆到 76 条根本看不过来，而且大多是同一份代码的细节。
       * 现在默认只在学生自己这里，他逐条决定哪些值得问老师。
       * 点行本身是打开详情，所以勾选框与按钮都要 stopPropagation。
       */
      const row = (it) => {
        const shared = it.audit === 'shared'
        return h('div', {
          key: it.path, className: 'kd9', 'data-sel': st.selPath === it.path ? '1' : '0',
          onClick: () => onOpen(it.path),
        },
          h('div', { className: 'k20', style: { marginBottom: '3px', alignItems: 'flex-start' } },
            h('input', {
              type: 'checkbox', checked: !!((st.selItems || {})[it.path]), title: '勾选后可批量公开 / 撤回',
              style: { marginTop: '3px', flex: '0 0 auto' },
              onClick: (e) => { e.stopPropagation() },
              onChange: () => {
                const next = Object.assign({}, st.selItems || {})
                if (next[it.path]) delete next[it.path]; else next[it.path] = true
                set({ selItems: next })
              },
            }),
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { className: 'k64', style: { margin: 0 } }, it.title)),
            h('button', {
              className: 'k42' + (shared ? ' kbf' : ''), style: { flex: '0 0 auto', padding: '2px 8px' },
              title: shared ? '撤回：老师不再看到这一条' : '公开：让老师看到这一条（批改自动生成的问题默认不公开）',
              onClick: (e) => { e.stopPropagation(); onShare(it.path, !shared) },
            }, shared ? '已公开' : '公开给老师')),
          h('div', { className: 'k70' },
            bdg(it.lesson || '未标注', 'var(--dsw-alias-bg-layer-1)'),
            bdg(it.severity || '中', SEVERITY_COLOR[it.severity] || 'gray'),
            it.source === '作业' ? bdg('批改生成', 'var(--dsw-alias-state-warn-primary)') : null,
            it.hasTeacherAnswer ? bdg('教师已答复', 'var(--dsw-alias-brand-primary)') : null,
            it.turns ? bdg(it.turns + ' 轮追问', 'var(--dsw-alias-bg-layer-1)') : null,
            h('span', { className: 'k57' }, it.created || '')))
      }
      const pickedPaths = Object.keys(st.selItems || {})
      return h('div', { className: 'k67' },
        h('div', { className: 'k57', style: { padding: '0 4px 6px', lineHeight: '1.7' } },
          '批改会一次判出十几条问题，它们默认**不公开**、只留在你这里。哪些值得问老师，由你自己公开。'),
        h('div', { className: 'k64' }, '我的提问（' + mine.length + ' · 已公开 ' + sharedCount + '）'),
        h('div', { className: 'k20' },
          h('button', { className: 'k42', disabled: !pickedPaths.length, onClick: () => onShareBatch(pickedPaths, true) },
            '公开勾选的 ' + pickedPaths.length + ' 条'),
          h('button', { className: 'k42', disabled: !pickedPaths.length, onClick: () => onShareBatch(pickedPaths, false) },
            '撤回勾选'),
          h('button', {
            className: 'k42', disabled: !selectable.length,
            onClick: () => set({ selItems: selectable.reduce((a, x) => { a[x.path] = true; return a }, {}) }),
          }, '全选待处理的 ' + selectable.length + ' 条'),
          pickedPaths.length ? h('button', { className: 'k42', onClick: () => set({ selItems: {} }) }, '清空选择') : null),
        mine.length ? mine.map(row) : h('div', { className: 'k21' }, '还没有提问'),
        h('div', { className: 'k64' }, '老师公开给全班的（' + pub.length + '）'),
        pub.length ? pub.map((x) => h('div', { key: x.path, className: 'kd9', onClick: () => onOpen(x.path) },
          h('div', { className: 'k64', style: { margin: 0 } }, x.title),
          h('div', { className: 'k70' },
            bdg('全班可见', 'var(--dsw-alias-state-success-primary)'),
            h('span', { className: 'k57' }, x.created || ''))))
          : h('div', { className: 'k21' }, '暂时没有已公开的问题'))
    }

    // ── 课时页：教案 + 作业批改 + 提交历史 ────────────────────────────────
    /**
     * 这一页回答三个问题（也是用户提的三条需求）：
     *   ① 「批改以教案为基准，可我看不到教案」→ 教案正文直接铺在这里（只读）
     *   ② 「作业类型很多，手推公式拍照最方便」→ 提交支持 文字 / 文件 / 拍照 三种
     *   ③ 「改完要能再传，还要能回看历史」→ 每次提交是一个版本，历史全部保留
     *
     * 为什么 ①②③ 必须在同一页：它们互相依赖 —— 看不到教案就不知道该改什么，
     * 看不到历史就不知道改过几版。拆成三个页面会让学生来回跳。
     */
    const MAX_HW_FILES = 6
    /**
     * 本地开发时常遇到「改完客户端、没重启宿主」——此时新动作会返回
     * 「未知动作：xxx」，而界面只会把它当成一次普通失败。这句话直接写清楚原因与动作，
     * 省掉一轮「是不是代码写错了」的排查。
     */
    function apiErrorHint(msg) {
      const s = String(msg || '')
      if (s.indexOf('未知动作') >= 0 || s.indexOf('404') >= 0) {
        return s + '（这个动作在**宿主半区**里，需要重启 DSH 才会出现；只刷新浏览器不够）'
      }
      return s
    }
    const fmtTime = (iso) => {
      try {
        const d = new Date(iso)
        if (isNaN(d.getTime())) return String(iso || '').slice(0, 16).replace('T', ' ')
        const p = (n) => (n < 10 ? '0' + n : String(n))
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
      } catch (e) { return '' }
    }
    /**
     * 批改维度取名字。索引里它是 {key, name, desc} 对象，也允许是纯字符串。
     * 这个函数存在的理由：第一版只写了 `typeof d === 'string' ? d : d.name`，
     * 服务端那份有兜底、客户端这份漏了 → 界面上 5 个空胶囊。
     */
    function dimName(d) {
      if (typeof d === 'string') return d
      if (d && typeof d === 'object') return String(d.name || d.key || d.desc || '') || '未命名维度'
      return String(d == null ? '' : d)
    }
    const fmtBytes = (n) => {
      const v = Number(n) || 0
      return v >= 1024 * 1024 ? (v / 1024 / 1024).toFixed(1) + ' MB' : (v >= 1024 ? Math.round(v / 1024) + ' KB' : v + ' B')
    }

    /**
     * 读「课件上收集到的证据块」。**永远返回数组**。
     *
     * 为什么要有这个函数：picked 曾经被两处当成不同形状用 ——
     *   课件页：Array<证据块>      我的提问：{[path]: true} 勾选映射
     * 于是「在我的提问里勾了几条 → 切到课件页」直接崩：
     *   TypeError: picks.filter is not a function
     * 这类「同一个键两种形状」的错在浏览器里只会表现为整页红屏，
     * 定位成本很高。现在两个语义各用各的键（picked / selItems），
     * 并且读取一律经过这里 —— 万一还遇到形状不对的残留状态，也只是空列表，不会崩。
     */
    function asPicks(v) { return Array.isArray(v) ? v : [] }
    /** 把一个 pending 数据对象转成版本卡片要显示的样子 */
    function pendingView(p) {
      if (!p) return null
      const cols = (p.slides && p.slides.slideWidth) ? p.slides.slideWidth : 1280
      const box = { x: 0, y: 0, w: cols, h: (p.slides && p.slides.slideHeight) || 720 }
      return {
        kind: 'pending', shot: true,
        chapter: p.chapter || '', page: p.page || 1, box: box,
        slideIndex: Math.max(0, (p.page || 1) - 1),
        text: p.text || '',
        files: (p.files || []).map((f) => ({ name: f.name, bytes: f.bytes, image: f.image, thumb: f.image ? f.dataUrl : null })),
      }
    }

    /**
     * ── 附件输入（三个页签：打字 / 文件 / 图片）────────────────────────
     *
     * 用户明确要求：**提问与追问都要支持文本、图片、文件**。
     * 与其在两处各写一遍，不如抽成一个组件 —— 两边各写一份必然会漂移
     * （这个项目已经因为「客户端与宿主对同一个字段理解不一致」栽过一次）。
     *
     * 它是**受控组件**：状态在调用方，这里只负责渲染与交互。
     * `onShot` 可选：给了才显示「课件取材」（提问里有课件上下文，追问里没有）。
     */
    function AttachComposer({ tab, setTab, text, setText, files, setFiles,
      images, setImages, onShot, allowPick, placeholder, rows, minHeight }) {
      const [err, setErr] = React.useState('')
      const fileInputRef = React.useRef(null)
      React.useEffect(() => { setErr('') }, [tab])

      /** 读成 data URL。图片与文件走同一条路，靠 MIME 区分。 */
      const addFiles = React.useCallback((list) => {
        const incoming = Array.prototype.slice.call(list || [])
        for (const f of incoming) {
          if (f.size > 8 * 1024 * 1024) { setErr('「' + f.name + '」超过 8 MB，请压缩后再传'); continue }
          const isImg = /^image\//.test(f.type || '')
          const rd = new FileReader()
          rd.onload = () => {
            const item = { name: f.name, bytes: f.size, mediaType: f.type || '', image: isImg, dataUrl: String(rd.result || '') }
            if (isImg) setImages((prev) => (prev.length >= MAX_HW_FILES ? prev : prev.concat([item])))
            else setFiles((prev) => (prev.length >= MAX_HW_FILES ? prev : prev.concat([item])))
          }
          rd.onerror = () => setErr('读取「' + f.name + '」失败')
          rd.readAsDataURL(f)
        }
      }, [setFiles, setImages])

      // 粘贴即上传：截图（公式、报错）直接 Ctrl+V，比先存盘再选文件快得多。
      // 挂在容器上（不是 document），避免影响面板别处。
      const onPaste = React.useCallback((ev) => {
        const items = (ev.clipboardData && ev.clipboardData.items) || []
        const picked = []
        for (let i = 0; i < items.length; i += 1) if (items[i].kind === 'file') picked.push(items[i].getAsFile())
        if (!picked.length) return
        ev.preventDefault()
        addFiles(picked.filter(Boolean).map((f, i) => f || new File([], 'paste-' + i + '.png')))
        setTab('image')
      }, [addFiles, setTab])

      const tabs = [
        { id: 'text', label: '打字' },
        { id: 'file', label: '文件' },
        { id: 'image', label: '图片' },
      ]
      if (allowPick && onShot) tabs.push({ id: 'pick', label: '课件取材' })

      /** 已选附件的小胶囊列表。写成普通函数免得嵌套括号数不清（这次数错了两次）。 */
      function chip(arr, setArr, prefix) {
        if (!arr.length) return null
        return h('div', { className: 'k97', style: { marginTop: '6px' } },
          arr.map(function (f, i) {
            return h('div', { key: prefix + i, className: 'k98' },
              h('span', { className: 'ka0', title: f.name }, f.name),
              h('span', { className: 'k57' }, fmtBytes(f.bytes || 0)),
              h('button', {
                className: 'ka1', title: '移除',
                onClick: function () { setArr(arr.filter(function (x, j) { return j !== i })) },
              }, '×'))
          }))
      }

      return h('div', { onPaste: onPaste },
        h('div', { className: 'k24' },
          tabs.map((t) => h('span', {
            key: t.id, className: 'k43', 'data-on': tab === t.id ? '1' : '0', onClick: () => setTab(t.id),
          }, t.label)),
          h('span', { className: 'k54' }),
          h('span', { className: 'k57', style: { alignSelf: 'center' } }, '也可以直接 Ctrl+V 粘贴截图')),
        tab === 'text'
          ? h('textarea', {
            className: 'k60', rows: rows || 4, placeholder: placeholder || '写点什么…',
            value: text, onChange: (e) => setText(e.target.value),
          })
          : null,
        (tab === 'file' || tab === 'image') ? h('div', null,
          tab === 'file'
            // 文件页签用**两端共用**的 FileDrop（见 dsh-course-client-core）：
            // 老师投材料用的是同一个组件，所以「怎么选文件」在两边是同一种操作。
            // 它比一个裸 <input type=file> 多两件事：
            //   · 选**整个文件夹**（作业常常是一个项目目录）
            //   · 拖放（含拖放文件夹，靠 webkitGetAsEntry 递归读）
            ? h(FileDrop, {
              title: '把作业文件或整个项目文件夹拖到这里',
              hint: '也可以点下面按钮选文件；zip 会在服务端解开，里面的代码批改时能逐行读到。'
                + '单个 ≤ 8 MB，最多 ' + MAX_HW_FILES + ' 个。',
              disabled: files.length >= MAX_HW_FILES,
              onFiles: (picked, rejected) => {
                if (rejected && rejected.length) setErr('这些没有收下：' + rejected.slice(0, 3).join('；'))
                const grown = files.concat(picked.map((p) => ({
                  name: p.name, bytes: p.bytes, mediaType: '', image: false, dataUrl: p.dataUrl,
                  relPath: p.relPath,
                }))).slice(0, MAX_HW_FILES)
                setFiles(grown)
              },
            })
            : h('input', {
              type: 'file', multiple: true, className: 'k61',
              accept: 'image/*',
              ref: fileInputRef,
              onChange: (e) => { addFiles(e.target.files); e.target.value = '' },
            }),
          h('div', { className: 'k57', style: { marginTop: '4px' } },
            tab === 'image'
              ? '选图片，或直接 Ctrl+V 粘贴截图（公式、报错、手写推导都可以）'
              : '支持 zip / 项目文件夹 / 单个文件；zip 与文件夹里的文本会被服务端解出来，批改时能读到。'),
          chip(files, setFiles, 'f'),
          chip(images, setImages, 'i')) : null,
        (tab === 'pick' && allowPick && onShot)
          ? h('div', null,
            h('div', { className: 'k20' },
              h('button', { className: 'k42', onClick: () => onShot('camera') }, '去课件页框选'),
              h('span', { className: 'k57' }, '在课件上框一块公式 → 自动截成高分辨率图片回到这里')),
            chip(images, setImages, 'ip')) : null,
        err ? h('div', { className: 'k52 k53' }, err) : null)
    }

    function LessonForm({ st, set, onGrade, onShot }) {
      const [fTab, setFTab] = React.useState('text')
      const [draft, setDraft] = React.useState('')
      const [files, setFiles] = React.useState([])
      const [images, setImages] = React.useState([])
      const [note, setNote] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => { setErr('') }, [fTab])

      // 相机入口：复用课件页的框选，把那一块高分辨率截下来当作「照片」。
      // 这条路不需要摄像头权限，而且截出来的正是他想要的那块内容。
      React.useEffect(() => {
        if (!st.cameraOpen) return
        const page = st.hwDraft ? st.hwDraft.page : 1
        set({ cameraOpen: false, view: 'slides', cameraShot: true, mode: 'region', slideIndex: Math.max(0, (page || 1) - 1) })
      }, [st.cameraOpen])
      /**
       * 从课件页取材回来了：把框到的那一块交给面板截成照片并接到待提交列表。
       * 只取**第一次**框选（那一块就是学生想要的），之后继续框就是普通提问取证 ——
       * 否则「去取材」和「提问取证」两个意图会互相抢框。
       */
      React.useEffect(() => {
        const p = st.cameraShot ? st.picked : null
        if (!p || !p.length) return
        const one = p[0]
        set({ cameraShot: false, picked: [], view: 'lesson' })
        onShot({ chapter: one.chapter, page: one.page, box: one.box, text: one.text })
      }, [st.cameraShot, st.picked && st.picked.length])

      // 面板里截好的照片（「把这块截成照片」的产物）自动进入待提交列表。
      // 用 useEffect 同步而不是在渲染里改：渲染期改状态在 React 里是禁手。
      const shotKey = st.hwShot ? (st.hwShot.name + ':' + String(st.hwShot.dataUrl || '').length) : ''
      React.useEffect(() => {
        if (!st.hwShot) return
        setImages((prev) => (prev.some((x) => x.name === st.hwShot.name) ? prev : prev.concat([st.hwShot])))
        setFTab('pick')
      }, [shotKey])

      const addFiles = (list) => {
        const incoming = Array.prototype.slice.call(list || [])
        const next = files.slice()
        for (const f of incoming) {
          if (next.length >= MAX_HW_FILES) { setErr('一次最多 ' + MAX_HW_FILES + ' 个附件，多的请分次提交'); break }
          const isImg = /^image\//.test(f.type || '')
          if (f.size > 8 * 1024 * 1024) { setErr('「' + f.name + '」超过 8 MB，请压缩后再传'); continue }
          const rd = new FileReader()
          rd.onload = () => {
            const item = { name: f.name, bytes: f.size, mediaType: f.type || '', image: isImg, dataUrl: String(rd.result || '') }
            setFiles((prev) => prev.concat([item]))
          }
          rd.onerror = () => setErr('读取「' + f.name + '」失败')
          rd.readAsDataURL(f)
        }
      }

      const submit = async () => {
        setBusy(true); setErr('')
        try {
          if (fTab === 'text' && !draft.trim()) throw new Error('先写点内容再提交')
          if (fTab === 'file' && !files.length) throw new Error('先选一个文件再提交')
          if (fTab === 'pick' && !st.hwDraft) throw new Error('还没有从课件上取材')
          const body = {
            text: draft,
            files: fTab === 'file' ? files.map((f) => ({ name: f.name, dataUrl: f.dataUrl })) : [],
            images: fTab === 'pick' ? images.map((x) => ({ name: x.name, dataUrl: x.dataUrl })) : [],
            note: note,
          }
          await onGrade(body)
          setDraft(''); setFiles([]); setImages([]); setNote(''); set({ hwDraft: null })
        } catch (e) { setErr(oneLineMsg(e)) } finally { setBusy(false) }
      }

      const pickCard = st.hwDraft ? pendingView(st.hwDraft) : null
      // ⚠️ 这里只给**目录前缀**，不要在这里取 pick 的字段。
      //    原来签名是 shotUrl(p, w) 并在函数体里读 p.chapter —— PickTab 里有一处
      //    写成了 shotUrl()，于是 p 是 undefined → 「Cannot read properties of
      //    undefined (reading 'chapter')」，整个面板被最外层错误边界接住变成红屏。
      //    一个只要「前缀」的函数，就不该要求调用方提供任何东西。
      const mediaBase = (st.info && st.info.prefixes ? st.info.prefixes.media : '/cip-stu-media') + '/'
      const previewPick = () => {
        if (!pickCard || !pickCard.shot) return null
        // 只在「本机当前正看着那一页」时才画预览。跨页取材时不假装能画 ——
        // 画一个错的预览比不画更糟。
        const cur = st.slides && st.slides.slides ? st.slides.slides[st.slideIndex || 0] : null
        if (!cur || Number(cur.index) !== Number(pickCard.page)) {
          return h('div', { className: 'k57' }, '取材自 ' + pickCard.chapter + ' 第 ' + pickCard.page + ' 页（不在当前页，预览略）')
        }
        const media = (cur.media || []).filter((m) => m.file)
        const b = pickCard.box
        return h('div', { className: 'k18', style: { position: 'relative', width: (b.w / 3) + 'px', height: (b.h / 3) + 'px', overflow: 'hidden', border: '1px solid var(--line-2)', borderRadius: '5px', flex: '0 0 auto' } },
          h('div', { style: css('position:absolute;left:' + (-b.x / 3) + 'px;top:' + (-b.y / 3) + 'px;width:1280px;height:720px;transform:scale(0.3333);transform-origin:0 0;background:#fff;') },
            (cur.shapes || []).map((s, i) => h('div', {
              key: 's' + i, className: 'k47',
              style: css('left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px;font-size:' + (s.maxPt ? Math.max(9, Math.min(30, s.maxPt * 0.92)) : 13) + 'px;font-weight:' + (s.bold ? 600 : 400) + ';'),
            }, s.text)),
            media.map((m, i) => h('img', { key: 'm' + i, src: mediaBase + encodeURIComponent(st.chapter) + '/' + encodeURIComponent(m.file), style: css('position:absolute;left:' + m.x + 'px;top:' + m.y + 'px;width:' + m.w + 'px;height:' + m.h + 'px;object-fit:contain;') }))))
      }

      return h('div', { className: 'k96' },
        h(AttachComposer, {
          tab: fTab, setTab: setFTab, text: draft, setText: setDraft,
          files: files, setFiles: setFiles, images: images, setImages: setImages,
          allowPick: true,
          onShot: (what) => {
            if (what === 'camera') { set({ cameraOpen: true }); return }
            onShot(what)
          },
          rows: 5,
          placeholder: '手推公式可以在这里用文字/符号写（例如 ∂L/∂w = Xᵀ(ŷ−y)/N）；一段推导、实验结论、设计说明也都行。',
        }),
        fTab === 'pick' && pickCard
          ? h('div', { className: 'k18' },
            h('span', { className: 'k57' }, '已取材：' + (pickCard.text
              ? ('「' + String(pickCard.text).replace(/\s+/g, ' ').slice(0, 24) + '…」')
              : (pickCard.chapter + ' 第 ' + pickCard.page + ' 页一块'))),
            h('button', { className: 'ka1', title: '清掉取材', onClick: () => set({ hwDraft: null }) }, '⨯'),
            previewPick())
          : null,
        h('div', { className: 'k20', style: { marginBottom: 0 } },
          h('input', { className: 'kcc', placeholder: '备注（可选）：这是第几版、改了什么', value: note, onChange: (e) => setNote(e.target.value) })),
        err ? h('div', { className: 'k52 k53' }, err) : null,
        st.error ? h('div', { className: 'k52 k53' }, st.error) : null,
        st.notice ? h('div', { className: 'k52 k62' }, st.notice) : null,
        st.hwResult ? h('div', { className: 'k51' },
          h('div', { className: 'k58' }, '第 ' + (st.hwResult.v || '?') + ' 版批改完成',
            st.hwResult.model ? h('span', { className: 'k50' }, st.hwResult.model) : null,
            st.hwResult.issues && st.hwResult.issues.length
              ? h('span', { className: 'k50' }, '判出 ' + st.hwResult.issues.length + ' 条问题（默认不公开）') : h('span', { className: 'k50' }, '未发现问题')),
          h('div', { className: 'kd5 kda' }, h(Markdown, { text: (st.hwResult.text || '').slice(0, 3000) })),
          h('div', { className: 'k57', style: { padding: '0 10px 8px' } },
            '完整批改已存进这一版的历史里。判出的问题默认只有你能看到 —— 到「我的提问」里选要公开给老师的。'))
          : null,
        h('div', { className: 'k20' },
          h('button', { className: 'k42 k11', disabled: busy || st.busy, onClick: submit },
            busy || st.busy ? '提交并批改中…' : '提交并批改'),
          h('span', { className: 'k57' }, '提交会生成新版本（不覆盖上一版），随后按教案批改')))
    }

    function VersionCard({ v, i, onGradeV, thumbUrl, showLesson, onOpenLesson }) {
      const thumbs = (v.files || []).filter((f) => f.image && f.url)
      return h('div', { className: 'kc0' },
        h('div', { className: 'kc1' },
          // 在「全部提交」里必须标出这一版属于哪一课，否则一串 v1/v2 无法定位
          showLesson && v.lesson
            ? h('button', {
              className: 'kc2 kc6', title: '打开课时 ' + v.lesson + ' 的教案与全部版本',
              onClick: () => onOpenLesson && onOpenLesson(v.lesson),
            }, 'L' + v.lesson + ' ' + (v.lessonTitle || ''))
            : h('span', { className: 'kc2' }, 'v' + v.v),
          showLesson ? h('span', { className: 'k50' }, 'v' + v.v) : null,
          h('span', { className: 'k57' }, fmtTime(v.at)),
          v.graded ? h('span', { className: 'k50 kbf' }, '已批改') : h('span', { className: 'k50 kbg' }, '未批改'),
          v.model ? h('span', { className: 'k50' }, v.model) : null,
          v.tokens ? h('span', { className: 'k57' }, v.tokens) : null,
          h('span', { className: 'k54' }),
          h('button', { className: 'k42', onClick: () => onGradeV(v) }, v.graded ? '重新批改' : '批改这一版')),
        v.note ? h('div', { className: 'k57', style: { padding: '0 10px' } }, '备注：' + v.note) : null,
        v.textPreview || (v.textBytes && v.textBytes > 0)
          ? h('div', { className: 'kd5 kda' }, v.textPreview || '（正文为空）')
          : h('div', { className: 'kd5 kda', 'data-empty': '1' }, '（这一版没有文字正文）'),
        (v.files || []).length ? h('div', { className: 'k18', style: { padding: '0 10px 6px', marginBottom: 0 } },
          (v.files || []).map((f, k) => h('a', {
            key: 'vf' + k, className: 'k50', href: f.url, target: '_blank', rel: 'noreferrer',
            download: f.name, title: '下载 ' + f.name,
          }, (f.image ? '🖼 ' : '📄 ') + f.name + ' · ' + fmtBytes(f.bytes)))) : null,
        thumbs.length ? h('div', { className: 'kc3' }, thumbs.map((f, k) => h('a', {
          key: 'th' + k, href: f.url, target: '_blank', rel: 'noreferrer', title: '打开 ' + f.name,
        }, h('img', { className: 'kc4', src: f.url, alt: f.name })))) : null,
        v.issues && v.issues.length
          ? h('div', { style: { padding: '4px 10px 10px' } },
            h('div', { className: 'k64', style: { marginTop: '4px' } }, '这一版判出的问题（' + v.issues.length + ' 条）'),
            v.issues.map((x, k) => h('div', { key: 'vi' + k, className: 'kd9' },
              bdg(x.severity, SEVERITY_COLOR[x.severity] || 'gray'), ' ' + x.text)))
          : (v.graded ? h('div', { className: 'k57', style: { padding: '0 10px 10px' } }, '这一版没有判出问题。') : null))
    }

    /**
     * 「课件取材」页签。
     *
     * 为什么需要它：很多作业是「手推公式」，而课件上正好有那些公式。
     * 让学生照着课件**框一块**截下来，比拍照再对焦更准，也不需要摄像头权限。
     * 截出来的图会以 3 倍分辨率生成（见 cropToPng 的 scale 参数），
     * 下标和分式才看得清。
     */
    function PickTab({ st, set, pickCard, images, onShot, mediaBase, preview, setImages }) {
      const data = st.slides
      const idx = data && data.slides ? Math.min(st.slideIndex || 0, data.slides.length - 1) : 0
      const cur = data && data.slides ? data.slides[idx] : null
      const prev = st.hwDraft ? st.hwDraft.prev : null
      return h('div', null,
        h('div', { className: 'k20' },
          h('button', { className: 'k42', disabled: !pickCard, onClick: () => onShot(pickCard) },
            pickCard ? '把这块截成照片（高分辨率）' : '先框选一块'),
          h('button', {
            className: 'k42',
            onClick: () => set({ cameraOpen: true }),
          }, '去课件页框选'),
          h('span', { className: 'k57' }, '点「去课件页框选」会跳到课件，用「框选图区」拖一块，提交提问旁的「就此内容提问」旁边会出现「用作作业照片」')),
        !data || !cur
          ? h('div', { className: 'k57' }, '课件还没加载完，稍后再试')
          : h('div', { className: 'k0', 'data-mode': 'region', style: { width: '100%', maxWidth: '100%', marginTop: '6px' } },
            h('div', { className: 'k17', style: css('position:relative;width:1280px;height:720px;transform:scale(' + (st.hwZoom || 0.42) + ');transform-origin:0 0;') },
              (cur.shapes || []).map((s, i) => h('div', {
                key: 'cs' + i, className: 'k47',
                style: css('left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.w + 'px;height:' + s.h + 'px;font-size:' + (s.maxPt ? Math.max(9, Math.min(30, s.maxPt * 0.92)) : 13) + 'px;font-weight:' + (s.bold ? 600 : 400) + ';'),
              }, s.text)),
              (cur.media || []).filter((m) => m.file).map((m, i) => h('img', {
                key: 'cm' + i, src: mediaBase + encodeURIComponent(st.chapter) + '/' + encodeURIComponent(m.file),
                style: css('position:absolute;left:' + m.x + 'px;top:' + m.y + 'px;width:' + m.w + 'px;height:' + m.h + 'px;object-fit:contain;'),
              })))),
        pickCard
          ? h('div', { className: 'k18' },
            h('span', { className: 'k57' }, '已取材：' + (pickCard.text
              ? ('「' + String(pickCard.text).replace(/\s+/g, ' ').slice(0, 24) + '…」')
              : (pickCard.chapter + ' 第 ' + pickCard.page + ' 页一块'))),
            images.length ? h('span', { className: 'k50' }, images.length + ' 张照片') : h('span', { className: 'k57' }, '还没截成照片'),
            images.length ? h('button', { className: 'ka1', title: '清掉照片', onClick: () => setImages([]) }, '×') : null,
            h('button', { className: 'ka1', title: '清掉取材', onClick: () => set({ hwDraft: null }) }, '⨯'),
            preview ? preview() : null)
          : h('div', { className: 'k57' }, '还没有取材。先框选一块，再点「把这块截成照片」。'),
        prev ? h('div', { className: 'k57' }, '上一块：' + prev) : null)
    }

    /**
     * 全部提交（按时间倒序）。
     *
     * 这是「作业批改」的**默认入口**，也是用户那条要求的落点：
     *   「历史回溯和修改不应和课时挂钩，应该是相对独立的，可以从课时脉络定位到
     *     对应提交的作业，但不是非得先选课时才能加载作业，不点选课时的情况下
     *     应默认按时间顺序排列作业提交的记录」
     *
     * 所以：这一页不依赖任何课时选择；每一条旁边标出它属于哪一课，
     * 点「看这一课」才跳到课时页（教案 + 该课全部版本）。
     */
    function SubmissionHistory({ st, set, onGrade, onOpenLesson }) {
      const items = st.hwAll
      if (items === null || items === undefined) {
        return h('div', { className: 'k46' },
          st.busy ? h('div', { className: 'k21' }, '加载提交记录…')
            : h('div', { className: 'k21' }, '还没有加载提交记录'))
      }
      const ungraded = items.filter((x) => !x.graded)
      const lessons = {}
      items.forEach((x) => { lessons[x.lesson] = 1 })
      return h('div', { className: 'k46' },
        h('div', { className: 'k8d', style: { marginBottom: '10px' } },
          h('div', { className: 'k8e' },
            h('span', { className: 'k8f' }, '我的作业提交'),
            h('span', { className: 'k8g' }, '按时间倒序')),
          h('div', { className: 'k8h' }, '这里是**全部**提交，与课时无关。每次提交是一个独立版本，旧版与旧版的批改都保留 —— 改完再交一版即可，不会覆盖。左侧课时脉络用来定位到某一课的教案。'),
          h('div', { className: 'k8i' },
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(items.length)), h('span', { className: 'k8l' }, '个版本')),
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(Object.keys(lessons).length)), h('span', { className: 'k8l' }, '涉及课时')),
            h('div', { className: 'k8j' },
              h('span', { className: 'k8k' }, String(ungraded.length)),
              h('span', { className: 'k8l' },
                ungraded.length ? '未批改' : '全部已批改')))),
        items.length
          ? items.map((v, i) => h(VersionCard, {
            key: 'a' + v.lesson + '-' + v.v, v: v, i: i, showLesson: true,
            onGradeV: (x) => onGrade(null, x.v, x.lesson),
            onOpenLesson: onOpenLesson,
          }))
          : h('div', { className: 'k21' }, '还没有任何提交。左边点一个课时 → 「我的提交」 → 写第一版；也可以先在课时页的教案里看清要求再交。'))
    }

    function LessonPage({ st, set, onGrade, onAssignPick }) {
      const L = st.lessonData
      if (!L) {
        return h('div', { className: 'k46' },
          st.busy ? h('div', { className: 'k21' }, '加载课时…')
            : h('div', { className: 'k21' }, '从左边课时脉络里点一个课时'))
      }
      const tab = st.hwTab === 'plan' ? 'plan' : 'subs'
      const versions = L.versions || []
      const pending = st.hwDraft ? pendingView(st.hwDraft) : null
      const showForm = tab === 'subs' && (st.hwCompose === true || versions.length === 0)
      return h('div', { className: 'k46' },
        // 抬头：这一课是什么、教案在哪
        h('div', { className: 'k8d', style: { marginBottom: '10px' } },
          h('div', { className: 'k8e' },
            h('span', { className: 'k8f' }, 'L' + L.lesson + ' ' + (L.title || '')),
            h('span', { className: 'k8g' }, L.module || ''),
            L.range ? h('span', { className: 'k8g' }, L.range) : null),
          h('div', { className: 'k8i' },
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(versions.length)), h('span', { className: 'k8l' }, '版本')),
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(versions.filter((v) => v.graded).length)), h('span', { className: 'k8l' }, '已批改')),
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(versions.reduce((a, v) => a + ((v.issues || []).length), 0))), h('span', { className: 'k8l' }, '累计问题')))),
        h('div', { className: 'k24' },
          h('span', { className: 'k43', 'data-on': tab === 'plan' ? '1' : '0', onClick: () => set({ hwTab: 'plan' }) }, '教案'),
          h('span', { className: 'k43', 'data-on': tab === 'subs' ? '1' : '0', onClick: () => set({ hwTab: 'subs', hwCompose: true }) },
            '我的提交' + (versions.length ? ('（' + versions.length + '）') : ''))),

        tab === 'plan'
          ? h('div', { className: 'k51' },
            h('div', { className: 'k58' }, '教案（只读）', h('span', { className: 'k54' }),
              h('span', { className: 'k57' }, L.planRel ? (L.planRel.split('\\').pop() + ' · ' + fmtBytes(L.planBytes)) : '尚未撰写')),
            L.planNote ? h('div', { className: 'k52 k53' }, L.planNote) : null,
            L.plan
              ? h('div', { className: 'kd5 kda' }, h(Markdown, { text: L.plan }))
              : h('div', { className: 'k21' }, '这一课时还没有教案。批改只能按通用工程规范初筛 —— 结论会比有教案时粗。'),
            // ⚠️ 索引里 gradingDimensions 的元素是**对象** {key, name, desc}，不是字符串。
            //    服务端那份写了兜底、客户端这份漏了 → 界面上 5 个胶囊全是空白，
            //    而「没渲染」与「渲染了空字符串」在截图里几乎一样，很难看出来。
            (L.dimensions || []).length ? h('div', { className: 'k18', style: { padding: '0 10px 10px', marginBottom: 0 } },
              h('span', { className: 'k57' }, '批改维度：'),
              (L.dimensions || []).map((d, i) => h('span', {
                key: 'd' + i, className: 'k50',
                title: (d && typeof d === 'object' && d.desc) ? d.desc : '',
              }, dimName(d)))) : null)
          : h('div', null,
            versions.length
              ? h('div', null, versions.map((v, i) => h(VersionCard, { key: 'v' + v.v, v: v, i: i, onGradeV: (x) => onGrade(null, x.v) })))
              : h('div', { className: 'k21' }, '还没有提交过。下面写第一版。'),
            showForm
              ? h(LessonForm, { st, set, onGrade, onShot: onAssignPick })
              : h('div', { className: 'k20' },
                h('button', { className: 'k42', onClick: () => set({ hwCompose: true }) }, '交新一版（改完再传）'),
                h('span', { className: 'k57' }, '新一版不会覆盖上面任何一版'))))
    }

    // ── 额度 ──
    function Usage({ st }) {
      const u = st.usage
      if (!u) return h('div', { className: 'k21' }, '额度统计加载中…')
      return h('div', { className: 'k46' },
        h('div', { className: 'k64' }, '我的模型用量（' + (u.student || '') + '）'),
        h('div', { className: 'k57' }, '输入 tokens ' + u.inputTokens + ' · 输出 tokens ' + u.outputTokens + ' · 共 ' + u.items + ' 条记录'),
        h('div', { className: 'k57' }, '提问、每一轮追问、标题凝练、问题总结、作业批改都记为你的消耗；教师端的整理与审计不调用模型。'),
        (u.per || []).map((x) => h('div', { key: x.id + x.title, className: 'kd9' },
          h('span', { className: 'k64', style: { margin: 0 } }, '#' + x.id + ' ' + x.title),
          h('span', { className: 'k57' }, ' ' + (x.tokens || '') + (x.turns ? (' · ' + x.turns + ' 轮追问') : '')))))
    }

    // ── 课程大纲总览（原「章节」页） ──────────────────────────────────────
    /**
     * 为什么这一页要改：原来的「章节」页只有三个章名按钮 + 一句「从这里开始」，
     * 它既不是大纲也不是导航 —— 学生点进来看到的是「第一章」这种他自己也不知道
     * 该不该点的东西。改成**大纲总览**后这一页回答三个问题：
     *   ① 这门课是什么（课程名/课程码/一句话目标 + 课时统计）
     *   ② 整门课怎么组织（鱼骨图，一眼看全 30 课时落在哪些模块、哪些已发布）
     *   ③ 我该怎么用这个面板（使用说明，分学生/教师两套）
     */
    function CourseOutline({ st, set, onOpenLesson }) {
      const tree = st.tree
      const course = (st.info && st.info.course) || {}
      const mods = (tree && tree.modules) || []
      const lessons = []
      mods.forEach((m) => (m.lessons || []).forEach((l) => lessons.push(l)))
      const total = lessons.length
      const withPlan = lessons.filter((l) => l.hasPlan).length
      // 「已发布」= 服务端给的 published === true。
      //
      // 踩过的坑（端侧实测）：这里原来写的是 `l.published !== false`。
      // 而服务端以前**根本没下发 published 字段** → `undefined !== false` 恒为真
      // → **30 个课时全被算成「已发布」**，而 课程.json 写着 publishedLessons=6。
      // 一个不存在的字段被当成默认放行，是这类「数字看起来对、其实全错」的典型来源。
      //
      // 现在两边都收敛到显式布尔：服务端一定下发 published（true/false），
      // 这里只认 === true。万一遇上没有该字段的旧服务端（滞后刷新），
      // 退回用 hasPlan 判断并**在数字后标注**，而不是默默把它算成已发布。
      const stalePublished = lessons.some((l) => l.published === undefined)
      const pub = stalePublished
        ? lessons.filter((l) => l.hasPlan).length
        : lessons.filter((l) => l.published === true).length
      const isTeacher = !!(st.info && st.info.role === 'teacher')
      const onPick = (ls) => onOpenLesson(ls.no)

      const steps = isTeacher ? [
        ['① 看板：问题池', '「问题池」里是全班学生的提问。每条都已经由模型凝练出标题、知识领域与涉及概念，按这两维排序就能看出共性。'],
        ['② 答复与公开', '在条目里直接答复学生（答复立刻出现在他的「我的提问」里）。值得全班看的，勾「公开」并写一句问题总结。'],
        ['③ 按课时汇总', '「课时问题」按你确认过的课时锚点把问题归到具体课时上，用于决定下一轮录课要补讲什么。'],
        ['④ 沉淀', '把反复出现的共性问题标为「已沉淀」，它就进入下一版教案的修订清单。'],
      ] : [
        ['① 找课时', '左边「课时脉络」里点任意课时（或在这一页的鱼骨图上点）→ 打开该课时的**教案 + 我的提交**：教案是批改的对齐基准，看一眼就知道这次要求什么。'],
        ['② 截图提问', '「课件」里框选一块（公式、图表、讲义截图都行）→ 提交提问。你的问题默认只有你能看到。'],
        ['③ 多轮追问', '「我的提问」里是完整的多轮问答，可以继续追问；每一轮追问都会重新作答并计入你的额度。'],
        ['④ 交作业', '课时页里可以打字、传文件、或从课件上框一块截成照片（手推公式就这么交）。每次提交都是一个**新版本**，旧版与旧版的批改都留着，改完再传即可。'],
      ]

      return h('div', { className: 'k46' },
        h('div', { className: 'k8d' },
          h('div', { className: 'k8e' },
            h('span', { className: 'k8f' }, course.title || '本课程'),
            course.code ? h('span', { className: 'k8g' }, course.code) : null,
            !isTeacher && course.term ? h('span', { className: 'k8g' }, course.term) : null,
            course.note ? h('span', { className: 'k8k', style: { marginLeft: 'auto', fontSize: '11px', fontWeight: 400 } }, course.note) : null),
          course.goal ? h('div', { className: 'k8h' }, course.goal) : null,
          h('div', { className: 'k8i' },
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(mods.length)), h('span', { className: 'k8l' }, '模块')),
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(total)), h('span', { className: 'k8l' }, '课时')),
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(withPlan)), h('span', { className: 'k8l' }, '已有教案')),
            h('div', { className: 'k8j' }, h('span', { className: 'k8k' }, String(pub)), h('span', { className: 'k8l' }, '已发布')))),

        h('div', { className: 'k64' }, '课程大纲（鱼骨图）'),
        h(OutlineFishbone, { tree: tree, selected: Number(st.hwLesson) || 0, onPick: onPick }),

        h('div', { className: 'k64' }, '这个面板怎么用'),
        h('div', { className: 'k8u' }, steps.map((s) => h('div', { key: s[0], className: 'k8v' },
          h('div', { className: 'k8w' }, s[0]),
          h('ul', { className: 'k8x' }, h('li', null, s[1]))))),
        h('div', { className: 'k57', style: { marginTop: '8px' } },
          isTeacher
            ? '学生端与教师端是两个可独立安装的插件，共享同一个课程工作区：学生写自己的提问与作业提交，教师读全部并策展公开。'
            : '你的问题默认只有你能看到；老师审核后才会把值得全班看的放进「公开问答」——避免个别问题占用所有人的注意力。老师直接答复你时，「我的提问」里会标出「教师已答复」。'))
    }

    // ── 模型选择器 ────────────────────────────────────────────────────────
    /**
     * 为什么面板要自带模型选择、而不是让学生去改 DSH 的设置：
     *   DSH 的模型选择是**整场会话**级别的 —— 在这里改掉它会连带改掉学生跟自己
     *   DSH agent 对话用的模型。那是别的插件的领地。
     *   而学生真正想要的是「这一条用便宜快的、那一条用强的」，是按提问分的。
     *   所以这个选择存在课程工作区里（课程问题池/学生/<学号>/模型选择.json），
     *   跟着学生走、不跟着会话走，也不碰 DSH 的设置。
     *
     * 还会标出哪些模型能看图 —— 「框选截图提问」这条路能不能走通全看它，
     * 选了一个纯文本模型却不提示，学生只会觉得「截图提问坏了」。
     */
    function ModelPicker({ onChange }) {
      const [cat, setCat] = React.useState(null)
      const [sel, setSel] = React.useState(null)     // {provider, model}
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      // pick() 里要按 provider/model 查「能不能看图」，但目录是 pick 之后才拿到的 ——
      // 用一个 ref 读最新值，避免把 items 塞进 useCallback 依赖里（那样每次目录变化
      // 都会换掉 pick 的身份，触发下面的 effect 再跑一遍）。
      const itemsRef = React.useRef([])

      const load = React.useCallback(async () => {
        try {
          const r = await api('model.catalog', {})
          setCat(r)
          const cur = r.saved && r.saved.provider ? { provider: r.saved.provider, model: r.saved.model } : (r.sessionDefault || null)
          setSel(cur)
          // 把「当前模型能不能看图」告诉面板：截图提问走不走得通全看它，
          // 而 AskPanel 需要据此提前提醒（事后才知道就太晚了）。
          if (onChange) {
            const m = cur ? (r.models || []).find((x) => x.provider === cur.provider && x.model === cur.model) : null
            onChange({ provider: cur ? cur.provider : '', model: cur ? cur.model : '', image: m ? m.image : null })
          }
          setErr('')
        } catch (e) { setErr('模型目录读取失败：' + oneLineMsg(e)) }
      }, [onChange])
      React.useEffect(() => { load() }, [load])

      const pick = React.useCallback(async (v) => {
        setBusy(true); setErr('')
        try {
          if (!v) {
            await api('model.select', { provider: '', model: '' })
            const r = await api('model.catalog', {})
            setCat(r)
            const cur = r.sessionDefault || null
            setSel(cur)
            if (onChange) onChange({ provider: cur ? cur.provider : '', model: cur ? cur.model : '', image: null })
          } else {
            const cut = v.indexOf('/')
            const provider = v.slice(0, cut)
            const model = v.slice(cut + 1)
            const r = await api('model.select', { provider, model })
            setSel({ provider, model })
            const m = itemsRef.find((x) => x.provider === provider && x.model === model)
            if (onChange) onChange({ provider, model, image: m ? m.image : null })
            if (r && r.inCatalog === false) setErr('该模型不在目录里，已保存但可能不可用')
          }
        } catch (e) { setErr('保存失败：' + oneLineMsg(e)) } finally { setBusy(false) }
      }, [onChange])

      const items = (cat && cat.models) || []
      itemsRef.current = items
      const k = (p, m) => p + '/' + m
      // 目录里没有当前选择时也把它作为一个选项显示 —— 否则 select 找不到匹配项会
      // 显示成列表里的第一项，学生会以为当前用的是另一个模型。
      const has = !!(sel && items.some((x) => k(x.provider, x.model) === k(sel.provider, sel.model)))
      const all = (sel && sel.provider && sel.model && !has)
        ? items.concat([{ provider: sel.provider, model: sel.model, name: sel.model + '（当前）', image: null }])
        : items
      const current = (sel && sel.provider)
        ? all.find((x) => k(x.provider, x.model) === k(sel.provider, sel.model)) || null
        : null
      // 按 provider 分组。数据来自宿主 listProviders/listModels，
      // 拿不到目录时退化成一行「当前模型」，不至于把顶栏撑坏。
      const groups = []
      for (const m of all) {
        let g = groups.find((x) => x.pid === m.provider)
        if (!g) {
          const p = ((cat && cat.providers) || []).find((x) => x.id === m.provider)
          g = { pid: m.provider, pname: (p && p.name) || m.provider, list: [] }
          groups.push(g)
        }
        g.list.push(m)
      }
      const optLabel = (m) => (m.name || m.model) + (m.image === true ? ' · 可看图' : (m.image === false ? ' · 无图' : ''))
      const warnings = (cat && cat.warnings) || []

      return h('div', { className: 'kb2' },
        h('div', { className: 'kb3' },
          h('span', { className: 'kb4' }, '模型'),
          h('select', {
            className: 'kb5',
            value: sel && sel.provider && sel.model ? k(sel.provider, sel.model) : '',
            disabled: busy || cat === null,
            title: current ? (current.provider + ' / ' + current.model + (current.description ? ('\n' + current.description) : '')) : '这一条提问用哪个模型回答',
            onChange: (e) => pick(e.target.value),
          },
            // 第一项表示「面板不介入」：完全按 DSH 会话当前的模型走
            h('option', { value: '' }, '跟随会话默认'),
            groups.map((g) => h('optgroup', { key: g.pid, label: g.pname },
              g.list.map((m) => h('option', { key: k(m.provider, m.model), value: k(m.provider, m.model) }, optLabel(m)))))),
        ),
        busy ? h('div', { className: 'kb6' }, '保存中…')
          : (err ? h('div', { className: 'kb7', title: err }, err)
            : h('div', { className: 'kb6', title: warnings.join('\n') },
              cat === null ? '模型目录加载中…'
                : (current ? (current.provider + ' / ' + current.model + (current.image === true ? ' · 可看图' : (current.image === false ? ' · 不支持图片' : ''))) : '未取得模型目录'))),
        (warnings.length && !err) ? h('div', { className: 'kb7', title: warnings.join('\n') }, '⚠ ' + warnings[0]) : null)
    }

    /**
     * 「你是这个班的谁」。
     *
     * 为什么需要它：学生身份原来就是 `process.env.USERNAME`，于是老师打开
     * 教师端，提问者一栏写着 **Administrator** —— 那不是学生，是这台 Windows
     * 机器的用户名。老师原话是「谁提问的，便于更好教学」，而那个答案没用。
     *
     * 三条设计约束：
     *   1. **不强制**。不填也能提问，只是老师那边看到的是一串机器用户名 ——
     *      把后果说清楚，比弹一个挡住界面的模态框好。
     *   2. **改学号要确认**。学号是目录名，改了就要把已有提问与作业搬过去，
     *      搬移不可逆，所以宿主会先回一个「会搬多少」的清单，这里再问一次。
     *   3. 姓名不是必填，但**强烈建议** —— 它决定老师认不认得你。
     */
    function IdentityCard({ st, set, onIdentify }) {
      const me = st.me || {}
      const f = st.meForm || { sid: me.sid || '', name: me.name || '', klass: me.klass || '' }
      // 改了学号就作废上一次的「确认搬迁」——不然会带着旧的确认去搬新目标。
      const setF = (p) => set({ meForm: Object.assign({}, f, p), meConfirm: false, identifyHint: '' })
      const changing = !!f.sid && f.sid !== me.sid
      return h('div', { className: 'kcb', style: { margin: '8px 14px 0' } },
        h('div', { className: 'k78' }, me.identified ? '改我的信息' : '先说一下你是谁（只用填一次）'),
        h('div', { className: 'kd1' }, me.identified
          ? ('老师看到的提问者是「' + (me.label || me.sid) + '」。'
            + (me.fromRoster ? '老师名册里已经有你的名字，以名册为准 —— 你改这里不会覆盖它。' : '改完立刻生效。'))
          : '现在你的学号是「' + (me.sid || '') + '」，它是从' + (me.how || '系统')
            + '来的 —— 那多半不是你。填一次学号与姓名，老师才知道是谁在提问，'
            + '你的提问与作业也才会归到你名下。'),
        h('div', { className: 'k70' },
          h('span', { className: 'k57' }, '学号'),
          h('input', {
            className: 'kcc', value: f.sid, placeholder: '例如 2023010101',
            onChange: (e) => setF({ sid: e.target.value }),
          }),
          h('span', { className: 'k57' }, '姓名'),
          h('input', {
            className: 'kcc', value: f.name, placeholder: '例如 张三',
            onChange: (e) => setF({ name: e.target.value }),
          }),
          h('span', { className: 'k57' }, '班级'),
          h('input', {
            className: 'kcc', value: f.klass, placeholder: '选填，例如 土木2101',
            onChange: (e) => setF({ klass: e.target.value }),
          })),
        changing ? h('div', { className: 'kd1', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
          '学号从 ' + me.sid + ' 改成 ' + f.sid + '：已有的提问与作业会**一起搬过去**（是搬移，不是复制）。'
          + '点保存后如果确实有数据，会先告诉你要搬多少条，再确认一次。') : null,
        st.identifyHint ? h('div', { className: 'kd1', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, st.identifyHint) : null,
        h('div', { className: 'kca' },
          h('button', {
            className: 'k42 k11', disabled: st.busy || !String(f.sid || '').trim(),
            onClick: () => onIdentify(f, st.meConfirm === true),
          }, st.busy ? '保存中…' : (st.meConfirm ? '确认搬迁并保存' : '保存')),
          me.identified ? h('button', { className: 'k42', onClick: () => set({ meOpen: false, meForm: null, identifyHint: '', meConfirm: false }) }, '收起') : null,
          h('span', { className: 'k54' }),
          h('span', { className: 'k57' }, '只写在这台机器上（' + (me.identityFile || '') + '），不进任何仓库。')))
    }

    /**
     * 就绪清单 + 首次设置向导。
     *
     * 为什么要有它：装完插件面板是空的，用户得自己找「哪里不对」。
     * 而这几件事**任何一件缺失，症状都是「面板打不开 / 答不出来」**，
     * 从界面上分不出是哪一件：
     *   · 身份没填 → 老师那边看到的提问者是 Administrator（机器用户名）
     *   · 找不到工作区 → 面板全空，还以为是插件坏了
     *   · 模型没设 → 一提问就报错，而报错看起来像网络问题
     *
     * 三条设计约束（都是刻意的）：
     *   1. **能跳过**。点「先看看」就收起，但顶部常驻一条就绪提示 ——
     *      学生会想先看看有什么功能，强制填完才给用只会让人卸载。
     *   2. **不假装**。每一项都必须是插件真的查过的东西，不做「可能吧」的推测。
     *      报一条假问题，后面每一条用户都会怀疑。
     *   3. **身份不算硬门槛**。没填也能提问，只是老师认不出是谁 ——
     *      把一个可选步骤做成「不能开始」是过度约束。
     */
    function ReadinessCard({ st, set, onIdentify }) {
      const r = st.readiness
      if (!r) return null
      const step = st.wizardStep || 1
      const f = st.meForm || { sid: (st.me && st.me.sid) || '', name: '', klass: '' }
      const setF = (p) => set({ meForm: Object.assign({}, f, p), meConfirm: false, identifyHint: '' })
      const item = (k) => (r.items || []).find((x) => x.key === k) || { ok: false, title: k, detail: '', fix: '' }
      const changed = !!f.sid && st.me && f.sid !== st.me.sid
      const steps = ['我是谁', '课程', '可以开始了']
      const mark = (x) => bdg(x.ok ? '✓' : '缺',
        x.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)')

      // 全部就绪：只留一行，不占地方
      if (!r.missing) {
        return h('div', { className: 'kce', style: { margin: '8px 14px 0' } },
          h('span', { className: 'k57' }, '✓ 已就绪　'),
          (r.items || []).map((x) => h('span', { key: x.key, className: 'k57' }, x.title + '：' + x.detail + '　')))
      }

      return h('div', { className: 'kcb', style: { margin: '8px 14px 0' } },
        h('div', { className: 'kc8' },
          bdg('还差 ' + r.missing + ' 件事就能开始', 'var(--dsw-alias-state-warn-primary)'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k24' }, steps.map((s, i) => h('span', {
            key: s, className: 'k43', 'data-on': (st.wizardOpen && step === i + 1) ? '1' : '0',
            onClick: () => set({ wizardStep: i + 1, wizardOpen: true }),
          }, (i + 1) + '. ' + s)))),
        h('div', { className: 'kca' },
          h('button', {
            className: 'k42 k11',
            onClick: () => set({ wizardOpen: !st.wizardOpen, wizardSkipped: false }),
          }, st.wizardOpen ? '收起向导' : '开始设置（约 1 分钟）'),
          h('button', { className: 'k42', onClick: () => set({ wizardOpen: false, wizardSkipped: true }) }, '先看看'),
          h('span', { className: 'k54' }),
          h('span', { className: 'k57' }, '跳过之后这条提示会一直留着 —— 缺哪一项、点一下怎么补，都写在这儿。')),

        st.wizardOpen ? h('div', null,
          // ── 第 1 步：我是谁 ──
          step === 1 ? h('div', null,
            h('div', { className: 'k78' }, '你希望老师看到的名字'),
            h('div', { className: 'kd1' }, item('identity').detail),
            h('div', { className: 'k70' },
              h('span', { className: 'k57' }, '学号'),
              h('input', { className: 'kcc', value: f.sid, placeholder: '例如 2023010101', onChange: (e) => setF({ sid: e.target.value }) }),
              h('span', { className: 'k57' }, '姓名'),
              h('input', { className: 'kcc', value: f.name, placeholder: '例如 张三', onChange: (e) => setF({ name: e.target.value }) }),
              h('span', { className: 'k57' }, '班级'),
              h('input', { className: 'kcc', value: f.klass, placeholder: '选填', onChange: (e) => setF({ klass: e.target.value }) })),
            changed ? h('div', { className: 'kd1', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
              '学号从 ' + st.me.sid + ' 改成 ' + f.sid + '：已有的提问与作业会**一起搬过去**（是搬移，不是复制），'
              + '点保存后如果确实有数据，会先告诉你要搬多少条。') : null,
            st.identifyHint ? h('div', { className: 'kd1', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, st.identifyHint) : null,
            h('div', { className: 'kca' },
              h('button', {
                className: 'k42 k11', disabled: st.busy || !String(f.sid || '').trim(),
                onClick: () => onIdentify(f, st.meConfirm === true),
              }, st.busy ? '保存中…' : (st.meConfirm ? '确认搬迁并保存' : '保存，下一步')),
              h('button', { className: 'k42', onClick: () => set({ wizardStep: 2 }) }, '跳过这步'),
              h('span', { className: 'k57' }, '只写在这台机器上，不进任何仓库。')))
            : null,

          // ── 第 2 步：课程 ──
          step === 2 ? h('div', null,
            h('div', { className: 'k78' }, '你在上哪门课'),
            (r.items || []).filter((x) => x.key === 'workspace' || x.key === 'course' || x.key === 'model')
              .map((x) => h('div', { key: x.key, className: 'kce' },
                mark(x),
                h('span', { className: 'k57' }, x.title + '：' + x.detail),
                x.fix ? h('span', { className: 'k57' }, '　→ ' + x.fix) : null)),
            h('div', { className: 'kd1' }, '课程码**正常情况下不用你输**：它随公开仓一起到，插件自己认。'
              + '如果你手上只有插件、还没拿到课程仓库，把课程仓库 clone 到本机再刷新即可。'),
            h('div', { className: 'kca' },
              h('button', { className: 'k42 k11', onClick: () => set({ wizardStep: 3 }) }, '下一步'),
              h('button', { className: 'k42', onClick: () => set({ wizardStep: 1 }) }, '上一步'),
              h('span', { className: 'k57' }, '这一页只报告状态，不需要你填东西。')))
            : null,

          // ── 第 3 步：可以开始了 ──
          step === 3 ? h('div', null,
            h('div', { className: 'k78' }, r.canStart ? '可以开始提问了' : '还差关键的两件（工作区 / 模型）'),
            (r.items || []).map((x) => h('div', { key: x.key, className: 'kce' },
              mark(x), h('span', { className: 'k57' }, x.title + '：' + x.detail))),
            h('details', { className: 'kcd' },
              h('summary', null, '要不要再建一个「我自己的仓库」（默认不需要）'),
              h('div', { className: 'kd1' }, '你的提问与作业只存在本机，**功能一个不少**。'),
              h('div', { className: 'kd1' }, '只有两种情况值得建：一是在两台机器上用（宿舍 + 实验室），'
                + '二是担心本机磁盘坏了。建的话需要一个你自己的 GitHub 私有仓 —— '
                + '插件不会、也不该替你保管密钥。')),
            h('div', { className: 'kca' },
              h('button', { className: 'k42 k11', onClick: () => set({ wizardOpen: false, wizardSkipped: true }) }, '开始使用'),
              h('button', { className: 'k42', onClick: () => set({ wizardStep: 2 }) }, '上一步'),
              h('span', { className: 'k57' }, '提问与批改花的是**你自己的**额度，面板里随时能看到用了多少。')))
            : null)
          : null)
    }

    // ── 面板 ──
    function Panel() {
      const init = {
        view: 'outline', mode: 'region', chapter: '第一章', slideIndex: 0, zoom: 1,
        q: '', followup: '', asking: false, busy: false, picked: [], pageWide: false,
        // 追问附件（与首次提问同一套组件）与「我的提问」的批量勾选
        fuTab: 'text', fuFiles: [], fuImages: [],
        // ⚠️ 勾选用的键**不能**叫 picked —— picked 是「课件上收集到的证据块数组」，
        //    两处共用一个键、形状却是数组 vs 对象，结果就是切到课件页时
        //    `picks.filter is not a function` 整页崩。名字必须各自说清自己是什么。
        selItems: {},
        dragging: null, modelVision: null,
        rail: true,
        f: { module: '模块一', type: '概念问题', severity: '中', lesson: '' },
        hwLesson: '', hwResult: null,
        // 课时页：hwTab=plan|subs、hwCompose=是否展开提交表单、hwDraft=已摘取的PPT取材、
        // lessonData=教案+版本历史、cameraOpen=是否要把相机切入课件页去框选
        hwTab: 'plan', hwCompose: false, hwDraft: null, lessonData: null, hwAll: null,
        hwPickOpen: false, hwZoom: 0.42, cameraOpen: false, cameraShot: false, hwShot: null,
        lessonBusy: false, lessonError: '',
        // 「我是谁」：me 是宿主的当前状态，meOpen 是编辑卡片是否展开，
        // meForm 是编辑中的草稿（不要直接改 me，取消时要能还原）。
        me: null, meOpen: false, meForm: null, identifyHint: '', meConfirm: false, meMissing: '',
        // 就绪清单与首次设置向导
        readiness: null, wizardOpen: false, wizardStep: 1, wizardSkipped: false,
      }
      const pair = React.useState(init)
      const st = pair[0] || init          // 状态为 null/undefined 时也不至于崩
      const setSt = pair[1]
      /**
       * ⚠️ 必须用**合并式** setter 包一层。
       *
       * React 的 setState 与 class 组件的 setState 语义不同：
       *     setSt({ info })        → 整个状态被替换成 { info }，其余字段全丢
       *     set({ ...prev, info }) → 合并
       *
       * 我们在这里注册了 16 个字段（view / chapter / f …），而 load() 第一步
       * 就是 set({ info })。用直接替换的话，第一次 set 就把 view:'chapter'
       * 连同其余 14 个键一起冲掉 —— 表现为：请求全部成功、界面永远停在初始值、
       * 按钮点不动，而 st.keys 从 16 掉到 1。
       *
       * 包一层的好处：下面二十多处 set({...}) 一个字都不用改，也不会漏改。
       */
      const set = function (patch) {
        setSt(function (prev) {
          const base = (prev && typeof prev === 'object') ? prev : init
          if (typeof patch === 'function') return Object.assign({}, base, patch(base))
          return Object.assign({}, base, patch)
        })
      }
      // 供校验脚本驱动「合并语义」的回归测试（直接调 useState 原始 setter 测不到
      // 这一层）。运行时只是挂一个全局引用，无副作用。
      if (typeof globalThis !== 'undefined') globalThis.__cip_lastSet = set

      // ── 自检：为什么 st.view 会是 undefined？ ──
      // 初始值里就写死了 view:'chapter'，渲染时却是 undefined，说明 st 不是
      // 我们交给 useState 的那个对象。把 React 的真身与 hook 返回值形状记下来，
      // 直接画在面板上 —— 这类问题看代码看不出来，只能看运行时实况。
      const stRef = React.useRef(st); stRef.current = st
      // 课件视口节点（整页截图用它裁剪）。由 Slides 在渲染后写入。
      const slideRef = React.useRef(null)

      const loadThreads = React.useCallback(async () => {
        const r = await api('threads', {})
        set({
          mine: r.mine || [], publicItems: r.public || [],
          publicIdx: r.publicIndex || null,
        })
      }, [])
      const load = React.useCallback(async () => {
        try {
          const info = await api('info', {})
          set({ info })
          const tree = (await api('tree', {})).tree
          set({ tree })
          const ch = (info.chapters && info.chapters[0]) || '第一章'
          const slides = await api('slides', { chapter: ch })
          set({ chapter: ch, slides })
          // 第一张有图的页，避免一进来停在空白页
          if (slides && slides.slides) {
            const i = slides.slides.findIndex((s) => (s.media || []).some((m) => m.file))
            if (i > 0) set({ slideIndex: i })
          }
          await loadThreads()
          set({ usage: await api('usage', {}) })
        } catch (err) { set({ error: '加载失败：' + ((err && err.message) || String(err)) }) }
        // 「我是谁」单独一段、**失败不影响上面任何东西**。
        //
        // 为什么必须分开：它是后加的动作，而宿主半区是**进程启动时**注册路由的 ——
        // 旧宿主上这个动作不存在，会返回「未知动作」。写在同一个 try 里，
        // 后果是整页只显示一条报错、连课件都看不了（踩过一次）。
        // 新加的动作不该有能力把已经能用的面板弄坏。
        // 就绪清单：同样是**新动作**，旧宿主上不存在。
        // 单独一段 try —— 新加的动作不该有能力把已经能用的面板弄坏（踩过一次）。
        try {
          set({ readiness: await api('readiness', {}) })
        } catch (err) { /* 没就绪清单也能用，只是少了那张提示 */ }
        try {
          set({ me: await api('student.me', {}) })
        } catch (err) {
          set({
            me: null,
            meMissing: (err && err.message) || String(err),
            notice: '「我是谁」这块暂时不可用（多半是宿主半区没重启）。其余功能不受影响。',
          })
        }
      }, [loadThreads])
      /**
       * 保存「我是谁」。
       *
       * 两段式：宿主第一次会回 `needsConfirm`（改学号要把已有数据搬过去），
       * 这时把清单显示出来、等学生再点一次；第二次带 confirm 才真搬。
       * 不做成自动搬迁的理由很直白 —— 搬移不可逆，而学生点错一个数字
       * 就可能把别人的目录认成自己的。
       */
      const onIdentify = React.useCallback(async (form, confirmed) => {
        set({ busy: true, error: '', identifyHint: '' })
        try {
          const r = await api('student.identify', {
            sid: form.sid, name: form.name, klass: form.klass,
            confirm: confirmed === true,
          })
          if (r && r.needsConfirm) {
            set({ busy: false, identifyHint: r.message + '（再点一次「确认搬迁」）', meConfirm: true })
            return
          }
          if (r && r.needsConfirm === undefined && r.ok === false && r.message) {
            set({ busy: false, identifyHint: r.message })
            return
          }
          set({
            busy: false, me: await api('student.me', {}), meOpen: false, meForm: null,
            notice: r.note || '已记住。',
            // 保存成功后自动走到下一步：向导是让人一次填完的，不是让人自己找下一步
            wizardStep: 2,
          })
          try { set({ readiness: await api('readiness', {}) }) } catch (e) { /* 下次刷新再拉 */ }
          await load()
        } catch (err) { set({ busy: false, error: '保存失败：' + ((err && err.message) || String(err)) }) }
      }, [load])
      const switchChapter = React.useCallback(async (ch) => {
        set({ chapter: ch, slideIndex: 0, picked: [], slides: null })  // picked 永远是数组，不能给 null
        set({ slides: await api('slides', { chapter: ch }) })
      }, [])
      const openThread = React.useCallback(async (path) => {
        try {
          set({ thread: await api('thread', { path }), selPath: path, view: 'thread', followup: '' })
        } catch (err) { set({ error: '读取失败：' + ((err && err.message) || String(err)) }) }
      }, [])
      const onAsk = React.useCallback(async () => {
        const cur = stRef.current
        set({ asking: true, error: '' })
        try {
          const picks = asPicks(cur.picked)
          // 课件课时序号：由宿主从「课时分隔页」自动切分而来，挂在每一页上。
          // 有了它，提问能记住「来自课件第几个课时」，和课时脉络对上。
          const curSlide = cur.slides && cur.slides.slides
            ? cur.slides.slides[Math.min(cur.slideIndex || 0, cur.slides.slides.length - 1)]
            : null
          // ── 证据：把收集到的每一块都交给宿主 ──
          // dataUrls 走数组而不是单个 dataUrl：一个知识点常常横跨多页，
          // 只带一张图等于把学生的问题砍掉一半。
          const dataUrls = []
          const texts = []
          let regionCount = 0
          let textCount = 0
          let pageCount = 0
          for (const p of picks) {
            if (p.kind === 'text') { textCount += 1; if (p.text) texts.push(p.text) }
            else if (p.kind === 'page') pageCount += 1
            else { regionCount += 1; if (p.text) texts.push(p.text) }
            if (p.dataUrl) dataUrls.push(p.dataUrl)
          }
          // 「同时附上整页截图」：勾了才截，避免每次提问都多传一张大图（token 是学生的钱）
          if (cur.pageWide && curSlide) {
            try {
              const wrap = slideRef.current
              const r = await cropToPng(wrap, curSlide, { x: 0, y: 0, w: cur.slides.slideWidth, h: cur.slides.slideHeight }, 2)
              if (r.dataUrl) dataUrls.push(r.dataUrl)
            } catch (e) { /* 整页截图失败不影响提问 */ }
          }
          const pages = {}
          picks.forEach((p) => { pages[p.chapter + '|' + p.page] = 1 })
          const originLine = picks.length
            ? ('课件 ' + Object.keys(pages).length + ' 页共 ' + picks.length + ' 块 · '
              + picks.map((p) => p.label).join('；'))
            : (cur.chapter + ' 第 ' + (curSlide ? curSlide.index : 1) + ' 页（未框选内容）')
          const r = await api('ask', {
            question: cur.q,
            text: texts.join('\n\n').slice(0, MAX_SUB_TEXT),
            origin: originLine,
            loc: picks.length ? originLine : (cur.chapter + ' 第' + (curSlide ? curSlide.index : 1) + '页'),
            dataUrls: dataUrls,
            evidence: picks.map((p) => ({
              chapter: p.chapter, page: p.page, kind: p.kind, label: p.label,
              text: String(p.text || '').slice(0, 800), note: p.note || '',
            })),
            counts: { regions: regionCount, texts: textCount, pages: pageCount, images: dataUrls.length },
            module: cur.f.module, lesson: cur.f.lesson, type: cur.f.type, severity: cur.f.severity,
            source: regionCount && !textCount ? '阅读器框选图区' : (textCount && !regionCount ? '阅读器拖选文字' : '阅读器框选图区'),
            slideSeq: curSlide ? (curSlide.lessonSeq || 0) : 0,
          })
          set({
            asking: false, q: '', picked: [], pageWide: false,
            notice: '已归档 #' + r.id + '：' + r.title + '（' + (r.topic || '未分类') + (r.concept ? ' · ' + r.concept : '') + '）'
              + (r.warn ? ' ⚠ ' + r.warn : ''),
          })
          await loadThreads()
          set({ usage: await api('usage', {}) })
          if (r.path) await openThread(r.path)
        } catch (err) { set({ asking: false, error: '提问失败：' + ((err && err.message) || String(err)) }) }
      }, [loadThreads, openThread])
      // 收集 / 移除 / 清空证据。收集是**追加**语义 —— 翻页不清空，这才是跨页的前提。
      const addPick = React.useCallback((snip) => {
        const cur = stRef.current
        const list = asPicks(cur.picked).slice()
        if (list.length >= MAX_PICK) {
          set({ error: '一次提问最多收集 ' + MAX_PICK + ' 块内容，请先移除一些或直接提交。' })
          return
        }
        list.push(snip)
        set({ picked: list, error: '', notice: '已收集第 ' + list.length + ' 块：' + snip.label + (snip.note ? '（' + snip.note + '）' : '') })
      }, [])
      const removePick = React.useCallback((i) => {
        const cur = stRef.current
        const list = (cur.picked || []).slice()
        list.splice(i, 1)
        set({ picked: list, notice: '已移除一块，剩 ' + list.length + ' 块' })
      }, [])
      const clearPicks = React.useCallback(() => { set({ picked: [], notice: '已清空收集区' }) }, [])
      /** 页码导航用：这一页有没有收集过东西 */
      const pageHasPick = React.useCallback((pageNo) => {
        const cur = stRef.current
        return asPicks(cur.picked).some((p) => p.page === pageNo)
      }, [])
      const onSync = React.useCallback(async () => {
        set({ busy: true, error: '', syncResult: null })
        try {
          const r = await api('sync', {})
          set({ busy: false, syncResult: r, notice: r.ok ? (r.changed ? '已拉取课程更新' : '已经是最新的') : ('拉取失败：' + r.error) })
          if (r.ok) { await loadThreads() }
        } catch (err) { set({ busy: false, error: '拉取失败：' + ((err && err.message) || String(err)) }) }
      }, [loadThreads])
      /**
       * 追问。**与首次提问走同一套证据结构**（dataUrls + evidence），
       * 宿主那边也是同一个 normalizeEvidence —— 不另造一套字段名，
       * 否则「提问能带图、追问不能」这种不一致迟早会以 bug 的形式冒出来。
       */
      const onFollowup = React.useCallback(async (path, q, files, images) => {
        set({ asking: true, error: '' })
        try {
          const fl = (files || []).map((x) => ({ name: x.name, dataUrl: x.dataUrl, image: false }))
            .concat((images || []).map((x) => ({ name: x.name, dataUrl: x.dataUrl, image: true })))
          const r = await api('followup', {
            path: path, question: q, text: '',
            dataUrls: fl.map((x) => x.dataUrl).filter(Boolean),
            evidence: fl.map((x) => ({ chapter: '', page: 0, kind: x.image ? 'region' : 'text', label: '追问附件：' + x.name, text: '' })),
          })
          set({ asking: false, followup: '', fuFiles: [], fuImages: [], notice: '第 ' + r.turns + ' 轮追问已作答' })
          await openThread(path)
          set({ usage: await api('usage', {}) })
        } catch (err) { set({ asking: false, error: apiErrorHint('追问失败：' + oneLineMsg(err)) }) }
      }, [openThread])
      /**
       * 公开 / 撤回一条。作业批改判出的问题**默认不公开**，由学生自己选 ——
       * 一次批改十几条，全部涌向教师端会把老师淹没。
       */
      const shareItem = React.useCallback(async (path, shared) => {
        try {
          await api('item.share', { path: path, shared: shared })
          set({ notice: shared ? '已公开给老师（他那边现在能看到这一条）' : '已撤回，老师不再看到这一条' })
          await loadThreads()
        } catch (err) { set({ error: '操作失败：' + oneLineMsg(err) }) }
      }, [loadThreads])
      const shareBatch = React.useCallback(async (paths, shared) => {
        if (!paths || !paths.length) return
        set({ busy: true, error: '' })
        try {
          const r = await api('item.share.batch', { paths: paths, shared: shared })
          set({
            busy: false, selItems: {},
            notice: (shared ? '已公开 ' : '已撤回 ') + r.done + ' 条'
              + ((r.failed || []).length ? ('，' + r.failed.length + ' 条失败：' + r.failed[0].error) : ''),
          })
          await loadThreads()
        } catch (err) { set({ busy: false, error: '批量操作失败：' + oneLineMsg(err) }) }
      }, [loadThreads])
      /**
       * 刷新「全部提交」列表。
       *
       * 这条路径**不依赖课时**（用户明确要求：历史回溯与修改不该和课时挂钩）。
       * 面板一进来就调它，所以「提交历史」页直接可用，不必先点课时。
       */
      const loadAllSubmissions = React.useCallback(async () => {
        try {
          const r = await api('submission.all', {})
          set({ hwAll: r.items || [] })
          return r
        } catch (err) {
          // 不能因为列表取不到就把整个面板弄成错误态：这条路径是附加入口，
          // 不影响「点课时看教案与提交」那条主路径。
          set({ hwAll: [], error: apiErrorHint('提交记录读取失败：' + oneLineMsg(err)) })
          return null
        }
      }, [])
      /** 打开一个课时：把教案与该课时的提交历史一起取回来 */
      const openLesson = React.useCallback(async (lessonNo) => {
        const n = Number(lessonNo) || 0
        if (!n) return
        set({ hwLesson: String(n), view: 'lesson', lessonBusy: true, error: '', hwResult: null, hwDraft: null })
        try {
          const d = await api('lesson.open', { lesson: n })
          set({ lessonData: d, lessonBusy: false, hwTab: d.plan ? 'plan' : 'subs', hwCompose: !(d.versions || []).length })
        } catch (err) {
          set({ lessonBusy: false, lessonData: null, error: apiErrorHint('课时读取失败：' + oneLineMsg(err)) })
        }
      }, [])
      /**
       * 提交一版并批改。
       * `body` 由 LessonForm 组装（text/files/images/note）；不传就是「重新批改已有的一版」。
       * `lessonArg` 用于在「全部提交」页里批改某一版 —— 那里没有「当前课时」，
       * 课时号从那一条记录上取。
       */
      const onGrade = React.useCallback(async (body, gradeV, lessonArg) => {
        const cur = stRef.current
        const lessonNo = Number(lessonArg) || Number(cur.hwLesson) || 0
        if (!lessonNo) throw new Error('还没选课时')
        set({ busy: true, error: '', hwResult: null, notice: '' })
        try {
          let v = Number(gradeV) || 0
          if (body) {
            const s = await api('submission.save', {
              lesson: lessonNo, text: body.text || '', note: body.note || '',
              files: body.files || [], images: body.images || [],
            })
            v = s.v
            set({ notice: '已生成第 ' + v + ' 版（' + (s.files || []).length + ' 个附件，正文 ' + s.textBytes + ' 字节），正在按教案批改…' })
          }
          const m = ((cur.tree && cur.tree.modules) || []).find((mm) => (mm.lessons || []).some((l) => String(l.no) === String(lessonNo)))
          const g = await api('submission.grade', { lesson: lessonNo, v: v, module: m ? m.name : '模块一' })
          set({ busy: false, hwResult: g })
          // 同时刷新两条路径：当前课时的页面（如果在看）与「全部提交」列表。
          // 只刷一条会出现「刚批完，切到提交历史还是旧状态」。
          const d = await api('lesson.open', { lesson: lessonNo })
          set({ lessonData: d, hwTab: 'subs' })
          await loadAllSubmissions()
          await loadThreads()
          set({ usage: await api('usage', {}) })
          return g
        } catch (err) {
          set({ busy: false, error: apiErrorHint('批改失败：' + oneLineMsg(err)) })
          throw err
        }
      }, [loadThreads, loadAllSubmissions])
      /**
       * 「把这块截成照片」：在课件页已经加载好的画布节点上按 3 倍分辨率重裁一次。
       * ⚠️ 必须用 slideRef 而不是 document.querySelector —— 学生端与教师端可能同时
       *    挂在同一个页面上，全局选择器会截到教师面板的课件，而且看起来「成功了」。
       */
      const assignPick = React.useCallback(async (pick) => {
        const cur = stRef.current
        if (!pick) return
        set({ busy: true, error: '', notice: '正在截取…' })
        try {
          const slides = cur.slides && cur.slides.slides ? cur.slides.slides : []
          const slide = slides.filter((s) => Number(s.index) === Number(pick.page))[0] || slides[cur.slideIndex || 0]
          if (!slide) throw new Error('找不到那一页，先在课件页翻到第 ' + pick.page + ' 页再取材')
          const box = { x: pick.box.x, y: pick.box.y, w: pick.box.w, h: pick.box.h }
          // 3 倍：手推公式的下标与分式在 2 倍下糊成一团，而模型看不清等于没交
          const r = await cropToPng(slideRef.current, slide, box, 3)
          if (!r.dataUrl) throw new Error('截取失败：' + (r.diag.reason || '未知原因'))
          const text = pick.text || ''
          const name = 'PPT-' + pick.chapter + '-p' + pick.page + '.png'
          set({
            busy: false,
            hwDraft: { chapter: pick.chapter, page: pick.page, box: box, text: text },
            // 截出来的图**直接进待提交列表**，不要求用户再点一次「提交」才生效。
            // 顺带把它接到「照片」数组上，这样 LessonForm 不用再单独维护一份。
            hwShot: { name: name, dataUrl: r.dataUrl, bytes: Math.round(r.dataUrl.length * 0.75), image: true },
            notice: '已截成照片（' + fmtBytes(Math.round(r.dataUrl.length * 0.75)) + '），提交时会随作业一起发给模型',
          })
          void text
        } catch (err) { set({ busy: false, error: '截取失败：' + oneLineMsg(err) }) }
      }, [])

      React.useEffect(() => { load() }, [load])
      // 「全部提交」在面板打开时就取一次：它不依赖课时，是「提交历史」页的数据源。
      // 用户的要求是「不点选课时的情况下应默认按时间顺序排列作业提交的记录」，
      // 所以这条请求必须与课时选择完全解耦。
      React.useEffect(() => { loadAllSubmissions() }, [loadAllSubmissions])
      React.useEffect(() => { loadKatex(CFG.katex, { onDone: (ok, err) => set(ok ? { katexReady: true } : { katexError: err || '未知' }) }) }, [])
      // 侧栏收起状态：记住上次的选择。localStorage 在某些嵌入环境下会抛异常
      // （隐私模式 / 三方 cookie 限制），所以包在 try 里 —— 记不住偏好是可以接受的，
      // 因为读不到就把面板整个炸掉不可接受。
      React.useEffect(() => {
        try {
          const v = window.localStorage.getItem('cip.rail')
          if (v === '0' || v === '1') set({ rail: v === '1' })
        } catch (e) { /* 忽略：用默认值 */ }
      }, [])
      const toggleRail = React.useCallback(() => {
        const next = !((stRef.current || {}).rail !== false)
        set({ rail: next })
        try { window.localStorage.setItem('cip.rail', next ? '1' : '0') } catch (e) { /* 忽略 */ }
      }, [])
      /**
       * 当前模型能不能看图（null=未知，true/false=已知）。
       *
       * ⚠️ 这里**不能**用 React.useState：这个回调定义在若干 hook 之后，
       *    在中间插一个新 hook 会改变 hook 顺序 —— 那是 React 的硬规则，
       *    而且报错信息会指向别处，很难查。
       *    做法改成写进 stRef（渲染期已经把它同步成最新状态）再触发一次 set，
       *    界面照样能拿到「这次要提醒」，hook 顺序一个都没动。
       */
      const onModelChange = React.useCallback((info) => {
        const v = info ? info.image : null
        if (stRef.current && stRef.current.modelVision === v) return
        set({ modelVision: v })
      }, [])

      const views = [
        { id: 'outline', label: '大纲' },
        { id: 'slides', label: '课件' },
        { id: 'threads', label: '我的提问' },
        { id: 'public', label: '公开问答' },
        { id: 'lesson', label: '课时作业' },
        { id: 'submit', label: '提交历史' },
        { id: 'usage', label: '额度' },
      ]
      return h('div', { className: 'k22' },
        h('div', { className: 'k23' },
          h('div', null,
            h('div', { className: 'k9a' },
              h('div', { className: 'k10' }, '鼹鼠仔 · 课程答疑'),
              h('span', { className: 'k9b', 'data-role': 'student', title: '学生端：提问费用记在你自己账号上；你的问题默认只属于你，老师审核后才可能公开给全班' }, '学生'),
              // 自己的名字：老师那边看到的提问者就是它。点一下就能改。
              st.me ? h('span', {
                className: 'k9c', style: { cursor: 'pointer' },
                title: '老师看到的提问者就是这个名字。点一下改学号 / 姓名 / 班级。',
                onClick: () => set({ meOpen: !st.meOpen }),
              }, (st.me.label || st.me.sid) + ' ✎') : null),
            h('div', { className: 'k41' }, st.info
              ? ('我的 ' + ((st.mine || []).length) + ' 条 · 公开 ' + ((st.publicItems || []).length) + ' 条 · 课件 ' + (st.slides ? st.slides.slideCount : 0) + ' 页' + (st.katexReady ? ' · 公式已就绪' : ''))
              : '加载中…')),
          h('div', { className: 'k54' }),
          h(ModelPicker, { onChange: onModelChange }),
          h('div', { className: 'k24' }, views.map((v) => h('span', {
            key: v.id, className: 'k43', 'data-on': (st.view === v.id || (v.id === 'threads' && st.view === 'thread')) ? '1' : '0',
            onClick: () => set({ view: v.id }),
          }, v.label))),
          h('button', { className: 'k42', disabled: st.busy, onClick: load }, st.busy ? '处理中…' : '刷新')),

        // ── 「你是这个班的谁」────────────────────────────────────────
        // 只在两种情况出现：还没填过（identified=false，那时学号是
        // 系统用户名 Administrator 这种），或者自己点名字要改。
        // 不填也能用，但老师那边看到的提问者就是一串机器用户名 ——
        // 所以这里要把后果说清楚，而不是强制填。
        // 就绪清单 / 首次设置向导。
        // 原来这里只有一个「我是谁」卡片，现在扩成三件事的清单 ——
        // 「面板是空的」有四种完全不同的原因，而界面上看起来一模一样。
        h(ReadinessCard, { st, set, onIdentify }),
        st.error ? h('div', { className: 'k52 k53', style: { margin: '8px 14px 0' } }, st.error) : null,
        st.notice ? h('div', { className: 'k52 k62', style: { margin: '8px 14px 0' } }, st.notice) : null,
        st.katexError ? h('div', { className: 'k52 k53', style: { margin: '8px 14px 0' } }, '公式渲染不可用：' + st.katexError) : null,
        h('div', { className: 'k25' },
          h('div', { className: 'k86 k44', 'data-open': st.rail === false ? '0' : '1' },
            h('div', { className: 'k87', onClick: toggleRail,
              title: st.rail === false ? '展开课时脉络' : '收起课时脉络（折叠成一条竖标签）' },
              h('span', { className: 'k89' }, st.rail === false ? '»' : '«'),
              h('span', { className: 'k88' }, '课时脉络')),
            st.rail === false ? null : h('div', { className: 'k8a' },
              h('div', { className: 'k64' }, '章节'),
              h('div', { className: 'k70' }, ((st.info && st.info.chapters) || ['第一章']).map((ch) => h('span', {
                key: ch, className: 'k71', 'data-on': st.chapter === ch ? '1' : '0', onClick: () => switchChapter(ch),
              }, ch))),
              h('div', { className: 'k64' }, '课时（点一下进入作业批改）'),
              h('div', { className: 'k1' }, st.tree ? h(Fishbone, {
                tree: st.tree, selected: Number(st.hwLesson) || 0,
                onPick: (ls) => openLesson(ls.no),
              }) : h('div', { className: 'k21' }, '索引加载中…')))),
          h('div', { className: 'k8c' },
            // 只在**出错或数据没到位**时显示状态自述。正常使用时完全不占地方。
            // 保留它的理由：面板"打开了但没数据"这类问题，没有观测手段就只能猜，
            // 而为此猜错了好几轮。真正出问题时它会把原因直接写在界面上。
            (st.error || !st.info) ? h('div', { style: { fontSize: '11px', color: '#ffb74d', padding: '4px 14px', lineHeight: '1.6', borderTop: '1px solid var(--dsw-alias-border-l1)' } },
              'state: info=' + (st.info ? '有' : '空')
              + '  tree=' + (st.tree ? '有' : '空')
              + '  slides=' + (st.slides ? '有' : '空')
              + '  view=' + st.view
              + '  error=' + (st.error ? String(st.error).slice(0, 80) : '无')) : null,
            // 每个视图各自包一层错误边界（vBound）。写在最外层的话，任何一个视图里
            // 抛出一次（例如 PickTab 里那个 undefined.chapter）就把整个面板变成红屏 ——
            // 学生连「换个标签页继续用」都做不到，而且看不出是哪个视图坏的。
            st.view === 'outline' ? h(PanelBoundary, { label: '大纲' }, h(CourseOutline, { st, set, onOpenLesson: openLesson })) : null,
            // 课件页：左视口 + 右提问区。两列而不是上下堆叠 —— 见 AskPanel 的注释。
            st.view === 'slides' ? h(PanelBoundary, { label: '课件' }, h('div', { className: 'k90' },
              h('div', { className: 'k91' },
                h(Slides, { st, set, onAddPick: addPick, pageHasPick: pageHasPick, slideRef: slideRef })),
              h(AskPanel, { st, set, onAsk: onAsk, onRemovePick: removePick, onClearPicks: clearPicks }))) : null,
            st.view === 'threads' ? h(PanelBoundary, { label: '我的提问' }, h('div', { className: 'k27' }, h(ThreadList, { st, set, onOpen: openThread, onShare: shareItem, onShareBatch: shareBatch }))) : null,
            st.view === 'public' ? h(PanelBoundary, { label: '公开问答' }, h('div', { className: 'k27' }, h(PublicQA, { st, set, onOpen: openThread, onSync }))) : null,
            st.view === 'thread' ? h(PanelBoundary, { label: '问答详情' }, h('div', { className: 'k27' }, h(ThreadView, { st, set, onFollowup }))) : null,
            st.view === 'lesson' ? h(PanelBoundary, { label: '课时作业' }, h('div', { className: 'k27' }, h(LessonPage, { st, set, onGrade: onGrade, onAssignPick: assignPick }))) : null,
            st.view === 'submit' ? h(PanelBoundary, { label: '提交历史' }, h('div', { className: 'k27' }, h(SubmissionHistory, { st, set, onGrade: onGrade, onOpenLesson: openLesson }))) : null,
            st.view === 'usage' ? h(PanelBoundary, { label: '额度' }, h('div', { className: 'k27' }, h(Usage, { st }))) : null)))
    }

    /**
     * 面板错误边界：把**渲染期异常**画在面板位置上，而不是只丢进控制台。
     *
     * ⚠️ 这里必须用 class + getDerivedStateFromError，不能用 try/catch 包住
     *    h(Panel, props)。后者只是**创建**一个元素，React 之后才在自己的
     *    渲染阶段调用 Panel —— try/catch 在那一层根本拦不到。
     *    （我第一版就是这么写的，白写了。）
     */
    const PanelBoundary = (function () {
      const Base = (React && React.Component) || function () { }
      function Boundary(props) { Base.call(this, props); this.state = { err: null } }
      Boundary.prototype = Object.create(Base.prototype || Object.prototype)
      Boundary.prototype.constructor = Boundary
      Boundary.getDerivedStateFromError = function (err) { return { err: err } }
      Boundary.prototype.componentDidCatch = function (err, info) {
        console.error('[cip-stu] 面板渲染异常', err, info)
      }
      Boundary.prototype.render = function () {
        if (!this.state || !this.state.err) return this.props.children
        const e = this.state.err
        const label = (this.props && this.props.label) || '面板'
        return h('div', { className: 'k46', style: { padding: '14px', fontFamily: 'Consolas,monospace', fontSize: '12.5px', lineHeight: '1.6' } },
          h('div', { className: 'k52 k53', style: { marginBottom: '8px' } },
            '「' + label + '」这一块渲染失败了（其余标签页仍可用）'),
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 700 } }, String((e && e.message) || e)),
          h('pre', { className: 'k39', style: { marginTop: '8px' } },
            String((e && e.stack) || '').split('\n').slice(0, 12).join('\n')),
          h('div', { className: 'k57', style: { marginTop: '8px' } }, '把这段截图发出来即可定位。'))
      }
      return Boundary
    })()

    const inject = ['slots', 'timer']
    function apply(ctx) {
      const disposers = []
      // 传入本面板自己的样式表；两个面板的表可以共存（id 不同）
      ensureCss(CFG.css, CFG.cssId)
      try {
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: '鼹鼠仔（学生）',
        }, (props) => h(StuIcon, props))))
      } catch (error) { console.error('[cip-stu] 侧栏注册抛错', error) }
      try {
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID,
        },
        // ⚠️ 契约：渲染回调必须**返回 React 元素**，不能返回「调用组件函数的结果」。
        //   正确：h(PanelBoundary, null, h(Panel))   ← h(Panel) 只创建元素
        //   错误：h(PanelBoundary, null, h(Panel, {}))  ← 会把 Panel 当普通函数调用，
        //          hook 不绑定到 React 渲染上下文 → useState 拿不到状态 →
        //          请求都成功、界面永远停在初始值，且点不动按钮。
        //   对照官方 @dsh-market/plugin：() => createElement(Boundary, ..., createElement(MarketPanel, ...))
        () => h(PanelBoundary, null, h(Panel)))))
      } catch (error) { console.error('[cip-stu] 主面板注册抛错', error) }
      ctx.effect(() => () => {
        for (const d of disposers) { try { d() } catch (error) { console.error('[cip-stu] dispose failed', error) } }
      }, 'course-student cleanup')
      console.log('[cip-stu] client apply 完毕（v1）')
    }

    exports.name = 'course-panel-student'
    exports.inject = inject
    exports.apply = apply
    // 供自动化测试直接驱动组件（校验脚本用它验证「set 是合并语义」这类
    // 光看代码看不出来的问题）。运行时 DSH 只读 name/inject/apply，多这一个键无副作用。
    // SlideTextChip / pickLabel 挂出来是为了让校验脚本能直接测「框内取字」与
    // 「证据条标题」这两件纯逻辑 —— 它们决定了跨页证据到底带上了什么，
    // 而这类错（取到空文字、标题写成 undefined）在界面上很不起眼。
    // SlideTextChip / pickLabel：框内取字与证据条标题（纯逻辑，决定跨页证据到底带上了什么）
    // LessonForm / LessonPage / Markdown：课时页的验收靠单独驱动它们 ——
    //   三个提交页签是条件渲染的，只渲染外层看不到另外两页的文案。
    exports.__components = { Panel: Panel, ReadinessCard: ReadinessCard, SlideTextChip: textInBox, pickLabel: pickLabel, LessonForm: LessonForm, LessonPage: LessonPage, Markdown: Markdown }
    return module.exports
  },
})
