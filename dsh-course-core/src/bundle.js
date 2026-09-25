export * from './index.js'

// 这个包的主要价值在客户端共享模块 materialization。
// 宿主侧只需要一个最小可挂载插件，让 DSH 正式接纳它进入 profile bundles。
export const name = 'course-panel-core'

export async function apply() {
  // no-op
}
