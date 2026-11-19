# Walking WiFi · 到店网络助手

> 走到店门口，先知道能不能连上。开源、离线、不收集任何个人信息。

一个帮你快速找到线下门店公用网络口令的工具。扫描周围网络 → 匹配已知品牌 → 一键复制 → 去系统设置里粘贴。

支持的平台：

| 平台 | 状态 | 说明 |
|---|---|---|
| **Android** | 主渠道 | 自建扫描 + 试连，功能最完整 |
| **微信小程序** | 备选 | 受平台限制，仅列出 + 复制 |

---

## 它解决什么问题

进一家店想问 WiFi 密码，得找店员、等对方忙完、有时候还被拒绝。而很多连锁门店的公用网络口令是**全门店统一定制**的（比如某品牌用「品牌缩写+固定数字」），本来就可以提前知道。

这个工具做的事情：

1. 扫描你周围的无线网络
2. 把网络名匹配到已知的连锁品牌
3. 给出该品牌的常见口令列表
4. 点一下复制，你去系统设置里粘贴

**不做的事**：不破解、不抓包、不尝试登录别人的私人网络、不上传你的任何信息。

---

## 功能

### Android 版

- 打开即列出周围网络，**已知口令的排在最前面**
- 品牌模糊匹配：`MIXUE-WANDA-5G`、`mxbc-store`、`蜜雪冰城` 都能命中同一品牌
- 一键复制口令 / 一键尝试连接
- 完全离线可用（口令库打包在 APK 内）
- 可选的云端热更新（规则包支持远程下发，不用重新发版）
- 匿名贡献：你实测有效的口令可以提交，帮到别人

### 小程序版

- 同样支持扫描与品牌模糊匹配
- 因为小程序正式版强制「request 合法域名」且该域名需 ICP 备案，
  所以小程序版走**纯本地库**路径，不发任何网络请求

---

## 快速开始

### 前置要求

- JDK 17 或 21
- Android SDK（`local.properties` 里配 `sdk.dir`）
- Gradle 由 wrapper 自带，不用单独装

### 构建

```powershell
# 1) 铺示例数据（仓库不含真实数据，见下文「关于数据」）
pwsh scripts/use-example-data.ps1

# 2) 生成签名（首次构建 release 才需要）
pwsh scripts/gen-keystore.ps1

# 3) 构建
.\gradlew.bat assembleDebug      # 调试包
.\gradlew.bat assembleRelease    # 签名发布包
```

产物位置：

```
app/build/outputs/apk/debug/app-debug.apk
app/build/outputs/apk/release/app-release.apk
```

### 小程序

用微信开发者工具打开 `miniprogram/` 目录。

**注意**：`wx.getWifiList` 在开发者工具模拟器里不支持，
会提示「请使用真机进行开发」——这是正常的，必须真机预览才能测扫描。

---

## 关于数据：仓库里为什么是示例

门店公用网络的口令属于**敏感内容**，公开在仓库里会：

- 被批量抓取滥用
- 引发投诉，导致应用被下架
- 违背「只收录商家自己公开的公用网络」这个定位

所以 `.gitignore` 排除了所有真实数据文件，仓库里只放**结构完整的示例**：

| 真实文件（不入库） | 仓库内示例 |
|---|---|
| `app/src/main/assets/brand_rules.json` | `brand_rules.example.json` |
| `app/src/main/assets/seed_wifi.json` | `seed_wifi.example.json` |
| `app/src/main/assets/weak_passwords.txt` | `weak_passwords.example.txt` |
| `miniprogram/data/seed.js` | `seed.example.js` |
| `miniprogram/cloudfunctions/wifiLookup/data.json` | `data.example.json` |

跑 `scripts/use-example-data.ps1` 会把示例铺成正式文件名，这样能编译、能跑，
但查到的都是 `example-psk-*` 这种假口令。

**填自己的数据**：直接改上面表格左列那几个文件即可，格式看对应示例。

### 数据格式

`brand_rules.json`：

```json
{
  "brands": [
    {
      "brand": "品牌名",
      "aliases": ["别名1", "别买2"],
      "psks": ["候选口令1", "候选口令2"],
      "suffixes": ["888", "123"]
    }
  ]
}
```

`aliases` 是模糊匹配的关键——扫到的网络名只要包含任一别名，就会命中这个品牌。

---

## 目录结构

```
walking-wifi/
├── app/                        Android 原生（Kotlin）
│   └── src/main/
│       ├── assets/             数据（示例入库，真实数据本地保留）
│       └── java/com/walkingwifi/app/
├── miniprogram/                微信小程序
│   ├── pages/                  首页/扫描/详情/录入/自检
│   ├── data/                   种子库（示例入库）
│   ├── utils/                  store 本地库 / api 统一查询层
│   └── cloudfunctions/         云函数（备用通道）
├── backend/                    Cloudflare Worker（可选云端）
│   ├── src/index.js            /v1/lookup 等接口
│   └── tools/                  数据构建脚本
├── harvester/                  公开数据采集器（Python）
├── docs/                       设计与实测文档
├── scripts/                    辅助脚本
└── automator-test/             小程序自动化回归测试
```

---

## 技术栈

- **Android**：Kotlin + ViewBinding + Coroutines，minSdk 26 / targetSdk 34
- **小程序**：原生小程序框架
- **后端（可选）**：Cloudflare Workers + D1
- **数据采集**：Python

---

## 合规说明

本项目只做三件事：

1. 读取系统提供的**周围网络名称列表**（公开广播信息）
2. 用网络名匹配已知的连锁品牌
3. 展示该品牌的候选口令，由用户自己复制

**明确不做**：

- 不破解任何加密
- 不抓取他人数据包
- 不尝试登录私人网络
- 不收集、不上传用户的位置、设备标识或个人信息

如果你是哪家门店的负责人，希望移除自己品牌的信息，
请开 Issue，核实后会移除。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 口令是概率性的 | 品牌通用口令不一定每家门店铺都改了；个体小店没有通用值 |
| 中小店铺覆盖弱 | 只覆盖连锁品牌；夫妻店通常由店主自行设置 |
| Android 10+ 自动连接受限 | 系统限制，所以主路径是「复制 + 手动粘贴」 |
| 小程序不能上架外链 | 正式版走纯本地库 |

---

## 发布渠道

| 渠道 | 状态 |
|---|---|
| **GitHub Releases** | 主发布渠道，APK 直下 |
| 国内应用市场 | 华为 / 小米 / OPPO / vivo / 应用宝 |
| 微信小程序 | 备选 |

---

## License

MIT，见 [LICENSE](LICENSE)。

---

## 致谢

数据来自公开网络信息的交叉整理。如果你觉得这个工具帮到你了，
欢迎把你实测有效的口令通过应用内的匿名入口提交回来。