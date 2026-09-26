<#
  课程环境一键装置 —— 学生端
  ================================================================
  你在课程的公开仓里，这个脚本把剩下的事全做完：
    1. 检查 Node.js
    2. 检查 / 安装 DSH
    3. 从本仓 panel/ 安装「课程问题池」面板插件
    4. 把「课程工作区」指向你 clone 下来的这个目录
    5. 建好你自己的私有数据目录
    6. 指引你配置自己的 API Key

  用法（在本仓根目录打开 PowerShell）：
      powershell -ExecutionPolicy Bypass -File .\install.ps1

  想先看看会做什么、不实际改动：
      powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun

  关于权限：
    · 脚本不下载任何第三方代码，只调用 npm / dsh
    · 插件就在本仓 panel/ 下（dsh-course-student + dsh-course-core 两个包），
      是纯文本 JS，你可以自己打开看
    · 它只读写下面这个目录（也就是本仓），不碰你机器上的别处

  第 4 步为什么必要：
    插件要靠「课程工作区」找到课程数据和你的提问记录。工作区里必须有
    一个 课程中心 目录（本仓自带）。学生把仓 clone 到哪台机器的哪个位置
    都可能，所以这个路径必须由安装脚本写下来告诉插件 —— 否则面板会
    打开一片空白，还不报错，很难查。
#>

[CmdletBinding()]
param(
  [switch]$DryRun,          # 只显示将要执行的操作，不做任何改动
  [string]$Profile = 'web'  # DSH profile 名，默认 web
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say  { param([string]$m) Write-Host $m }
function Ok   { param([string]$m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "  [注意] $m" -ForegroundColor Yellow }
function Bad  { param([string]$m) Write-Host "  [失败] $m" -ForegroundColor Red }
function Step { param([string]$m) Write-Host "`n== $m ==" -ForegroundColor Cyan }
function Have { param([string]$cmd) return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Say ""
Say "  深度学习课程 · 环境一键装置"
Say "  ------------------------------------------------------------"
Say "  仓库：$RepoRoot"
if ($DryRun) { Warn "DryRun 模式：只显示操作，不做任何改动" }

# ── 0. 先确认自己在正确的目录 ─────────────────────────────────
Step "0/6  确认仓库完整"
$need = @(
  (Join-Path $RepoRoot '课程中心\课程结构索引.json'),
  (Join-Path $RepoRoot 'panel\dsh-course-student\package.json'),
  (Join-Path $RepoRoot 'panel\dsh-course-core\package.json')
)
$missing = @()
foreach ($p in $need) { if (-not (Test-Path $p)) { $missing += $p } }
if ($missing.Count) {
  Bad "本仓缺少这些文件，clone 可能不完整："
  foreach ($m in $missing) { Say "        $m" }
  Say "        请在仓库根目录重跑，或重新 clone。"
  exit 1
}
Ok "课程数据与插件都在"

# ── 1. Node.js ────────────────────────────────────────────────
Step "1/6  检查 Node.js"
if (Have node) {
  $nodeVer = (& node --version) -replace '^v',''
  $major = [int]($nodeVer -split '\.')[0]
  if ($major -ge 20) { Ok "node v$nodeVer" }
  else {
    Bad "node v$nodeVer 太旧，DSH 需要 >= 20"
    Say "        请到 https://nodejs.org 装 LTS 版后重跑本脚本"
    exit 1
  }
} else {
  Bad "没找到 node"
  Say "        请先安装 Node.js（https://nodejs.org，选 LTS），然后重开终端重跑"
  exit 1
}

# ── 2. DSH ───────────────────────────────────────────────────
# 为什么不能只查 `dsh`（这是实测踩出来的）：
#   本机装完 @deepseek-ai/dsh 之后，全局 node_modules 里有包、bin.js 能跑，
#   但 %APPDATA%\npm 下**一个 bin shim 都没生成**（dsh.cmd / dsh.ps1 / dsh 全缺）。
#   于是 PATH 上永远找不到 dsh，只查命令名会误判成「没装」并反复重装。
#   所以按「命令名 → 常见 shim 路径 → 包内 bin.js」三层依次找，最后一层最稳。
function Resolve-Dsh {
  $c = Get-Command dsh -ErrorAction SilentlyContinue
  if ($c) { return @{ How = @($c.Source); Show = $c.Source } }

  $shims = @(
    (Join-Path $env:APPDATA 'npm\dsh.cmd'),
    (Join-Path $env:LOCALAPPDATA 'pnpm\dsh.cmd'),
    (Join-Path $env:ProgramFiles 'nodejs\dsh.cmd')
  )
  foreach ($s in $shims) { if (Test-Path $s) { return @{ How = @($s); Show = $s } } }

  $bins = @(
    (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'),
    (Join-Path $env:LOCALAPPDATA 'pnpm\global\5\node_modules\@deepseek-ai\dsh\lib\bin.js')
  )
  foreach ($b in $bins) {
    if (Test-Path $b) { return @{ How = @('node', $b); Show = "$b（经 node 直接调用）" } }
  }
  return $null
}

function Invoke-Dsh {
  param([string[]]$DshHow, [string[]]$DshArgs)
  if ($DshHow.Count -eq 1) { & $DshHow[0] @DshArgs }
  else { & $DshHow[0] $DshHow[1] @DshArgs }
}

Step "2/6  检查 DSH"
$dsh = Resolve-Dsh
if ($dsh) {
  Ok "dsh 已安装（$($dsh.Show)）"
} else {
  Warn "没找到 dsh，需要安装 @deepseek-ai/dsh"
  if ($DryRun) {
    Say "        [DryRun] 将执行：npm i -g @deepseek-ai/dsh"
  } else {
    Say "        执行：npm i -g @deepseek-ai/dsh"
    & npm i -g '@deepseek-ai/dsh'
    if ($LASTEXITCODE -ne 0) { Bad "安装失败，请把上面的报错发到 issue"; exit 1 }
    # 装完再解析一次；PATH 可能还没刷新，Resolve-Dsh 的兜底会接住
    $env:PATH = "$env:PATH;$env:APPDATA\npm"
    $dsh = Resolve-Dsh
    if (-not $dsh) {
      Bad "装完了但找不到 dsh 的入口"
      Say "        请把下面这条命令的输出发到 issue："
      Say "        Get-ChildItem `"$env:APPDATA\npm`" -Filter dsh*"
      exit 1
    }
    Ok "dsh 安装完成（$($dsh.Show)）"
  }
}
# 单独取 bin.js 路径，供「先配 Key」的提示使用（How 为 1 或 2 个元素，不能靠 [-1]）
$binPath = if ($dsh -and $dsh.How.Count -ge 2) { $dsh.How[1] } else { 'dsh' }

# ── 3. 面板插件 ───────────────────────────────────────────────
Step "3/6  安装「课程问题池」面板插件"
# 学生端与教师端是两个独立插件，共享一个内核，三个都要装。
# 内核是「按相对位置算绝对路径」装载的，所以三个包必须并排放在 panel\ 下 ——
# 装的时候也只装目录，不要把某个包单独挪走。
$pluginDirs = @(
  (Join-Path $RepoRoot 'panel\dsh-course-student'),
  (Join-Path $RepoRoot 'panel\dsh-course-core')
)
foreach ($d in $pluginDirs) {
  if (-not (Test-Path (Join-Path $d 'package.json'))) {
    Bad "在 $d 里找不到 package.json"
    Say "        这些目录应该随仓库一起 clone 下来。请确认 clone 完整。"
    exit 1
  }
}
Ok "插件源：panel\（学生端 + 共享内核，纯 JS，可自行查看）"

if ($DryRun) {
  foreach ($d in $pluginDirs) { Say "        [DryRun] 将执行：dsh plugin --profile $Profile add `"$d`"" }
} else {
  foreach ($d in $pluginDirs) {
    Say "        执行：dsh plugin --profile $Profile add $(Split-Path -Leaf $d)"
    Invoke-Dsh -DshHow $dsh.How -DshArgs @('plugin', '--profile', $Profile, 'add', $d)
    if ($LASTEXITCODE -ne 0) {
      Bad "插件安装失败（$(Split-Path -Leaf $d)）"
      Say "        常见原因：pnpm 没装。可先执行：npm i -g pnpm"
      Say "        然后把上面的完整报错发到 issue。"
      exit 1
    }
  }
  Ok "插件已装入 profile「$Profile」（学生端 + 内核）"
  Say "        你是学生端，所以只装这两个；教师端插件在老师的机器上。"
}

# ── 4. 课程工作区 ─────────────────────────────────────────────
Step "4/6  把课程工作区指向本仓"
$wsFile = Join-Path $env:USERPROFILE '.dsh\cip-workspace.txt'
Say "  工作区 = 你 clone 下来的这个目录："
Say "        $RepoRoot"
Say "  插件会读它下面的 课程中心\（课件与结构）和 课程问题池\（你的提问）。"
if ($DryRun) {
  Say "        [DryRun] 将写入：$wsFile"
} else {
  $dshHome = Join-Path $env:USERPROFILE '.dsh'
  if (-not (Test-Path $dshHome)) { New-Item -ItemType Directory -Force -Path $dshHome | Out-Null }
  $lines = @(
    '# 课程工作区路径 —— 由 install.ps1 写入，供「课程问题池」面板插件读取。',
    '# 想换位置（比如把仓挪走了），改这一行即可；也可以用环境变量 CIP_WORKSPACE 覆盖。',
    $RepoRoot
  )
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($wsFile, $lines, $enc)
  Ok "已写入 $wsFile"
}

# ── 4b. 你的学生身份 ──────────────────────────────────────────
# 提问与作业会归到这个名字下。老师那边看到的是「谁问的」，
# 所以别写「anonymous」——不然老师汇总共性问题时分不清是几个学生。
Step "4b   你的学生身份"
$stu = $env:CIP_STUDENT
if (-not $stu) { $stu = $env:USERNAME }
Say "  默认用你的系统用户名：$stu"
Say "  想换（例如用学号），随时设环境变量 CIP_STUDENT 后重启面板。"
Say "  它只用于把提问/作业归到你名下，不影响任何权限。"

# ── 4c. 课程标识：把索引里的真实课名写进 课程配置.json ──────────────
#
# 为什么要有这一步（端侧实测踩到）：面板顶栏显示的是 课程配置.json 里的 title，
# 而这份文件以前**没人写** —— 于是它要么不存在（用内置默认值），要么里面是
# 老师当初随手填的占位名。实测那台机器上显示的是「深度学习课程」，
# 而真实课名在 课程结构索引.json 里写得清清楚楚。
# 学生第一眼看的就是这个课名，写错等于告诉他「你在上另一门课」。
#
# 只写**索引里有的事实**：课名、模块名、总课时。
# 章的映射（"第一章 = 哪几个模块"）索引里没有 Declaration，所以**不猜** ——
# 那需要老师补，猜错会让按章节名匹配的功能（如课件归位）认错位置。
Step "4c   课程标识（写 课程配置.json）"
$cfgPath = Join-Path $RepoRoot '课程配置.json'
$idxPath = Join-Path $RepoRoot '课程中心\课程结构索引.json'
if (Test-Path $idxPath) {
  try {
    $idx = Get-Content $idxPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg = [ordered]@{
      '_说明' = '课程标识。面板顶栏显示的就是这里的 title；换一门课只改这个文件，不需要改代码。'
      '_来源' = '由 install.ps1 从 课程中心\课程结构索引.json 生成；改课名改这里，或重跑 install.ps1。'
      'title' = [string]$idx.course
      'code'  = ''
      'term'  = ''
      'goal'  = ''
      'note'  = ''
      'layout' = [ordered]@{
        'modules' = @($idx.modules | ForEach-Object { [string]$_.name })
      }
      '_待补' = 'layout.chapters 是"章 → 模块"的映射，索引里没有这个信息，需要老师确认后手填（例如 ["模块一","模块二"] 之类）。留空则用内置默认值 第一章..三。'
    }
    if ($DryRun) {
      Say "        [DryRun] 将写入：$cfgPath"
      Say "        [DryRun]   title = $($idx.course)"
      Say "        [DryRun]   layout.modules = $(($idx.modules | ForEach-Object { $_.name }) -join '、')"
    } else {
      $json = ($cfg | ConvertTo-Json -Depth 6)
      # 明确写 UTF-8 无 BOM：这份文件会被 Node 读（JSON.parse），带 BOM 会让它解析失败。
      # 踩过的坑：PowerShell 的 Set-Content -Encoding UTF8 在 5.1 下**会加 BOM**。
      [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      Ok "已写入 $cfgPath"
      Say "        课名：$($idx.course)"
      Say "        模块：$(($idx.modules | ForEach-Object { $_.name }) -join '、')"
      Say "        （章节映射索引里没有，需要老师补；不补就用默认值）"
    }
  } catch {
    Warn "读索引失败，跳过课程配置：$($_.Exception.Message)"
  }
} else {
  Warn "找不到 $idxPath，跳过课程配置（面板会用内置默认值）"
}

# ── 5. 你自己的私有数据目录 ───────────────────────────────────
Step "5/6  建好你的私有数据目录"
$dirs = @(
  (Join-Path $RepoRoot '课程问题池\问题条目'),
  (Join-Path $RepoRoot '课程问题池\FAQ'),
  (Join-Path $RepoRoot '作业提交')
)
if ($DryRun) {
  foreach ($d in $dirs) { Say "        [DryRun] 将创建：$d" }
} else {
  foreach ($d in $dirs) {
    if (Test-Path $d) { Ok "已存在：$(Split-Path -Leaf (Split-Path -Parent $d))\$([System.IO.Path]::GetFileName($d))" }
    else { New-Item -ItemType Directory -Force -Path $d | Out-Null; Ok "已创建：$d" }
  }
}
Say ""
Say "  这三个目录里只放你自己的东西：你的提问、AI 给你的回答、你交的作业。"
Say "  它们不会被提交、不会上传给老师 —— 除非你自己把某次提问整理成 issue 发出去。"
Say "  （本仓的 .gitignore 已经把这些目录忽略掉了，不会误提交。）"

# ── 6. 你自己的 API Key ───────────────────────────────────────
Step "6/6  配置你自己的模型 API Key"
$cred = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
if (Test-Path $cred) {
  Ok "已找到 $cred"
  Say "        （脚本不读取也不修改它）"
  Say ""
  Say "  启动（用本仓自带的脚本，它不依赖 PATH）："
  Say "        powershell -ExecutionPolicy Bypass -File .\start.ps1"
  Say ""
  Say "  浏览器打开它给出的地址，侧栏底部会出现「课程问题池」图标。"
} else {
  Warn "还没有配置 API Key"
  Say ""
  Say "  面板的 AI 答疑需要你自己的模型账号。请按下面两步做："
  Say ""
  Say "    (1) 先跑一次 dsh，它会引导你配置 provider 与 API Key："
  Say "            node `"$binPath`""
  Say "        key 会写进 $cred"
  Say ""
  Say "    (2) 配好后启动："
  Say "            powershell -ExecutionPolicy Bypass -File .\start.ps1"
  Say ""
  Warn "你的 Key 只存在你本机，不经过老师的服务器，老师看不到它。"
  Warn "问一次消耗的是你自己账号的额度。"
}

Say ""
Say "  ------------------------------------------------------------"
Say "  接下来怎么用（你是学生端）："
Say "    · 顶部「章节」→ 切第一/二/三章"
Say "    · 「课件」→ 框选一块（公式/截图）直接提问"
Say "    · 「教案」→ 拖选一段文字后提问"
Say ""
Say "  你的问题默认只属于你自己：老师看到后决定哪些值得共享给全班。"
Say "  这样能避免「某个人脑子短路」的问题占用所有人的注意力。"
Say ""
Say "  想让老师看到某个问题，请走本仓 Issues（模板：课程提问）。"
Say "  细则见 docs/学生端接入.md"
Say ""
if ($DryRun) { Warn "以上是 DryRun，什么都没改。去掉 -DryRun 真正执行。" }
