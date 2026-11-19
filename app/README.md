# Walking WiFi · Android

> UI 设计借鉴 [magpie](https://github.com/yetone/magpie)（MIT）：单表面 + 卡片内细分割线 + 胶囊控件。
> 详见 `docs/06_UI重构_借鉴magpie.md`

> 点开 App → 自动扫周边 WiFi → 按本地密码库逐个试 → 连上为止。
> 开源、无后端依赖（首版）、只针对**商家公用 WiFi**。

## 真机实测状态

| 项 | 结果 |
|---|---|
| 构建 | ✅ `gradle assembleDebug` 通过 |
| 产物 | `app-debug.apk` 5.62 MB |
| 实测设备 | 小米 23073RPBFC / Android 15 (SDK 35) |
| 扫描 | ✅ `startScan returned=true`，拿到 4–6 个网络 |
| 列表渲染 | ✅ SSID / 加密方式 / dBm / 信号格 / 候选数 全部正确 |
| 试密码 | ✅ 提交 `WifiNetworkSuggestion` 后系统弹确认框，链路通 |
| 状态判定 | ✅ 已连接网络正确识别为 `ONLINE`，不误判 |

## 两个只在真机上才暴露的坑（已修）

### 坑 1 · `NetworkCapabilities.transportInfo` 的 SSID 是脱敏的

```kotlin
// ❌ 错误：拿到的是脱敏副本，Android 12+ 恒为 <unknown ssid>
val wifiInfo = caps.transportInfo as WifiInfo
val ssid = wifiInfo.ssid   // "<unknown ssid>"

// ✅ 正确：用 WifiManager 读
val ssid = wifiManager.connectionInfo.ssid
```

**现象**：手机明明连着 `ZTE-BE5100`，`probe()` 却返回 `NONE`，于是 App 认不出「已经连着」，陷入没必要的试密码循环。
**影响**：ACCESS_FINE_LOCATION 和 NEARBY_WIFI_DEVICES 全授予了也一样——这不是权限问题，是 API 选错了。

### 坑 2 · `getConfiguredNetworks()` 对普通 App 恒返回空

```
D WalkingWiFi: configuredNetworks=[]
（即使设备正连着该 SSID）
```

Android 10+ 起，非系统 App 读不到系统保存的网络列表。所以**无法用 API 检测「系统已保存该网络的旧密码」**——而这个检测对试密码的准确性至关重要：如果系统里有旧配置，我们提交的 suggestion 会被忽略，无论试什么密码都会「连上」。

**当前对策**：只做 best-effort（读得到才判断），并在结果里诚实告诉用户「系统已有配置，密码未知」。

### 附 · Android 6+ 定位开关是扫描的硬前提

```
location_mode = 0  → startScan returned=false, scanResults size=0
location_mode = 3  → startScan returned=true,  scanResults size=4
```

官方文档写了这一条，但真机上不打开定位就是「扫描恒返回 0 个网络」，容易被误判成代码 bug。

## 构建

```powershell
$env:ANDROID_HOME = "K:\android-sdk"
$env:JAVA_HOME    = "D:\Dev\jdk-21"
cd K:\WIFI\walking-wifi
K:\gradle\gradle-8.9\bin\gradle.bat assembleDebug
# 产物: app\build\outputs\apk\debug\app-debug.apk
```

依赖：JDK 17+（实测 21 可用）、Android SDK platform 34 + build-tools 34.0.0、Gradle 8.9。

## 用法

1. 安装 APK
2. **打开系统定位开关**（不打开扫不到任何网络）
3. 授权「附近的设备」（Android 13+ 读 SSID 必需）
4. 自动扫描 → 列表按信号排序
5. **点任意一行** → 自动尝试本地库里的候选密码
6. 连上后密码自动入库

## 能力边界（重要）

无 root 的 Android **没有**「用指定密码连接并返回对错」的 API。本实现用
`WifiNetworkSuggestion`（提交给系统，观察连接状态推断结果），代价：

1. **系统不直接告知密码错**，只能靠「连不上/超时」推断
2. 每次尝试需数秒到十几秒；22 个候选理论上要几分钟
3. 系统对该 SSID 已有保存配置时会优先用旧密码，干扰判断（无法检测，见坑 2）
4. 扫描限频：前台约 4 次 / 2 分钟
5. 隐藏 SSID 无法通过 suggestion 连接

## License

MIT
