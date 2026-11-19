<#
.SYNOPSIS
    把示例数据铺成正式文件名，让新 clone 的仓库能直接构建运行。

.DESCRIPTION
    仓库里不含真实门店网络数据（口令属敏感内容）。
    本脚本把 *.example.* 复制成程序实际读取的文件名。
    clone 后跑一次即可编译；查到的都是示例口令，不是真实门店的。

    Android 侧读取处都有 try-catch，缺文件不崩，但会查不到任何东西，
    所以建议还是跑一次本脚本。

.EXAMPLE
    pwsh scripts/use-example-data.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pairs = @(
    @{ Src = 'app/src/main/assets/brand_rules.example.json';       Dst = 'app/src/main/assets/brand_rules.json' }
    @{ Src = 'app/src/main/assets/seed_wifi.example.json';         Dst = 'app/src/main/assets/seed_wifi.json' }
    @{ Src = 'app/src/main/assets/weak_passwords.example.txt';     Dst = 'app/src/main/assets/weak_passwords.txt' }
    @{ Src = 'miniprogram/data/seed.example.js';                   Dst = 'miniprogram/data/seed.js' }
    @{ Src = 'miniprogram/cloudfunctions/wifiLookup/data.example.json'; Dst = 'miniprogram/cloudfunctions/wifiLookup/data.json' }
)

$done = 0
$skipped = 0

foreach ($p in $pairs) {
    if (-not (Test-Path $p.Src)) {
        Write-Host "  跳过（示例不存在）: $($p.Src)" -ForegroundColor DarkYellow
        continue
    }
    if (Test-Path $p.Dst) {
        Write-Host "  跳过（已有真实数据）: $($p.Dst)" -ForegroundColor DarkYellow
        $skipped++
        continue
    }
    Copy-Item $p.Src $p.Dst -Force
    Write-Host "  已铺: $($p.Dst)" -ForegroundColor Green
    $done++
}

Write-Host ""
Write-Host "完成：$done 个已铺，$skipped 个已存在未覆盖。"
Write-Host "注意：现在程序里是示例口令，不是真实门店数据。" -ForegroundColor Cyan
Write-Host "要填自己的数据，直接改上面那几个目标文件即可。" -ForegroundColor Cyan