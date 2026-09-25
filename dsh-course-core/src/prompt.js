/**
 * 提示词与模型往返 —— 学生端与教师端共用
 *
 * 这里承载三件必须两边一致的事：
 *   1. 每一轮追问都要**完整作答**（不是「同上」）—— 代价是每轮都真的花一次 token，
 *      这正是老师说的「隐性提问」，费用归发起方。
 *   2. 标题凝练必须用**同一套风格**，否则问题池看起来像好几个人写的。
 *   3. 问题总结与标题出自同一套口径，方便老师扫读与归档。
 */
import { oneLine, callModel, msg, STUDENT_SYSTEM, TITLE_SYSTEM, SUMMARY_SYSTEM, GRADER_SYSTEM, TOPICS, FACETS_SYSTEM } from './host.js'

function base64ToBytes(dataUrl) {
  const s = String(dataUrl || '')
  const i = s.indexOf(',')
  return Buffer.from(i >= 0 ? s.slice(i + 1) : s, 'base64')
}

const KIND_LABEL = { region: '框选图区', text: '拖选文字', page: '整页截图' }

/** 把证据块拼成提示词里的一段。
 *  明确写出「第几张图对应哪一块」，是为了让模型知道每张图的出处 ——
 *  否则多图一起发过去，它很容易把两张图的结论混起来。 */
function formatEvidenceForModel(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return ''
  const out = ['', '【学生提供的 ' + evidence.length + ' 块内容】']
  evidence.forEach((e, i) => {
    out.push((i + 1) + '. ' + e.chapter + ' 第 ' + e.page + ' 页 · ' + (KIND_LABEL[e.kind] || '内容'))
    if (e.note) out.push('   （截图说明：' + e.note + '）')
    if (e.text) out.push('   ' + e.text.replace(/\n+/g, '\n   ').slice(0, 700))
  })
  return out.join('\n')
}

function buildPrompt(question, anchorText, evidence, imageCount) {
  const q = oneLine(question) || '这块内容是什么意思？请解释其中的关键推导。'
  const parts = ['【学生提问】', q]
  if (anchorText) parts.push('', '【学生指着的内容】', String(anchorText).slice(0, 1500))
  const evText = formatEvidenceForModel(evidence)
  if (evText) parts.push(evText)
  if (imageCount > 0) {
    parts.push('', '（本次消息带 ' + imageCount + ' 张图，按上面证据的编号顺序排列 —— '
      + '第 N 张图就是第 N 块内容。它们可能是学生从**不同页**框的，'
      + '请先各自读懂，再合并回答；如果两块内容有矛盾或不连续，请直接指出。）')
  }
  return parts.join('\n')
}

/**
 * 跑一轮问答。history 是之前的轮次（按时间正序），每轮 {q, a}。
 * 图片只挂在**本轮**消息上 —— 历史轮次的图不重放，否则 token 会随轮数线性膨胀。
 *
 * 支持**多张图**：一个知识点常横跨好几页，只允许一张会把学生的问题砍掉一半。
 * 上限由调用方（学生端 host 的 MAX_IMAGES）控制，这里只负责尽力附上。
 */
export async function runTurn(ctx, { question, anchorText, evidence, images, dataUrl, history, trace, choice }) {
  const log = trace || []
  const messages = []
  for (const turn of history || []) {
    messages.push(msg('user', String(turn.q || '')))
    messages.push(msg('assistant', String(turn.a || '')))
  }
  let urls = Array.isArray(images) ? images.filter((u) => typeof u === 'string' && u) : []
  if (!urls.length && dataUrl) urls = [dataUrl]   // 兼容单图调用方
  const text = buildPrompt(question, anchorText, evidence, urls.length)
  const content = [{ type: 'text', text }]
  let imageAttached = 0
  for (let i = 0; i < urls.length; i += 1) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) { log.push('附件服务不可用，第 ' + (i + 1) + ' 张图未随消息发送'); continue }
    try {
      const bytes = base64ToBytes(urls[i])
      log.push('截图 ' + (i + 1) + ' 字节: ' + bytes.length)
      const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'region-' + (i + 1) + '.png' })
      log.push('附件已保存: ' + ref.width + 'x' + ref.height)
      content.push({ type: 'image', attachment: ref })
      imageAttached += 1
    } catch (error) { log.push('附件保存失败(' + (i + 1) + '): ' + oneLine(error && error.message)) }
  }
  const last = msg('user', text)
  last.content = content
  messages.push(last)
  log.push('消息块: ' + content.map((c) => c.type).join(' + ') + ' / 共 ' + messages.length + ' 条')
  const r = await callModel(ctx, { system: STUDENT_SYSTEM, messages, trace: log, choice: choice })
  return { answer: r.text, usage: r.usage, imageAttached }
}

/**
 * 一次调用同时产出：凝练标题 + 知识领域分类 + 概念标签。
 *
 * 为什么合成一次调用：标题本来就要花一次模型调用，把分类并进去**不额外加钱**，
 * 而分开做会让每次提问多一次往返（学生端的费用是学生自己承担的，能省则省）。
 *
 * 分类用受控词表（TOPICS），不接受自由标签 —— 理由见 host.js 里 TOPICS 的注释。
 * 概念标签是自由文本，但要求「尽量用课程里的术语、2-12 字、最多 3 个」。
 *
 * 任何一步失败都回落，绝不阻断提问本身。
 */
export async function makeFacets(ctx, { question, anchorText, trace, choice }) {
  const log = trace || []
  const fallbackTitle = (oneLine(question) || '未命名提问').slice(0, 60)
  const fallback = { title: fallbackTitle, topic: '其他', concept: '', usage: { inputTokens: 0, outputTokens: 0 } }
  try {
    const r = await callModel(ctx, {
      system: FACETS_SYSTEM,
      messages: [msg('user', '学生提问：' + oneLine(question) + (anchorText ? '\n他指着的内容：' + String(anchorText).slice(0, 600) : ''))],
      trace: log,
      // 标题与分类也用同一个模型：用便宜模型答题、却用强模型起标题，
      // 会让「这条为什么这么贵」查不清。
      choice: choice,
    })
    let obj = null
    try {
      // 允许模型把 JSON 包在 ```json 里
      const raw = String(r.text || '').replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '')
      obj = JSON.parse(raw.trim().startsWith('{') ? raw.trim() : String(r.text).trim())
    } catch (e) { log.push('分类 JSON 解析失败，改用纯文本标题回落') }
    if (obj && typeof obj === 'object') {
      const title = oneLine(obj.title).replace(/^["'「『]+|["'」』]+$/g, '').replace(/[。．.]+$/, '')
      const topic = TOPICS.indexOf(oneLine(obj.topic)) >= 0 ? oneLine(obj.topic) : '其他'
      const concept = oneLine(obj.concept).slice(0, 40)
      return { title: (title || fallbackTitle).slice(0, 60), topic, concept, usage: r.usage }
    }
    // 没解析出 JSON：把整段文本当标题用（老行为）
    const t = oneLine(r.text).replace(/^["'「『]+|["'」』]+$/g, '').replace(/[。．.]+$/, '')
    if (t) return { title: t.slice(0, 60), topic: '其他', concept: '', usage: r.usage }
  } catch (e) { log.push('标题/分类生成失败（改用提问原文）: ' + oneLine(e && e.message)) }
  return fallback
}

/** 兼容旧调用点：只要标题时用它。 */
export async function makeTitle(ctx, args) {
  const r = await makeFacets(ctx, args)
  return { title: r.title, usage: r.usage }
}

/** 问题总结（两到三句）。同样失败不阻断主流程。 */
export async function makeSummary(ctx, { question, answer, thread, trace, choice }) {
  const log = trace || []
  const parts = ['【学生最初的提问】', oneLine(question)]
  if (answer) parts.push('', '【第一次回答】', String(answer).slice(0, 2000))
  const turns = (thread || []).slice(-3)
  if (turns.length) {
    parts.push('', '【后续追问】')
    turns.forEach((t, i) => parts.push('第 ' + (i + 1) + ' 轮问：' + oneLine(t.q), '第 ' + (i + 1) + ' 轮答：' + String(t.a || '').slice(0, 800)))
  }
  try {
    const r = await callModel(ctx, { system: SUMMARY_SYSTEM, messages: [msg('user', parts.join('\n'))], trace: log, choice: choice })
    return { summary: oneLine(r.text).slice(0, 300), usage: r.usage }
  } catch (e) { log.push('问题总结失败: ' + oneLine(e && e.message)) }
  return { summary: '', usage: { inputTokens: 0, outputTokens: 0 } }
}

/**
 * 批改一次提交。
 * 教案是**对齐基准** —— 老师特别强调过，避免训练侧重点偏移：
 * 教案要求学生手写实现，学生调库绕过，就必须指出来，不能因为「结果对」就算过。
 *
 * 提交形态不止「一个 .py」：手推公式是拍照、推导是打字的、报告是 md/ipynb/pdf。
 * 所以这里收三类：
 *   code   = 打字/文本文件的内容（进提示词）
 *   files  = 附件清单（文件名 + 类型，进提示词）
 *   images = 附件里的图片（**真的作为图片发给模型**，否则「拍照上传手推公式」等于没传）
 *
 * ⚠️ 图片不是自动就带得上的：纯文本模型会拒收图片块。这里不替调用方判断
 *    「该模型支不支持图片」—— 那是面板的职责（它已经在模型选择器上标了
 *    「可看图 / 无图」，并在提交前提前提醒）。插件层硬拦反而会让学生
 *    在一个能看图的模型上被告知「不支持」。
 */
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i
export const MAX_GRADE_IMAGES = 4

export async function runGrade(ctx, { plan, code, dimensions, lesson, files, textFiles, skippedFiles, images, trace, choice }) {
  const log = trace || []
  const parts = []
  parts.push('【本课时教案】', String(plan || '（未找到教案，只能按通用工程规范初筛，请以教案为准自行核对）').slice(0, 24000))
  parts.push('', '【批改维度】')
  const dims = Array.isArray(dimensions) && dimensions.length ? dimensions : ['正确性', '与教案方法的一致性', '可复现性', '代码规范']
  for (const d of dims) parts.push('- ' + (typeof d === 'string' ? d : (d.name || JSON.stringify(d))))
  parts.push('', '【课时】' + oneLine(lesson))

  const fileList = Array.isArray(files) ? files : []
  const imageFiles = fileList.filter((f) => IMAGE_MIME.test(String(f.mediaType || '')) || /\.(png|jpe?g|webp|gif)$/i.test(String(f.name || '')))
  const otherFiles = fileList.filter((f) => imageFiles.indexOf(f) < 0)
  // 文本附件：调用方已经把内容读出来了（见学生端 host 的 TEXT_EXT 段）。
  // 没有把它放进提示词的后果很严重 —— 模型会说「这一行代码我都看不到」，
  // 然后给出一堆「无法核验」，而这门课的作业主体恰恰就是 .py / .ipynb。
  const tf = Array.isArray(textFiles) ? textFiles : []
  const tfNames = {}
  tf.forEach((x) => { tfNames[String(x.name)] = 1 })
  if (fileList.length) {
    parts.push('', '【学生这次提交的内容】')
    if (String(code || '').trim()) parts.push('- 正文（学生打的字）：见下面的【提交正文】')
    for (const f of tf) {
      parts.push('- 文本附件：' + oneLine(f.name) + '（' + f.chars + ' 字符'
        + (f.truncated ? '，**已截断**到前 ' + String(f.text || '').length + ' 字符' : '') + '）—— 内容见下方')
    }
    for (const f of otherFiles) {
      if (!tfNames[String(f.name)]) {
        parts.push('- 附件：' + oneLine(f.name) + '（' + (f.mediaType || '未知类型') + (f.bytes ? (', ' + f.bytes + ' 字节') : '') + '）—— 内容未提供')
      }
    }
    for (const f of imageFiles.slice(0, MAX_GRADE_IMAGES)) parts.push('- 照片：' + oneLine(f.name) + '（见消息里的图片）')
    if (imageFiles.length > MAX_GRADE_IMAGES) {
      parts.push('- 另有 ' + (imageFiles.length - MAX_GRADE_IMAGES) + ' 张照片未随消息发送，请只就收到的图片作答，并说明还有未看到的照片。')
    }
  }
  if (String(code || '').trim()) parts.push('', '【提交正文】', '```', String(code).slice(0, 40000), '```')
  else parts.push('', '【提交正文】', '（本次没有在输入框里写正文）')
  // 文本附件的内容逐份展开。用「=== 文件名 ===」分隔而不是靠前后文猜，
  // 是因为一门课里同时交 .py 和 .md 很常见，混在一起模型会张冠李戴。
  for (const f of tf) {
    parts.push('', '【文本附件：' + oneLine(f.name) + '】'
      + (f.truncated ? '（已截断，以下不是全文）' : ''),
      '```', String(f.text || ''), '```')
  }
  const bin = otherFiles.filter((f) => !tfNames[String(f.name)])
  if (bin.length) {
    // 确实读不出内容的（pdf / zip / docx…）要如实说，但**不要**让模型据此
    // 把整份作业判成「无法核验」—— 能读的都已经读给它了，所以要说清「其余内容可见」。
    parts.push('', '（说明：'
      + bin.map((f) => oneLine(f.name)).join('、')
      + ' 的内容**无法读取**（二进制格式）。除此之外的文本附件与正文都已完整提供给你，'
      + '请基于这些可见材料批改；只有当某个结论确实依赖那份读不出来的文件时，才记「无法核验」。）')
  }
  parts.push('', '请按批改原则逐条对照教案的验收标准，逐条给出结论与证据，最后按要求的格式输出《问题清单》。'
    + '注意：凡是上面已经提供了内容的文件（正文与文本附件），都必须**逐行看过再下结论**，'
    + '不得以「看不到代码」为由跳过；只有确实没提供内容的材料才可以记「无法核验」。')

  // 图片真的附上去。优先用调用方直接给的 images（提问截图那种用法），
  // 否则从附件清单里挑图片；两条都按 MAX_GRADE_IMAGES 截断。
  let urls = (Array.isArray(images) ? images : []).filter((u) => typeof u === 'string' && u)
  if (!urls.length) {
    urls = imageFiles.slice(0, MAX_GRADE_IMAGES)
      .map((f) => (typeof f.dataUrl === 'string' && f.dataUrl) ? f.dataUrl : null)
      .filter(Boolean)
  }
  const content = [{ type: 'text', text: parts.join('\n') }]
  let attached = 0
  for (let i = 0; i < urls.length; i += 1) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) { log.push('附件服务不可用，第 ' + (i + 1) + ' 张图未随批改请求发送'); continue }
    try {
      const bytes = base64ToBytes(urls[i])
      const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'submit-' + (i + 1) + '.png' })
      content.push({ type: 'image', attachment: ref })
      attached += 1
      log.push('批改附图 ' + (i + 1) + ': ' + ref.width + 'x' + ref.height)
    } catch (error) { log.push('批改附图失败(' + (i + 1) + '): ' + oneLine(error && error.message)) }
  }
  const last = msg('user', parts.join('\n'))
  last.content = content
  log.push('批改消息块: ' + content.map((c) => c.type).join(' + '))
  const r = await callModel(ctx, { system: GRADER_SYSTEM, messages: [last], trace: log, choice: choice })
  return { text: r.text, usage: r.usage, imagesAttached: attached }
}
