<#
  新用户安装演练 —— 在隔离环境里把「从 GitHub 装三个包」真跑一遍
  ================================================================
  它做什么：
    1. 把 DSH_HOME 指向系统临时区的一次性目录（不碰你真实的 ~/.dsh）
    2. 对三个包各跑一次 dsh plugin add（默认从本仓在 GitHub 上的地址装）
    3. 核对结果：三个包是否都进了 dsh.profile.bundles
    4. 删掉一次性目录

  什么情况下要跑它：
    · 发布新版本前，确认「用户从 GitHub 装」这条路没坏
    · 装完面板不出现时，确认是安装问题还是别的问题

  用法：
      powershell -ExecutionPolicy Bypass -File .\tools\probe-newuser-install.ps1
      powershell -ExecutionPolicy Bypass -File .\tools\probe-newuser-install.ps1 -RepoSlug owner/other-repo -Ref v0.2.0

  为什么不拿真实 profile 试：
    dsh plugin add 会改写 profile 的 package.json（dependencies 与 dsh.profile.bundles）。
    失败时可能留下半成品，而宿主又在跑，排查很麻烦。隔离跑就没有这个顾虑。

  三个踩过的坑（都已在下面处理，改这个脚本时别退回）：
    1. Windows PowerShell 5.1 读**无 BOM** 的 .ps1 会按 GBK 解码，中文变乱码并凑出
       多余引号 -> 语法错误。本文件必须带 UTF-8 BOM。
       注意：用 write/edit 类工具改完 .ps1 会把 BOM 抹掉，改完要重补。
    2. $ErrorActionPreference='Stop' + NativeCommandError：dsh 往 **stderr** 写
       「initialized profile …」这类**正常**信息，PS 5.1 会把它包成终止性错误，
       循环在第一轮就退出（看着像 dsh 失败，其实是 PowerShell 的问题）。
       -> 因此每条命令把两条流重定向进日志文件，最后一次性读回来。
    3. pnpm 的 store 默认位置跟着 HOME / USERPROFILE 走。只设
       npm_config_store_dir 在 pnpm 12.x 上**不被采用**，store 会落在意料之外的地方
       （实测在工作区根建出过 .pnpm-store/）。-> 把 HOME/USERPROFILE/LOCALAPPDATA 一起挪走。
#>

[CmdletBinding()]
param(
  # 插件发布仓，owner/repo 形式；也接受 git URL 或带 .git 后缀
  [string]$RepoSlug = 'fadedfakers/dsh-course-plugin',
  # 要装的版本/分支/标签。空 = 默认分支（main）
  [string]$Ref = '',
  # DSH profile 名，默认 web
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Continue'

# ---- 归一化 RepoSlug：允许 owner/repo、git URL、带 .git ----
$slug = $RepoSlug.Trim()
$slug = $slug -replace '^git\+', ''
$slug = $slug -replace '^https?://github\.com/', ''
$slug = $slug -replace '^github\.com/', ''
$slug = $slug -replace '\.git$', ''
$slug = $slug.Trim('/')
if ($slug -notmatch '^[^/]+/[^/]+$') {
  Write-Host "✗ -RepoSlug '$RepoSlug' 不是 owner/repo 形式（例：fadedfakers/dsh-course-plugin）"
  exit 2
}

# ---- 找 dsh：用 npm 全局根定位真正的入口 lib/bin.js ----
# 不直接调 PATH 上的 `dsh`：那可能是 .ps1/.cmd 包装，且本脚本要显式控制
# 「用哪个 node 去跑它」。npm root -g 是最稳的锚点。
function Resolve-DshEntry {
  $candidates = @()
  $npmRoot = (npm root -g 2>$null)
  if ($npmRoot) { $candidates += (Join-Path $npmRoot '@deepseek-ai\dsh\lib\bin.js') }
  $candidates += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js')
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$dshEntry = Resolve-DshEntry
if (-not $dshEntry) {
  Write-Host '✗ 找不到 dsh。先装 DSH（npm i -g @deepseek-ai/dsh），再跑本脚本。'
  exit 2
}

# ---- 找 git 并补进 PATH ----
# dsh 把参数转发给 pnpm，pnpm 解析 git 依赖时需要 git；git 常常不在系统 PATH 里。
function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return (Split-Path -Parent $cmd.Source) }
  foreach ($p in @('D:\Git\cmd', 'C:\Program Files\Git\cmd', 'C:\Program Files (x86)\Git\cmd')) {
    if (Test-Path (Join-Path $p 'git.exe')) { return $p }
  }
  return $null
}

$gitDir = Find-Git
if ($gitDir) { $env:PATH = "$gitDir;$env:PATH" }
else { Write-Host '⚠ 没找到 git。pnpm 解析 GitHub 依赖会失败，先装 Git for Windows。' }

# ---- 一次性演练环境 ----
$sandbox = Join-Path $env:TEMP 'dsh-newuser-probe'
$log     = Join-Path $sandbox 'install-probe.log'

Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $sandbox -Force | Out-Null

$env:HOME         = $sandbox
$env:USERPROFILE  = $sandbox
$env:LOCALAPPDATA = Join-Path $sandbox 'AppData\Local'
New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force | Out-Null
$env:DSH_HOME = $sandbox

$packages = @('dsh-course-core', 'dsh-course-student', 'dsh-course-teacher')

$refPart = ''
if ($Ref) { $refPart = "#$Ref" }

# 记下每步退出码：用来区分「产品问题」和「网络问题」——
# 这两种失败的**表面现象一模一样**（都只是 exit=1），但处置完全不同。
# 实测踩过：沙箱到 github.com 的出口是**间歇性**的，同一条命令
# 前一分钟成功、后一分钟 `curl 28 Could not connect`，而脚本只报「演练失败」，
# 白白让人以为插件装不上。所以这里把错误文本也分层判出来。
$codes = @()

Write-Host "== 新用户安装演练 =="
Write-Host "  插件来源 : $slug$refPart"
Write-Host "  profile  : $Profile"
Write-Host "  演练目录 : $sandbox"
Write-Host "  dsh      : $dshEntry"
if ($gitDir) { Write-Host "  git      : $gitDir" }
Write-Host ''

# ---- 前置网络检查：能早失败就早失败 ----
# 不这么做的话，网络不通时会白等 3 轮超时才发现，而且最后报的还是「装不上」，
# 看着像产品坏了。实测两个坑：
#   · 网络断时 git 的默认超时能拖到 **300 秒**，所以必须自己限时；
#   · 非交互环境下 git 可能停下来等凭据输入，所以要把提示关掉。
# 限时用 job + Wait-Job，比 git 自己的 http.lowSpeed* 配置可靠（那套不是所有版本都认）。
$env:GIT_TERMINAL_PROMPT = '0'

if ($gitDir) {
  $probeUrl = "https://github.com/$slug.git"
  $waitSec  = 20
  Write-Host "前置检查：探测 $slug（最多等 $waitSec 秒）…"

  $job = Start-Job -ScriptBlock {
    param($url)
    $env:GIT_TERMINAL_PROMPT = '0'
    & git ls-remote $url HEAD 2>&1
    "EXITCODE=$LASTEXITCODE"
  } -ArgumentList $probeUrl

  $done = Wait-Job $job -Timeout $waitSec
  if (-not $done) {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Write-Host "⚠ 前置检查失败：$waitSec 秒内连不上 $probeUrl"
    Write-Host '  这不代表插件有问题 —— 先把网络/代理解决，再重跑本脚本。'
    Write-Host '  验证办法：git ls-remote https://github.com/<owner>/<repo>.git HEAD 能返回 SHA 就说明已恢复。'
    exit 3
  }

  $pre = Receive-Job $job
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $preOk = $false
  foreach ($line in $pre) {
    if ("$line" -match '^EXITCODE=0$') { $preOk = $true }
  }
  if (-not $preOk) {
    Write-Host "⚠ 前置检查失败：连不上 $probeUrl"
    Write-Host '  这不代表插件有问题 —— 先把网络/代理解决，再重跑本脚本。'
    $pre | Where-Object { "$_" -and "$_" -notmatch '^EXITCODE=' } | Select-Object -First 5 |
      ForEach-Object { Write-Host "    $_" }
    exit 3
  }
  Write-Host "前置检查通过：git ls-remote 能连到 $slug ✓`n"
} else {
  Write-Host "跳过前置网络检查（没找到 git）`n"
}

foreach ($pkg in $packages) {
  $spec = "github:$slug$refPart#path:$pkg"
  Write-Host "== dsh plugin --profile $Profile add $spec =="
  Add-Content -Path $log -Value "`n===== dsh plugin --profile $Profile add $spec =====" -Encoding utf8
  & node $dshEntry plugin --profile $Profile add $spec *>> $log
  $code = $LASTEXITCODE
  $codes += $code
  Add-Content -Path $log -Value "[exit=$code]" -Encoding utf8
  Write-Host "  [exit=$code]"
}
Write-Host "`n== 完整输出 =="
Get-Content $log -Encoding utf8

$pj = Join-Path $sandbox "profiles\$Profile\package.json"
Write-Host "`n== 结果：profile 的 package.json =="
if (Test-Path $pj) {
  Get-Content $pj -Raw -Encoding utf8
} else {
  Write-Host "  ✗ 没有生成 $pj —— 说明 DSH_HOME 没被采用，本次演练无效（不是产品失败）"
}

Write-Host "`n== 物化检查 =="
$nm = Join-Path $sandbox "profiles\$Profile\node_modules"
foreach ($pkg in $packages) {
  $d = Join-Path $nm $pkg
  if (Test-Path $d) {
    $patch = Test-Path (Join-Path $d 'cordis.patch.yml')
    Write-Host ("  {0,-20} 已物化  cordis.patch.yml={1}" -f $pkg, $patch)
  } else {
    Write-Host ("  {0,-20} ✗ 未物化" -f $pkg)
  }
}

# 关键判据：三个包必须都进 dsh.profile.bundles。
# 漏一个的症状是「装了但面板不出现」，所以这里显式判，不能只靠肉眼看输出。
Write-Host "`n== 判据：三个包都在 dsh.profile.bundles 里吗 =="
$bundles = @()
if (Test-Path $pj) {
  $bundles = (Get-Content $pj -Raw -Encoding utf8 | ConvertFrom-Json).dsh.profile.bundles
}
$allOk = $true
foreach ($pkg in $packages) {
  # 注意：不能写 `$(if (...) {...} else {...})` —— 把 if 当表达式用是 PowerShell 7
  # 的语法，Windows PowerShell 5.1 会报 "The term 'if' is not recognized"。
  if ($bundles -contains $pkg) {
    Write-Host ("  {0,-20} ✓ 在 bundles 里" -f $pkg)
  } else {
    $allOk = $false
    Write-Host ("  {0,-20} ✗ 不在 bundles 里（面板不会出现）" -f $pkg)
  }
}

$keep = Join-Path $env:TEMP 'install-probe.log'
Copy-Item $log $keep -Force -ErrorAction SilentlyContinue
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue

# 判「这是网络问题还是产品问题」：读日志里的错误文本，找网络类特征串。
# 判据要选具体的错误文本，不能用「退出码非 0」——那两者都命中。
$anyFailed = $false
foreach ($c in $codes) { if ($c -ne 0) { $anyFailed = $true } }

$netFailed = $false
if ($anyFailed -and (Test-Path $keep)) {
  $txt = Get-Content $keep -Raw -Encoding utf8 -ErrorAction SilentlyContinue
  if ($txt) {
    foreach ($pat in @('Could not connect to server', 'Failed to connect to github.com',
                       'ERR_PNPM_GIT_RESOLVE_FAILED', 'curl 28', 'Could not resolve host',
                       'Connection timed out', 'RPC failed')) {
      if ($txt -like "*$pat*") { $netFailed = $true }
    }
  }
}

Write-Host ''
if ($allOk) {
  Write-Host '演练通过：三个包都装好并且都进栈了 ✓'
} elseif ($netFailed) {
  # 这一支必须和「产品失败」分开报，否则会把人引向错误的方向。
  Write-Host '⚠ 演练没跑成，但**不是产品问题**：连不上 github.com（网络/出口问题）。'
  Write-Host '  证据：日志里出现 Could not connect to server / ERR_PNPM_GIT_RESOLVE_FAILED。'
  Write-Host '  这类失败在一台机器上是**间歇性**的 —— 同一条命令等一会儿重跑往往就过。'
  Write-Host "  先确认：git ls-remote https://github.com/$slug.git HEAD"
  Write-Host '  能返回 SHA 说明网络已恢复，重跑本脚本即可。'
} else {
  Write-Host '演练失败：有包没进 bundles —— 这才是产品问题（用户会遇到「装了但面板不出现」）✗'
}
Write-Host "完整输出已留存: $keep"
Write-Host "一次性目录已删除: $sandbox"

# 退出码：通过 0；网络问题 3（与产品失败 1 区分开，便于 CI/脚本判断）
if ($allOk) { exit 0 }
if ($netFailed) { exit 3 }
exit 1
