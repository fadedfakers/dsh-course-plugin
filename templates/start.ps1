<#
  课程环境启动 —— 学生端
  ================================================================
  为什么需要这个脚本：
    `npm i -g @deepseek-ai/dsh` 装完之后，%APPDATA%\npm 下**可能一个 bin shim
    都不生成**（dsh.cmd / dsh.ps1 / dsh 全缺），于是你在终端敲 `dsh` 会说
    「不是内部或外部命令」，但包其实装好了、能跑。这不是你的错，是 npm 的
    全局 bin 链接在某些环境下会失败。
    本脚本自己去找 dsh 的真实入口，找到就直接启动，不依赖 PATH。

  用法：
      powershell -ExecutionPolicy Bypass -File .\start.ps1

  环境变量（可选）：
      $env:CIP_COURSE_CODE = '...'   课程码，只是显示用
      $env:CIP_WORKSPACE   = '...'   课程工作区路径

  注意：你的角色默认就是 student，不需要设置任何东西。
        教师端才需要显式声明（缺省是学生，这是刻意的）。
#>

[CmdletBinding()]
param(
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

function Warn { param([string]$m) Write-Host "  [注意] $m" -ForegroundColor Yellow }
function Bad  { param([string]$m) Write-Host "  [失败] $m" -ForegroundColor Red }
function Ok   { param([string]$m) Write-Host "  [OK]   $m" -ForegroundColor Green }

# 与 install.ps1 里同一套三层探测：命令名 → 常见 shim → 包内 bin.js
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

Write-Host ""
Write-Host "  深度学习课程 · 启动" -ForegroundColor Cyan
Write-Host "  ------------------------------------------------------------"

$dsh = Resolve-Dsh
if (-not $dsh) {
  Bad "找不到 dsh"
  Write-Host "        先在本仓根目录跑一次："
  Write-Host "            powershell -ExecutionPolicy Bypass -File .\install.ps1"
  exit 1
}
Ok "dsh：$($dsh.Show)"
# 单独取 bin.js 路径用于「先配 Key」的提示（How 为 1 或 2 个元素，不能靠 [-1]）
$binPath = if ($dsh.How.Count -ge 2) { $dsh.How[1] } else { '(见上面的 dsh 路径)' }

$cred = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
if (Test-Path $cred) { Ok "API Key 已配置" }
else {
  Warn "还没有 API Key —— AI 答疑会失败"
  Write-Host "        先不带参数跑一次它，会引导你配置 provider 与 Key："
  Write-Host "            node `"$binPath`""
  Write-Host "        Key 只写进 $cred，只在你本机。"
}

Write-Host ""
Write-Host "  启动中……（关掉本窗口即停止）"
Write-Host "  ------------------------------------------------------------"
Write-Host ""

if ($dsh.How.Count -eq 1) { & $dsh.How[0] web --profile $Profile }
else { & $dsh.How[0] $dsh.How[1] web --profile $Profile }
