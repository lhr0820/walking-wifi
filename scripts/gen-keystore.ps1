<#
.SYNOPSIS
    生成 Release 签名用的 keystore，并写好 keystore.properties。

.DESCRIPTION
    应用市场上架必须有签名的 release 包，debug 签名不收。

    本脚本做三件事：
      1. 用 keytool 生成一个 JKS keystore（有效期 10000 天）
      2. 随机生成强密码（不写死在脚本里）
      3. 把密码写进 keystore.properties（该文件已在 .gitignore，不进版本库）

    ⚠️ 重要：keystore 文件和 keystore.properties 必须自己备份好。
       一旦丢失，已上架的应用就永远无法推送更新，只能重新上架一个包名不同的新应用。

.PARAMETER Alias
    密钥别名，默认 walkingwifi

.PARAMETER Force
    已存在 keystore 时覆盖（默认拒绝，避免误删已有的签名）

.EXAMPLE
    pwsh scripts/gen-keystore.ps1
#>

param(
    [string]$Alias = 'walkingwifi',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ksPath = Join-Path $root 'release-keystore.jks'
$propPath = Join-Path $root 'keystore.properties'

if ((Test-Path $ksPath) -and -not $Force) {
    Write-Host "keystore 已存在：$ksPath" -ForegroundColor Yellow
    Write-Host "  要重新生成请加 -Force（会覆盖，旧包将无法更新）" -ForegroundColor Yellow
    exit 0
}

# 找 keytool
$keytool = (Get-Command keytool -ErrorAction SilentlyContinue).Source
if (-not $keytool) {
    $candidates = @(
        "$env:JAVA_HOME\bin\keytool.exe",
        'D:\Dev\jdk-21\bin\keytool.exe'
    )
    $keytool = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $keytool) {
    Write-Host "找不到 keytool。请安装 JDK，或把 JDK 的 bin 目录加进 PATH。" -ForegroundColor Red
    exit 1
}
Write-Host "使用 keytool: $keytool"

# 随机强密码：大小写+数字，24 位，避开容易混淆的字符
function New-StrongPassword {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    -join (1..24 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}

$storePass = New-StrongPassword
$keyPass = $storePass   # JKS 里两者一致最省心

Write-Host "正在生成 keystore（约需几秒）..."

& $keytool -genkeypair `
    -v `
    -keystore $ksPath `
    -alias $Alias `
    -keyalg RSA `
    -keysize 4096 `
    -validity 10000 `
    -storepass $storePass `
    -keypass $keyPass `
    -dname "CN=Walking WiFi, OU=Mobile, O=Walking WiFi, L=Unknown, ST=Unknown, C=CN" 2>&1 |
    Select-Object -Last 5

if (-not (Test-Path $ksPath)) {
    Write-Host "keystore 生成失败" -ForegroundColor Red
    exit 1
}

# 写 properties
$prop = @"
# 由 scripts/gen-keystore.ps1 生成
# 本文件已在 .gitignore 中，不会进版本库
# ⚠️ 请把本文件和 release-keystore.jks 一起备份到安全位置
storeFile=release-keystore.jks
storePassword=$storePass
keyAlias=$Alias
keyPassword=$keyPass
"@
$prop | Set-Content $propPath -Encoding utf8

Write-Host ""
Write-Host "完成。" -ForegroundColor Green
Write-Host "  keystore : $ksPath"
Write-Host "  properties: $propPath"
Write-Host ""
Write-Host "签名密码（务必自己抄下来备份）：" -ForegroundColor Cyan
Write-Host "  storePassword = $storePass"
Write-Host "  keyPassword   = $keyPass"
Write-Host "  keyAlias      = $Alias"
Write-Host ""
Write-Host "下一步：pwsh gradlew.bat assembleRelease" -ForegroundColor Cyan