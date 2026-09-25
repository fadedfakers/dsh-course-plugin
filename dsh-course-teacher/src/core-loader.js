/**
 * 装载共享内核 dsh-course-core。
 *
 * 为什么要用绝对路径动态 import：
 *   DSH 把插件装进 profile 的 node_modules 时，只保证**这个包自己**在里面。
 *   它的兄弟包（dsh-course-core）在同一个父目录下，但 Node 的裸名解析要求
 *   它出现在 node_modules/dsh-course-core 才算数 —— 两个包各自被 link 进
 *   profile 时这个名字确实存在，但依赖解析顺序不由我们控制。
 *   用「相对本包位置算出的绝对路径」导入，就没有这个不确定性：
 *   只要三个包放在一起（公开仓里它们就是并排的），一定能加载到。
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// here = <三个包的共同父目录>/<本包>/src → 上一级的上一级就是共同父目录
export const PLUGIN_ROOT = path.resolve(HERE, '..')
export const PACKS_ROOT = path.resolve(PLUGIN_ROOT, '..')
export const CORE_DIR = path.join(PACKS_ROOT, 'dsh-course-core')

let cached = null
export async function loadCore() {
  if (cached) return cached
  const entry = path.join(CORE_DIR, 'src', 'index.js')
  cached = await import(pathToFileURL(entry).href)
  return cached
}
