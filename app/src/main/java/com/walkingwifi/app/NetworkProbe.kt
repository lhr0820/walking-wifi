package com.walkingwifi.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.resume
import kotlin.math.roundToInt

/**
 * 到店网络体检 —— 方案 A 的核心。
 *
 * 思路的转变：
 *   以前：帮你连上一个 WiFi（连不上就没价值，且受平台限制）
 *   现在：告诉你这个 WiFi 值不值得连（连不上也有价值，因为是"诊断结果"）
 *
 * 这个模块不猜密码、不破解，只做三件事：
 *   1. 测：信号、加密方式、是否需要认证、能不能上外网、下载多快、延迟多少
 *   2. 评：把这些数字变成一个 0-100 分和一句人话
 *   3. 存：上报后端，聚合成「某商圈网络质量排行」（这是要卖给商家的东西）
 */
object NetworkProbe {

    private const val TAG = "WalkingWiFi"

    /** 测速用的载荷大小。1 MB 够测 100 Mbps 以内的链路，也不会太耗流量。 */
    private const val PAYLOAD_BYTES = 1_048_576L

    /** 单次体检的总预算，超时就给已有数据（半份报告好过没有） */
    private const val PROBE_TIMEOUT_MS = 20_000L

    /** 连目标网络等多久算连上 */
    private const val SPECIFIER_TIMEOUT_MS = 10_000L

    // ────────────────────────────────────────────────────────────
    //  数据模型
    // ────────────────────────────────────────────────────────────

    /** 加密方式评估。分数直接进总分的安全项。 */
    enum class Security(val label: String, val score: Double, val warn: String?) {
        WPA3("WPA3", 10.0, null),
        WPA2("WPA2", 8.0, null),
        WPA("WPA", 4.0, "老式加密，容易被蹭网工具破解"),
        WEP("WEP", 0.0, "已淘汰的加密，几分钟就能破解，别在上面输密码"),
        OPEN("开放", 2.0, "完全无加密，同网段的人可能看到你的流量"),
        UNKNOWN("未知", 5.0, null),
    }

    /**
     * 一份体检报告。
     *
     * 注意 [speedTested] 这个字段——它诚实标出「这份报告测没测到速度」。
     * 需要密码又不知道密码的网络，是测不了速度的，不能假装测过。
     */
    data class Checkup(
        val ssid: String,
        val bssid: String,
        val rssi: Int,
        val security: Security,
        val needsPortal: Boolean,
        val reachable: Boolean,
        val downloadMbps: Double,
        val ttfbMs: Long,
        val speedTested: Boolean,
        val score: Int,
        val grade: String,
        val verdict: String,
        val tips: List<String>,
    ) {
        /** 给后端上报用的精简结构 */
        fun toReport(): Map<String, Any> = mapOf(
            "ssid" to ssid,
            "bssid" to bssid,
            "score" to score,
            "download_mbps" to downloadMbps,
            "ttfb_ms" to ttfbMs,
            "security" to security.label,
            "needs_portal" to needsPortal,
            "reachable" to reachable,
        )
    }

    // ────────────────────────────────────────────────────────────
    //  评分模型
    //
    //  这是方案 A 的核心 IP。设计原则：
    //    · 可解释——每一项都能单独讲清楚，不是黑箱
    //    · 有侧重——能用（40）比快（30）更重要，快比安全（10）更重要
    //    · 诚实——测不到的项不给分，并在报告里说明
    // ────────────────────────────────────────────────────────────

    private fun scoreOf(
        reachable: Boolean,
        needsPortal: Boolean,
        downloadMbps: Double,
        ttfbMs: Long,
        sec: Security,
        speedTested: Boolean,
    ): Int {
        // ① 可用性 40 分：能不能真的上网
        val availability = when {
            !reachable -> 0.0
            needsPortal -> 20.0   // 要认证，能用但麻烦
            else -> 40.0
        }

        // ② 速度 30 分：20 Mbps 满分（够看 4K），按比例给
        //    没测到速度就不给分，也不倒扣——在总分里按剩余项归一化
        val speed = if (!speedTested) -1.0
        else (downloadMbps / 20.0 * 30.0).coerceIn(0.0, 30.0)

        // ③ 延迟 20 分：50ms 满分，500ms 零分，线性
        val latency = if (!speedTested) -1.0
        else ((500.0 - ttfbMs) / 450.0 * 20.0).coerceIn(0.0, 20.0)

        // ④ 安全 10 分
        val securityScore = sec.score

        // 未测速时，把速度+延迟的 50 分权重并入可用性和安全。
        //
        // 但绝不能归一化到 100 —— 那会让「信号强 + WPA3 + 没测速」直接变成满分，
        // 等于把「我们不知道」当成「没问题」。实测踩过这个坑：
        // 测速超时（未测）却显示 100 分优秀。
        //
        // 所以封顶 70 分：70 是「良好」的下限，意思是「看指标不错，但没实测」。
        if (speed < 0 || latency < 0) {
            val partial = availability + securityScore          // 满分 50
            val capped = (partial / 50.0) * 70.0
            return capped.roundToInt().coerceIn(0, 70)
        }
        return (availability + speed + latency + securityScore)
            .roundToInt().coerceIn(0, 100)
    }

    private fun gradeOf(score: Int): String = when {
        score >= 90 -> "优秀"
        score >= 70 -> "良好"
        score >= 50 -> "一般"
        else -> "差"
    }

    private fun verdictOf(score: Int, needsPortal: Boolean, speedTested: Boolean): String = when {
        // 没测速时先说明这一点，不能让用户以为已经验收过了
        !speedTested && score >= 70 -> "信号和加密都不错，但没测到速度——测速服务不可达"
        !speedTested -> "需要密码或测速不可达，只能看信号和加密"
        score >= 90 -> "这家店 WiFi 很好，放心用"
        score >= 70 -> "够用，刷视频、开会都没问题"
        score >= 50 && needsPortal -> "要手机号认证，能用但麻烦"
        score >= 50 -> "能连，但别在上面输密码付钱"
        else -> "太差了，建议直接用流量"
    }

    private fun tipsOf(
        reachable: Boolean,
        needsPortal: Boolean,
        sec: Security,
        rssi: Int,
        downloadMbps: Double,
        ttfbMs: Long,
        speedTested: Boolean,
    ): List<String> = buildList {
        if (!reachable) add("连不上外网，可能是假热点或需要认证")
        if (needsPortal) add("需要手机号或网页认证，认证后才能上网")
        sec.warn?.let { add(it) }
        if (rssi < -80) add("信号很弱（${rssi} dBm），走远一点可能断")
        if (speedTested && downloadMbps < 2) add("下载只有 ${"%.1f".format(downloadMbps)} Mbps，基本刷不动视频")
        if (speedTested && ttfbMs > 300) add("延迟 ${ttfbMs}ms，视频通话会卡")
        if (isEmpty()) add("没发现明显问题")
    }

    // ────────────────────────────────────────────────────────────
    //  体检主流程
    // ────────────────────────────────────────────────────────────

    /**
     * 对某个网络做体检。
     *
     * @param psk 已知密码；null 表示开放网络或不知道密码
     */
    suspend fun checkup(
        context: Context,
        ssid: String,
        bssid: String,
        rssi: Int,
        security: Security,
        psk: String?,
    ): Checkup = withContext(Dispatchers.IO) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

        // 情况 1：当前就连着这个网络 → 直接测，最准
        val active = activeSsid(wm)
        if (active == ssid) {
            return@withContext measure(cm, ssid, bssid, rssi, security, needsPortalNow(cm))
        }

        // 情况 2：没连着，但有密码（或开放网络）→ 用 Specifier 临时连上去测
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val ok = attach(cm, ssid, psk)
            if (ok) {
                return@withContext try {
                    measure(cm, ssid, bssid, rssi, security, needsPortalNow(cm))
                } finally {
                    detach(cm)
                }
            }
        }

        // 情况 3：连不上（需要密码但不知道）→ 只能做浅层评估
        val reachable = probeExternal(cm)
        val sec = security
        val score = scoreOf(reachable, false, 0.0, 0, sec, speedTested = false)
        Checkup(
            ssid = ssid, bssid = bssid, rssi = rssi, security = sec,
            needsPortal = false, reachable = reachable,
            downloadMbps = 0.0, ttfbMs = 0, speedTested = false,
            score = score, grade = gradeOf(score),
            verdict = "需要密码，测不了速度——只能看信号和加密",
            tips = tipsOf(reachable, false, sec, rssi, 0.0, 0, false),
        )
    }

    /** 已经连上时，跑完整的测量 */
    private suspend fun measure(
        cm: ConnectivityManager,
        ssid: String,
        bssid: String,
        rssi: Int,
        security: Security,
        needsPortal: Boolean,
    ): Checkup {
        val (mbps, ttfb) = withTimeoutOrNull(PROBE_TIMEOUT_MS) { speedTest() }
            ?: (0.0 to 0L)
        val tested = mbps > 0

        val score = scoreOf(
            reachable = tested || probeExternal(cm),
            needsPortal = needsPortal,
            downloadMbps = mbps,
            ttfbMs = ttfb,
            sec = security,
            speedTested = tested,
        )
        return Checkup(
            ssid = ssid, bssid = bssid, rssi = rssi, security = security,
            needsPortal = needsPortal, reachable = tested,
            downloadMbps = mbps, ttfbMs = ttfb, speedTested = tested,
            score = score, grade = gradeOf(score),
            verdict = verdictOf(score, needsPortal, tested),
            tips = tipsOf(true, needsPortal, security, rssi, mbps, ttfb, tested),
        )
    }

    // ── 测速 ──────────────────────────────────────────────────
    //
    // 为什么用自己的 Worker 而不是第三方测速节点：
    //   第三方节点测的是「到你到那台服务器」的速度，受对方线路影响
    //   自己的 Worker 在全球边缘节点，更接近你这条 WiFi 的出口质量
    private suspend fun speedTest(): Pair<Double, Long> = withContext(Dispatchers.IO) {
        val url = URL(ApiClient.baseUrl() + "/v1/speedtest/payload?size=$PAYLOAD_BYTES")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 6_000
            readTimeout = 15_000
            requestMethod = "GET"
            // 关键：禁止 gzip，否则压缩后字节数变了，速度会虚高好几倍
            setRequestProperty("Accept-Encoding", "identity")
            setRequestProperty("User-Agent", "WalkingWiFi-Probe/1.0")
        }
        try {
            val t0 = System.nanoTime()
            if (conn.responseCode !in 200..299) return@withContext (0.0 to 0L)

            val input = conn.inputStream
            val buf = ByteArray(16 * 1024)
            var total = 0L
            var firstByteAt = 0L

            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                if (firstByteAt == 0L) firstByteAt = System.nanoTime() // TTFB
                total += n
            }
            val end = System.nanoTime()
            input.close()

            if (total <= 0 || firstByteAt == 0L) return@withContext (0.0 to 0L)

            val ttfbMs = (firstByteAt - t0) / 1_000_000
            val seconds = (end - t0) / 1_000_000_000.0
            if (seconds <= 0.0) return@withContext (0.0 to ttfbMs)

            val mbps = (total * 8.0 / 1_000_000.0) / seconds
            Log.d(TAG, "测速：$total 字节 / ${"%.2f".format(seconds)}s = ${"%.2f".format(mbps)} Mbps, TTFB ${ttfbMs}ms")
            mbps to ttfbMs
        } catch (e: Exception) {
            Log.d(TAG, "测速失败：${e.javaClass.simpleName}")
            0.0 to 0L
        } finally {
            conn.disconnect()
        }
    }

    // ── 基础探测 ──────────────────────────────────────────────

    /** 当前连着的 SSID（NetworkCapabilities 里的 transportInfo 会被脱敏，必须走 wm） */
    private fun activeSsid(wm: WifiManager): String? = try {
        wm.connectionInfo?.ssid?.trim('"')
    } catch (_: Exception) {
        null
    }

    /** 是否需要门户认证 */
    private fun needsPortalNow(cm: ConnectivityManager): Boolean = try {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)
    } catch (_: Exception) {
        false
    }

    /** 能否上外网（用一个极小的请求探一下） */
    private fun probeExternal(cm: ConnectivityManager): Boolean = try {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    } catch (_: Exception) {
        false
    }

    // ── Specifier 临时连接（只用于测速，用完立刻断）────────────

    private var pending: ConnectivityManager.NetworkCallback? = null

    private suspend fun attach(cm: ConnectivityManager, ssid: String, psk: String?): Boolean {
        val specifier = try {
            WifiNetworkSpecifier.Builder().apply {
                setSsid(ssid)
                if (!psk.isNullOrEmpty()) setWpa2Passphrase(psk)
            }.build()
        } catch (_: Exception) {
            return false
        }

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // 去掉 INTERNET 要求：门店网络经常连上了但没外网，那也要能测
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specifier)
            .build()

        return withTimeoutOrNull(SPECIFIER_TIMEOUT_MS) {
            suspendCancellableCoroutine { cont ->
                val cb = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onUnavailable() {
                        if (cont.isActive) cont.resume(false)
                    }
                }
                pending = cb
                try {
                    cm.requestNetwork(request, cb, SPECIFIER_TIMEOUT_MS.toInt())
                } catch (e: SecurityException) {
                    // 这个异常只有一种原因：manifest 给 NEARBY_WIFI_DEVICES 加了
                    // neverForLocation，系统据此收紧了 WiFi API
                    Log.e(TAG, "requestNetwork 被拒：检查 manifest 是否误加了 neverForLocation")
                    if (cont.isActive) cont.resume(false)
                    return@suspendCancellableCoroutine
                } catch (e: Exception) {
                    if (cont.isActive) cont.resume(false)
                    return@suspendCancellableCoroutine
                }
                cont.invokeOnCancellation { detach(cm) }
            }
        } ?: false
    }

    private fun detach(cm: ConnectivityManager) {
        pending?.let {
            try {
                cm.unregisterNetworkCallback(it)
            } catch (_: Exception) {
            }
        }
        pending = null
    }

    // ── 工具 ──────────────────────────────────────────────────

    /** 从扫描结果推断加密方式 */
    fun securityOf(capabilities: String): Security {
        val c = capabilities.uppercase()
        return when {
            c.contains("WPA3") || c.contains("SAE") -> Security.WPA3
            c.contains("WPA2") || c.contains("RSN") -> Security.WPA2
            c.contains("WPA") -> Security.WPA
            c.contains("WEP") -> Security.WEP
            c.contains("EAP") || c.contains("802.1X") -> Security.WPA2 // 企业级，按 WPA2 计
            c.isBlank() || c == "[ESS]" || c == "[WPS]" -> Security.OPEN
            else -> Security.UNKNOWN
        }
    }

    /** 信号强度分档，界面用 */
    fun rssiLabel(rssi: Int): String = when {
        rssi >= -55 -> "很强"
        rssi >= -70 -> "良好"
        rssi >= -80 -> "一般"
        else -> "弱"
    }
}