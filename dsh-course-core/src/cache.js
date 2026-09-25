/**
 * 课程面板的缓存层（内存 + 可选磁盘快照）
 *
 * 为什么需要它：
 *   面板每次打开（`info` / `tree` / `submission.all`）都要读一批派生数据 ——
 *   课程结构索引、每课时的教案是否真的存在、每个课时的提交版本清单。
 *   这些都不是原始数据，而是「从原始数据算出来的」。每次重算的代价是：
 *     · `buildTree` 对 30 个课时逐个 `existsSync` 查教案
 *     · `submission.all` 扫一遍提交目录、每个版本再列一次附件目录
 *   学生每刷新一次面板都付这个成本，而原始数据一分钟内根本不会变。
 *
 * 两条设计原则：
 *
 * 1. **单一事实来源仍然是磁盘上的原始文件。** 缓存只是加速，不是权威。
 *    任何缓存条目都带「来源文件 + mtime + size」，原始文件一变就整体失效。
 *    这样最坏情况是「多算一次」，绝不会出现「缓存说教案在、实际不在」。
 *
 * 2. **磁盘快照是可选的，且坏了就当没有。** 进程重启后内存缓存是空的，
 *    磁盘快照能让第一次读取也快。但快照文件被手改坏、版本不符、或工作区被
 *    换掉时，必须静默退回重算 —— 缓存把面板弄崩是最不可接受的失败方式。
 *
 * ⚠️ 为什么不缓存模型调用的结果：那类数据（AI 答复）是**学生的钱**换来的，
 *   一旦缓存错位就会给出「看起来对、其实答的是别的问题」的内容。不值得。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 内存条目：key → { value, src: {file,mtime,size}, at } */
const mem = new Map()

/** 取一个文件的「指纹」。文件不存在时返回 null（调用方据此放弃缓存）。 */
export function statOf(absFile) {
  try {
    const st = fs.statSync(absFile)
    return { file: absFile, mtime: st.mtimeMs, size: st.size }
  } catch (e) { return null }
}

/** 两个指纹是否一致。任一为 null 都视为不一致（宁可重算）。 */
export function sameStat(a, b) {
  if (!a || !b) return false
  return a.file === b.file && a.mtime === b.mtime && a.size === b.size
}

/**
 * 磁盘快照目录：`课程中心/.cache/`。
 *
 * 放这里而不是系统临时目录，是为了「跟着工作区走」——
 * 学生 clone 公开仓、老师换机器，缓存该跟着换，不该串用。
 * 这个目录在 .gitignore 里，不会被提交。
 */
export function cacheDir(workspace) {
  return path.join(workspace, '课程中心', '.cache')
}

/**
 * 读一条缓存：先内存，再磁盘快照。
 * 命中条件：来源指纹一致。任何异常都当作未命中。
 */
export function readCache(workspace, key, stat) {
  if (!stat) return null
  const hit = mem.get(key)
  if (hit && sameStat(hit.src, stat)) return hit.value
  try {
    const file = path.join(cacheDir(workspace), key + '.json')
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && j.version === 1 && sameStat(j.src, stat)) {
      mem.set(key, { value: j.value, src: stat, at: Date.now() })
      return j.value
    }
  } catch (e) { /* 快照缺失或损坏：未命中 */ }
  return null
}

/**
 * 写一条缓存。磁盘写失败**不影响**内存缓存与调用方 ——
 * 缓存写不进去最多是「下次重算」，不该让任何功能失败。
 */
export function writeCache(workspace, key, stat, value) {
  mem.set(key, { value, src: stat, at: Date.now() })
  if (!stat) return
  try {
    const dir = cacheDir(workspace)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, key + '.json'),
      JSON.stringify({ version: 1, savedAt: new Date().toISOString(), src: stat, value }), 'utf8')
  } catch (e) { /* 忽略：缓存写入不是关键路径 */ }
}

/** 清掉全部缓存（内存 + 磁盘）。加教案、改索引之后想立刻生效时用它。 */
export function clearCache(workspace) {
  mem.clear()
  try { fs.rmSync(cacheDir(workspace), { recursive: true, force: true }) } catch (e) { /* 忽略 */ }
}

/**
 * 带缓存的取值。
 *
 * @param workspace 工作区绝对路径（决定磁盘快照放哪）
 * @param key       缓存键（同一工作区内唯一）
 * @param stat      来源指纹；null 表示「无法判断新鲜度」→ 不缓存，直接算
 * @param compute   真正的计算函数（可以是 async）
 * @param traces    可选数组，用来记录「命中 / 未命中」，便于诊断页观察
 */
export async function cached(workspace, key, stat, compute, traces) {
  const hit = readCache(workspace, key, stat)
  if (hit !== null) {
    if (traces) traces.push('缓存命中: ' + key)
    return hit
  }
  const value = await compute()
  writeCache(workspace, key, stat, value)
  if (traces) traces.push('缓存未命中，已重算: ' + key)
  return value
}

/** 给诊断页看：当前内存里有几条、都是什么。 */
export function cacheInfo() {
  return [...mem.entries()].map(([k, v]) => ({ key: k, at: new Date(v.at).toISOString(), hasSrc: !!v.src }))
}
