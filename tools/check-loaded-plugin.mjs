/**
 * 直接加载「当前 profile 实际挂载的」插件宿主半区，报告它到底是哪一版。
 *
 * 为什么要在会话里测，而不是让老师去侧栏眼看：
 *   「宿主是否已经带上了新代码」是可以**直接判**的 —— 把 profile 里那份插件
 *   按真实入口 import 一次，看它导出了什么、注册了哪些路由。能测出来的事
 *   不该推给用户。
 *
 * 判据选择说明（踩过的坑）：不拿「文件 mtime」当判据（mtime 会被无关的写操作改掉，
 * 本轮就见过一次），而是拿**代码里实际存在的东西** —— 导出的动作名。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

const PROFILE = process.argv[2] || path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web')
const nm = path.join(PROFILE, 'node_modules')

const pkgs = ['dsh-course-core', 'dsh-course-student', 'dsh-course-teacher']

console.log(`profile: ${PROFILE}\n`)

// ── 1) 依赖与挂载状态 ────────────────────────────────────────────────
const pj = path.join(PROFILE, 'package.json')
if (!fs.existsSync(pj)) {
  console.error('✗ 找不到 profile 的 package.json')
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(pj, 'utf8'))
const deps = manifest.dependencies || {}
const bundles = manifest.dsh?.profile?.bundles || []

console.log('== dependencies 里的来源 ==')
for (const p of pkgs) console.log(`  ${p.padEnd(20)} ${deps[p] ?? '（没有）'}`)
console.log('\n== dsh.profile.bundles ==')
console.log('  ' + bundles.join(', '))
console.log('\n== 挂载核查 ==')
for (const p of pkgs) {
  const inDeps = p in deps
  const inBundles = bundles.includes(p)
  const onDisk = fs.existsSync(path.join(nm, p))
  const mark = inDeps && inBundles && onDisk ? '✓' : '✗'
  console.log(`  ${mark} ${p.padEnd(20)} deps=${inDeps} bundles=${inBundles} 物化=${onDisk}`)
}

// ── 2) 实际加载宿主半区，看它是哪一版 ─────────────────────────────────
console.log('\n== 实际 import 宿主半区（这才是「加载的是哪一版」）==')
for (const p of ['dsh-course-student', 'dsh-course-teacher']) {
  const entry = path.join(nm, p, 'src', 'host.js')
  if (!fs.existsSync(entry)) {
    console.log(`  ${p}: 未物化，跳过`)
    continue
  }
  try {
    const m = await import(pathToFileURL(entry).href)
    console.log(`  ${p}:`)
    console.log(`    导出 name   = ${m.name ?? '（无）'}`)
    console.log(`    导出 inject = ${JSON.stringify(m.inject ?? [])}`)
    const keys = Object.keys(m)
    console.log(`    其他导出    = ${keys.filter((k) => k !== 'name' && k !== 'inject').join(', ') || '（无）'}`)
  } catch (e) {
    console.log(`  ${p}: import 失败 ✗ ${String(e.message).split('\n')[0]}`)
  }
}

// ── 3) 宿主源码里有没有那几个「重启后才存在」的动作 ──────────────────
// repo.status / repo.init 是上一轮才加进教师端的；它们在不在，直接说明
// 这份代码是新是旧 —— 不需要去界面上看。
console.log('\n== 教师端宿主源码里的关键动作 ==')
const teaHost = path.join(nm, 'dsh-course-teacher', 'src', 'host.js')
if (fs.existsSync(teaHost)) {
  const src = fs.readFileSync(teaHost, 'utf8')
  for (const action of ['repo.status', 'repo.init', 'publish', 'plan.', 'materials.apply']) {
    const hit = src.includes(action)
    console.log(`  ${hit ? '✓' : '✗'} ${action}`)
  }
  const m = fs.statSync(teaHost)
  console.log(`  文件 mtime = ${m.mtime.toISOString()}  (${m.size} 字节)`)
} else {
  console.log('  未物化')
}
