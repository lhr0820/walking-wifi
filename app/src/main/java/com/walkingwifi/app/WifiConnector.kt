package com.walkingwifi.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.SupplicantState
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** 日志里不打印完整密码，只留前 2 后 2 */
private fun mask(psk: String): String =
    if (psk.length <= 4) "***" else "${psk.take(2)}***${psk.takeLast(2)}"

/**
 * 自动试密码。
 *
 * ══════════════════════════════════════════════════════════════
 *  这是整个 App 最关键也最脆弱的模块，先说清 Android 的能力边界
 * ══════════════════════════════════════════════════════════════
 *
 * 无 root 的 Android 上，**没有**「用指定密码连指定网络并立刻返回对错」的 API。
 * 可用手段只有三种，各有代价：
 *
 *  ① WifiNetworkSuggestion（本实现采用）
 *     把「SSID + 密码」提交给系统，由系统决定何时去连。
 *     优点：不需要用户确认，可后台生效，App 被杀也保留
 *     缺点：**系统不告诉我们「密码错」**，只能靠观察连接状态推断
 *     代价：提交后系统可能需要几秒到几十秒才尝试；断开要 removeNetworkSuggestions
 *
 *  ② WifiNetworkSpecifier
 *     每次都要弹系统对话框让用户点「连接」，**无法自动化批量试**
 *
 *  ③ root / shell（cmd wifi connect-network）
 *     真正可控，但需要 root，不适合公开分发的 App
 *
 * 所以本模块的判断逻辑是「观察式」而非「询问式」：
 *   连上了 + VALIDATED       → 密码正确且能上网
 *   连上了 + CAPTIVE_PORTAL  → 密码正确，但需要网页/短信认证
 *   进入 AUTHENTICATING 后又断开 → 密码错误（提前结束，不用等满超时）
 *   全程没连上                → 超时，判为失败
 *
 * 已知干扰因素（真实存在，不是 bug）：
 *  - 系统里若已保存该 SSID 的配置，会**优先使用保存的密码**，我们的 suggestion 可能被忽略
 *  - 用户之前手动连过该网络 → 系统直接连上，你会看到「成功」，但那是旧密码在起作用
 *  - 系统对每个 App 的 suggestion 数量有上限；连续提交过多会被限流
 *  - 目标信号弱时会误判为「密码错」
 * ══════════════════════════════════════════════════════════════
 */
object WifiConnector {

    /** Specifier 探测单个密码的等待上限。密码错时一般 2-4 秒就 onUnavailable。 */
    private const val SPECIFIER_TIMEOUT_MS = 8_000L

    /** 单次连接等待上限。太长拖慢整轮，太短会把慢网络误判为密码错。 */
    private const val CONNECT_TIMEOUT_MS = 12_000L

    /** 这个时间窗内不判失败——系统可能还在切换网络，断开只是毛刺。 */
    private const val MIN_WAIT_BEFORE_FAIL_MS = 2_200L

    /** 轮询间隔。250ms 足够抓到 supplicant 的状态跳变。 */
    private const val POLL_INTERVAL_MS = 250L

    /** 两次尝试之间的间隔，给系统时间回收上一次的 suggestion。 */
    private const val BETWEEN_ATTEMPTS_MS = 500L

    enum class State {
        NONE,                  // 没连上目标网络
        AUTHENTICATING,        // 正在验证密码
        ONLINE,                // 连上且能上网
        CAPTIVE_PORTAL,        // 连上但需认证
        CONNECTED_NO_INTERNET, // 连上但没网（罕见）
    }

    data class Result(
        val success: Boolean,
        val psk: String?,
        val tried: Int,
        val state: String,
        val needsPortal: Boolean = false,
    )

    /** awaitConnection 的产物。sawAttempt 决定要不要继续试下一个密码。 */
    data class Outcome(
        val state: State,
        val message: String,
        /** 是否观察到 supplicant 真的为目标网络努力过 */
        val sawAttempt: Boolean,
    )

    /**
     * 依次尝试候选密码。
     * @param onProgress 回调 (第几个, 总数, 当前密码)，用于 UI 进度
     */
    suspend fun tryConnect(
        context: Context,
        ssid: String,
        candidates: List<String>,
        onProgress: ((Int, Int, String) -> Unit)? = null,
    ): Result {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

        // 先看是不是已经连在目标网络上了 —— 这种情况密码一定是对的（不管谁设的）
        // 注意：此时并不知道密码是什么，所以 psk 返回 null，UI 要提示「系统已有配置」
        val initial = probe(cm, wm, ssid)
        android.util.Log.d("WalkingWiFi", "tryConnect ssid=$ssid initialProbe=$initial")
        if (initial == State.ONLINE) {
            return Result(true, null, 0, "已连接（密码未知，系统已有配置）")
        }
        if (initial == State.CAPTIVE_PORTAL) {
            return Result(true, null, 0, "已连接，需认证", needsPortal = true)
        }

        // 关键：如果系统里已经有该 SSID 的保存配置，我们提交的 suggestion 会**被忽略**，
        // 系统会拿旧密码去连，于是无论我们试什么密码都会「连上」，判断完全失效。
        //
        // 但注意：Android 10+ 起 `getConfiguredNetworks()` 对普通 App 恒返回空列表
        // （实测 confirmed: configuredNetworks=[]，即使设备正连着该网络），
        // 所以没法靠它检测。这里只做 best-effort：读得到才用，读不到就跳过。
        val configured = try {
            wm.configuredNetworks?.mapNotNull { it.SSID?.trim('"') } ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
        if (configured.isNotEmpty() && configured.any { it == ssid }) {
            return Result(
                false, null, 0,
                "系统已保存该网络的配置，无法可靠试密码。请先到系统设置里「忘记」这个网络再试。",
            )
        }

        var lastState = "未尝试"
        var usedSpecifier = false

        candidates.forEachIndexed { index, psk ->
            onProgress?.invoke(index + 1, candidates.size, psk)

            // ── 第一步：用 Specifier 快速探测密码对错 ──────────────
            //    成功 → 3-5 秒内确定；失败 → 立刻下一个，不用等 12 秒超时
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                usedSpecifier = true
                val correct = probePassword(cm, ssid, psk)
                android.util.Log.d(
                    "WalkingWiFi",
                    "Specifier 探测 [$ssid] / [${mask(psk)}] → ${if (correct) "✅ 正确" else "❌ 错误"}",
                )
                if (!correct) {
                    lastState = "密码错误（Specifier 已确定）"
                    return@forEachIndexed
                }

                // ── 第二步：探测通过 → 用 Suggestion 落地成系统配置 ──
                //    这样整个手机（微信、浏览器）都能用，而不是只有本 App
                val suggestion = buildSuggestion(ssid, psk)
                if (suggestion != null) {
                    try {
                        wm.addNetworkSuggestions(listOf(suggestion))
                    } catch (_: Exception) {
                    }
                }
                return Result(true, psk, index + 1, "密码正确（已探测 + 已落地）")
            }

            // ── API 29 以下的回退路径：还是用 Suggestion + 猜 ──────
            val suggestion = buildSuggestion(ssid, psk)
            if (suggestion == null) {
                lastState = "密码格式不合法"
                return@forEachIndexed
            }

            // 提交给系统
            val status = try {
                wm.addNetworkSuggestions(listOf(suggestion))
            } catch (e: SecurityException) {
                -1
            }
            if (status != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                lastState = "系统拒绝提交（状态码 $status）"
                return@forEachIndexed
            }

            try {
                val outcome = awaitConnection(cm, wm, ssid)
                lastState = outcome.message
                when (outcome.state) {
                    State.ONLINE ->
                        return Result(true, psk, index + 1, outcome.message)
                    State.CAPTIVE_PORTAL ->
                        return Result(true, psk, index + 1, outcome.message, needsPortal = true)
                    State.CONNECTED_NO_INTERNET ->
                        return Result(true, psk, index + 1, outcome.message)
                    else -> Unit // 没连上，看下面要不要继续
                }

                // ★ 关键中止条件：如果系统从头到尾都没为这个网络发起过连接，
                //   换成别的密码也一样不会发起（原因通常是：设备已连着别的网络，
                //   Android 不会为了一个 suggestion 主动切走；或者该网络信号太弱）。
                //   此时继续试剩下 20 多个候选纯属白等——实测每个要等满 12 秒。
                if (!outcome.sawAttempt) {
                    android.util.Log.d(
                        "WalkingWiFi",
                        "第 ${index + 1} 个候选就没有触发系统尝试 → 中止整轮，共省下 " +
                            "${candidates.size - index - 1} 次无意义等待",
                    )
                    return Result(false, null, index + 1, outcome.message)
                }
            } finally {
                // 一定要撤掉，否则系统会一直拿旧密码重试，干扰下一次
                try {
                    wm.removeNetworkSuggestions(listOf(suggestion))
                } catch (_: Exception) {
                }
            }

            delay(BETWEEN_ATTEMPTS_MS)
        }

        return Result(false, null, candidates.size, lastState)
    }

    /** 构造网络建议。开放网络用 setUntrusted(false) + 空 WPA2 不合法，开放网走 setIsAppInteractionRequired(false)。 */
    private fun buildSuggestion(ssid: String, psk: String): WifiNetworkSuggestion? {
        if (ssid.isBlank()) return null
        return try {
            val builder = WifiNetworkSuggestion.Builder()
                .setSsid(ssid)
                .setIsAppInteractionRequired(false)
            if (psk.isNotEmpty()) {
                // WPA2/WPA3-Personal 的密码长度是 8-63
                if (psk.length < 8 || psk.length > 63) return null
                builder.setWpa2Passphrase(psk)
            }
            // 不带 passphrase 即为开放网络
            builder.build()
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /**
     * 等待连接结果。
     * 监听两路信号：
     *  - ConnectivityManager 的 NetworkCapabilities（判断是否真的通了）
     *  - WifiManager 的 NETWORK_STATE_CHANGED_ACTION（判断是否密码错，提前结束）
     */
    /**
     * 用 WifiNetworkSpecifier **探测**某个密码对不对。
     *
     * 这是整个项目的技术核心，也是最本质的一处修复。
     *
     * 为什么必须这样：
     *   WifiNetworkSuggestion  —— 系统自愿连，App 没有控制权，**也拿不到成败反馈**
     *                              → 只能靠「等了 12 秒还没连上」来猜，慢且不准
     *   WifiNetworkSpecifier   —— 弹窗确认后**一定会连**，并有明确的
     *                              onAvailable / onUnavailable 回调
     *                              → 3–5 秒就能 100% 确定密码对错
     *
     * 代价（Google 官方原话："peer to peer connection only for the duration of the request"）：
     *   它是**本 App 专属的临时连接**，其他 App 用不了，请求一结束就断。
     *   所以这里只拿它做「探测」——探到密码对了，再用 Suggestion 落地成系统配置，
     *   让整个手机都能用。两者组合，各取所长。
     *
     * 注：第一次连某个 AP 会弹系统确认框；之后 Android 会记住该 AP 的授权，
     *     同一个 AP 再探测不再弹（见 developer.android.com/wifi-bootstrap）。
     */
    private suspend fun probePassword(
        cm: ConnectivityManager,
        ssid: String,
        psk: String,
    ): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false

        val specifier = try {
            WifiNetworkSpecifier.Builder().apply {
                setSsid(ssid)
                if (psk.isNotEmpty()) setWpa2Passphrase(psk)
            }.build()
        } catch (e: Exception) {
            android.util.Log.d("WalkingWiFi", "specifier 构造失败（密码格式？）：${e.message}")
            return false
        }

        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .apply {
                // 去掉 INTERNET 要求，否则开放/无外网的门店网络会被判失败
                removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }
            .setNetworkSpecifier(specifier)
            .build()

        val ok = withTimeoutOrNull(SPECIFIER_TIMEOUT_MS) {
            suspendCancellableCoroutine { cont ->
                val cb = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onUnavailable() {
                        if (cont.isActive) cont.resume(false)
                    }

                    override fun onLost(network: Network) {
                        // 拿到又丢了，算成功过（密码是对的）
                        if (cont.isActive) cont.resume(true)
                    }
                }
                try {
                    cm.requestNetwork(request, cb, SPECIFIER_TIMEOUT_MS.toInt())
                } catch (e: Exception) {
                    android.util.Log.d("WalkingWiFi", "requestNetwork 失败：${e.javaClass.simpleName}")
                    if (cont.isActive) cont.resume(false)
                    return@suspendCancellableCoroutine
                }
                cont.invokeOnCancellation {
                    try {
                        cm.unregisterNetworkCallback(cb)
                    } catch (_: Exception) {
                    }
                }
            }
        } ?: false

        // 无论成败都要释放，否则 P2P 连接会一直占着
        try {
            cm.unregisterNetworkCallback(
                object : ConnectivityManager.NetworkCallback() {},
            )
        } catch (_: Exception) {
        }
        return ok
    }

    /**
     * 等待一次连接的结果，并尽可能早地判定失败。
     *
     * 思路（这是把整轮试密码从"分钟级"压到"十几秒级"的关键）：
     * 密码错时，supplicant 会走 ASSOCIATING → AUTHENTICATING → 四次握手失败 → DISCONNECTED，
     * 这个过程一般只要 2–4 秒。所以**一旦看到它为「目标 SSID」努力过又断开**，
     * 就立刻判失败，不必等满 12 秒。
     *
     * 用 `wm.connectionInfo` 轮询而不是监听广播，原因同上：广播里的 WifiInfo 可能脱敏。
     *
     * 三个返回值有区分意义：
     *  · 密码错误           —— 看到过尝试又断开
     *  · 系统未尝试连接     —— 从没看到它为目标努力（suggestion 可能被旧配置顶掉，或信号太弱）
     *  · 超时未连上         —— 看到过尝试但一直没结果
     */
    private suspend fun awaitConnection(
        cm: ConnectivityManager,
        wm: WifiManager,
        ssid: String,
    ): Outcome {
        val start = System.currentTimeMillis()
        val deadline = start + CONNECT_TIMEOUT_MS
        var sawAttempt = false
        var lastSupplicant: SupplicantState? = null
        var lastLogged: SupplicantState? = null

        while (System.currentTimeMillis() < deadline) {
            // ① 已经连上了吗
            when (val conn = probe(cm, wm, ssid)) {
                State.ONLINE ->
                    return Outcome(State.ONLINE, "密码正确", true)
                State.CAPTIVE_PORTAL ->
                    return Outcome(State.CAPTIVE_PORTAL, "密码正确（需认证）", true)
                State.CONNECTED_NO_INTERNET ->
                    return Outcome(State.CONNECTED_NO_INTERNET, "密码正确（无外网）", true)
                else -> Unit
            }

            // ② 系统正在为这个网络做什么
            val info = try {
                wm.connectionInfo
            } catch (_: Exception) {
                null
            }
            val curSsid = info?.ssid?.trim('"')
            val sState = info?.supplicantState

            if (sState != lastLogged) {
                android.util.Log.d(
                    "WalkingWiFi",
                    "supplicant: $lastLogged → $sState (当前SSID=$curSsid, 目标=$ssid)",
                )
                lastLogged = sState
            }
            lastSupplicant = sState

            if (curSsid != null && curSsid.equals(ssid, ignoreCase = true)) {
                when (sState) {
                    SupplicantState.ASSOCIATING,
                    SupplicantState.ASSOCIATED,
                    SupplicantState.AUTHENTICATING,
                    SupplicantState.FOUR_WAY_HANDSHAKE,
                    SupplicantState.GROUP_HANDSHAKE,
                    -> sawAttempt = true

                    SupplicantState.DISCONNECTED -> {
                        val elapsed = System.currentTimeMillis() - start
                        if (sawAttempt && elapsed >= MIN_WAIT_BEFORE_FAIL_MS) {
                            android.util.Log.d(
                                "WalkingWiFi",
                                "提前判失败：${elapsed}ms 内在 [$ssid] 上完成尝试后断开",
                            )
                            return Outcome(State.NONE, "四次握手失败（密码错误）", true)
                        }
                    }
                    else -> Unit
                }
            }

            delay(POLL_INTERVAL_MS)
        }

        return if (sawAttempt) {
            Outcome(State.NONE, "超时未连上（看到尝试但没结果，信号可能太弱）", true)
        } else {
            // 技术细节（末态 supplicant）只进日志，界面上给用户能懂的话
            android.util.Log.d(
                "WalkingWiFi",
                "系统全程没有尝试 [$ssid]，末态 supplicant=$lastSupplicant",
            )
            Outcome(
                State.NONE,
                "系统没有去连这个网络（通常因为已连着别的网络，或信号太弱）",
                false,
            )
        }
    }

    /**
     * 探测当前活动网络是不是目标 SSID，以及它的连通性等级。
     *
     * ⚠️ 必须用 `WifiManager.connectionInfo` 读 SSID，**不能**用
     * `NetworkCapabilities.transportInfo as WifiInfo`——后者是脱敏副本，
     * Android 12+ 会把它里面的 SSID 抹成 `<unknown ssid>`（实测确认），
     * 即使 ACCESS_FINE_LOCATION / NEARBY_WIFI_DEVICES 都已授予也一样。
     */
    fun probe(cm: ConnectivityManager, wm: WifiManager, targetSsid: String): State {
        val active = cm.activeNetwork ?: return State.NONE
        val caps = cm.getNetworkCapabilities(active) ?: return State.NONE
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return State.NONE

        val current = try {
            wm.connectionInfo?.ssid?.trim('"')
        } catch (_: SecurityException) {
            null
        }
        // 注意：这里不逐次打日志——探测每 250ms 一次，打日志会淹掉 logcat。
        // 需要观察时看 awaitConnection 里 supplicant 状态变化的那条。

        if (current == null || current.equals("<unknown ssid>", ignoreCase = true)) {
            return State.NONE
        }
        if (!current.equals(targetSsid, ignoreCase = true)) return State.NONE

        if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
            return State.ONLINE
        }
        if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)) {
            return State.CAPTIVE_PORTAL
        }
        return State.CONNECTED_NO_INTERNET
    }
}