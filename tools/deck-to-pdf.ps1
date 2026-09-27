# deck-to-pdf.ps1 —— 把 pptx 导出成 PDF（「在线看原件」的前提）
#
# ── 为什么需要它 ────────────────────────────────────────────────────────
# 浏览器**没有 pptx 渲染器**。所以「学生在面板里在线看课件原件」只有两条路：
#   ① 把 pptx 转成 PDF（本脚本做的事）→ 浏览器自带阅读器就能内嵌
#   ② 去课件页框选（面板自带，但那看的是切好的图，不是原件）
# 学生的真实需求是「对着 PPT 截图提问」，①给的是**完整原件**（翻页、看动画帧、
# 自己打印），②给的是**能框选取证并就地提问**。两个都要，所以两个都做。
#
# ── 本机用的是 WPS（不是 Office）────────────────────────────────────────
# 实测：这台机器没装 Microsoft Office，装的是 WPS（`D:\WPS Office\...\wpp.exe`），
# 而它注册了 `KWPP.Application` 这个 COM ProgID。关键的一行是 **格式常量 32**：
#
#     $pres.SaveAs($dst, 32)        # 32 = ppSaveAsPDF → 生成一个整份 PDF
#
# 踩过的坑（别改回 17/18）：
#   · 17 在 WPS 下**不报错但也不生成文件**（它被解释成"每页导出一个 PDF"，
#     结果在一堆 `幻灯片N.pdf` 上，而我们的 `Test-Path $dst` 永远是假 —— 看起来
#     像"导出失败"，其实文件在别的地方）；
#   · 18 同样静默无输出；
#   · `ExportAsFixedFormat` 在 WPS 的 COM 上签名不兼容（参数类型转换直接抛错）。
# 所以这里只认 32，并且在生成后**用字节数验证**（不是"没抛错就当成功"）——
# 那是这个项目里反复吃亏的一类：静默失败被当成成功。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/deck-to-pdf.ps1 `
#       -Pptx "C:\...\第一章.pptx" -Out "C:\...\资料\第一章.pdf"
#
# 退出码：0 = 导出成功且文件非空；1 = 失败（原因打在 stderr）
param(
  [Parameter(Mandatory = $true)][string]$Pptx,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1600,
  [int]$Height = 900
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Pptx)) { Write-Error "找不到源文件：$Pptx"; exit 1 }
$src = (Get-Item $Pptx)
if ($src.Length -lt 1024) { Write-Error "源文件太小，不像一个 pptx：$Pptx（$($src.Length) 字节）"; exit 1 }

$outDir = Split-Path -Parent $Out
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
# 目标已存在时先删：SaveAs 对已存在的文件行为不一致（有的版本会失败）
if (Test-Path $Out) { Remove-Item $Out -Force }

$app = $null
$pres = $null
try {
  # 先 WPS 的 ProgID，再退回 Office 的 —— 换台机器（装了 Office）也能用
  $progid = $null
  foreach ($p in @('KWPP.Application', 'PowerPoint.Application')) {
    try { $app = New-Object -ComObject $p; $progid = $p; break } catch { $app = $null }
  }
  if (-not $app) {
    Write-Error ("这台机器上没有可用的 PowerPoint/WPS COM 接口。`n" +
      "  装 Office 或 WPS 之后重试；或者手工在 PowerPoint/WPS 里【另存为 PDF】，`n" +
      "  放到 $outDir 下（文件名要与 pptx 同名）。")
    exit 1
  }

  Write-Host "  用 $progid 打开：$($src.Name)（$([math]::Round($src.Length/1MB,1)) MB）"
  # ReadOnly=$true, Untitled=$false, WithWindow=$false —— 不弹窗，适合脚本里跑
  $pres = $app.Presentations.Open($Pptx, $true, $false, $false)
  $slides = $pres.Slides.Count
  Write-Host "  页数 = $slides，导出 PDF…"

  $pres.SaveAs($Out, 32)   # 32 = ppSaveAsPDF（**别改成 17/18**，见文件头注释）

  if (-not (Test-Path $Out)) { Write-Error "SaveAs 没报错但没有生成 $Out（WPS 下格式常量写错时就是这样）"; exit 1 }
  $pdf = Get-Item $Out
  if ($pdf.Length -lt 1024) { Write-Error "导出的 PDF 只有 $($pdf.Length) 字节，不像一份真的文档"; exit 1 }

  Write-Host "  [OK] $($pdf.Name)  $([math]::Round($pdf.Length/1MB,2)) MB  ($slides 页)"
  # 页数也报给调用方（生成清单时要用它填 slides.range）
  Write-Output "SLIDES=$slides"
  exit 0
} catch {
  Write-Error ("导出失败：$($_.Exception.Message)")
  exit 1
} finally {
  if ($pres) { try { $pres.Close() } catch { } }
  if ($app) { try { $app.Quit() } catch { } }
}
