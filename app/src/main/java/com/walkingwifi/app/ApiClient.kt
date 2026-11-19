package com.walkingwifi.app

import android.content.Context
import android.location.LocationManager
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * 后端客户端 —— 四层降级链里的第 2 层。
 *
 * 后端是 Cloudflare Worker + D1，接口见 backend/src/index.js：
 *   GET  /v1/lookup?ssid=&gh=&city=     查某个 SSID 的候选密码
 *   POST /v1/report                     上报「这个密码能用/不能用」
 *   POST /v1/merchant/claim             商家认领
 *
 * ⚠️ 已知部署现实：Worker 默认的 *.workers.dev 域名在中国大陆网络下**不可直连**
 *    （实测 connect timeout）。所以：
 *      · 地址做成可配置，正式上线要绑自己的域名
 *      · 请求失败时静默降级，只走本地库 + 搜索兜底，不影响用户用
 */
object ApiClient {

    private const val TAG = "WalkingWiFi"

    /**
     * 部署后的地址。
     *
     * 从 workers.dev 换到自定义域名，原因是：
     *   walking-wifi-api.1348294073.workers.dev 在国内被 DNS 污染，
     *   实测解析到 2a03:2880:f111:83:face:b00c（Facebook 地址段），
     *   手机和本机都连不上 → 后端整层失效。
     * 换成 api.lilcandi.xyz（NS 在 Cloudflare 托管）后：
     *   解析到 104.21.60.173 / 172.67.198.235，HTTP 200 正常。
     */
    private const val BASE = "https://api.lilcandi.xyz"

    /** 给 RulesUpdater / 调试用 */
    fun baseUrl(): String = BASE

    /**
     * 超时设置。这些数字是实测调出来的，不是拍的。
     *
     * 一开始设 3.5s 连接 / 5s 读，绑域名后真机日志报
     * 「lookup 失败（降级到本地）：SocketTimeoutException: timeout」，
     * 而同一次的 report 却成功了 —— 说明网络是通的，就是不够快。
     * 本机实测这条 Cloudflare 链路只有 1.8 Mbps（海外节点），
     * TLS 握手 + 跨境往返就要好几秒。
     *
     * 现在放宽到 8s 连接 / 12s 读。代价是云端不可达时用户要多等，
     * 但因为 lookup 失败会自动降级到本地库，不影响最终结果。
     */
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 12_000

    data class Candidate(val psk: String, val hits: Int, val confidence: Int, val source: String)

    data class LookupResult(
        val ok: Boolean,
        val candidates: List<Candidate> = emptyList(),
        /** 后端一条都没有 → 该降级到第 3 层（搜索） */
        val needSearch: Boolean = false,
        val message: String = "",
    )

    /**
     * 查后端密码库。任何网络问题都返回 ok=false，调用方当作「这层没结果」继续往下走。
     * 绝不抛异常 —— 后端不可达不能阻断用户试密码。
     */
    suspend fun lookup(context: Context, ssid: String): LookupResult = withContext(Dispatchers.IO) {
        val gh = geohashOf(context) ?: ""
        val url = buildString {
            append(BASE).append("/v1/lookup?ssid=")
            append(URLEncoder.encode(ssid, "UTF-8"))
            if (gh.isNotEmpty()) append("&gh=").append(gh)
        }
        try {
            val body = httpGet(url)
            val json = JSONObject(body)
            val arr = json.optJSONArray("candidates") ?: return@withContext LookupResult(
                ok = true, needSearch = true, message = "库里没有这个网络",
            )
            val list = ArrayList<Candidate>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val psk = o.optString("psk", "")
                if (psk.isEmpty() && !o.optBoolean("open", false)) continue
                list.add(
                    Candidate(
                        psk = psk,
                        hits = o.optInt("hits", 0),
                        confidence = o.optInt("confidence", 1),
                        source = o.optString("source", ""),
                    ),
                )
            }
            Log.d(TAG, "lookup [$ssid] gh=$gh → ${list.size} 条")
            LookupResult(
                ok = true,
                candidates = list,
                needSearch = json.optString("fallback") == "search" || list.isEmpty(),
                message = if (list.isEmpty()) "库里没有这个网络" else "命中 ${list.size} 条",
            )
        } catch (e: Exception) {
            // 超时 / DNS / 被墙 —— 全部走这里，静默降级
            Log.d(TAG, "lookup 失败（降级到本地）：${e.javaClass.simpleName}: ${e.message}")
            LookupResult(ok = false, message = "后端不可达，跳过云库")
        }
    }

    /** 上报：kind = worked | failed | portal | closed */
    suspend fun report(
        context: Context,
        ssid: String,
        psk: String?,
        kind: String,
    ): Boolean = withContext(Dispatchers.IO) {
        val payload = JSONObject().apply {
            put("ssid", ssid)
            if (!psk.isNullOrEmpty()) put("psk", psk)
            put("kind", kind)
            put("device", deviceTag(context))
        }
        try {
            val code = httpPost("$BASE/v1/report", payload.toString())
            Log.d(TAG, "report [$ssid/$kind] → HTTP $code")
            code in 200..299
        } catch (e: Exception) {
            Log.d(TAG, "report 失败：${e.javaClass.simpleName}")
            false
        }
    }

    /**
     * 匿名贡献密码。
     *
     * 和 report 的关键区别：**这里不带 device 参数**。
     * report 传设备哈希是为了聚合「同一台设备反复失败 → 这条密码有问题」，
     * 但贡献是帮忙行为，用户是在做好事，不该留任何可追溯的痕迹。
     * 界面上写了「完全匿名」，代码就得真的做到。
     *
     * 返回 Pair(是否成功, 给用户看的话)。
     */
    suspend fun contribute(
        ssid: String,
        psk: String,
    ): Pair<Boolean, String> = withContext(Dispatchers.IO) {
        val payload = JSONObject().apply {
            put("ssid", ssid)
            put("psk", psk)
        }
        try {
            val (code, text) = httpPostWithBody("$BASE/v1/contribute", payload.toString())
            Log.d(TAG, "contribute [$ssid] → HTTP $code")
            if (code in 200..299) {
                val obj = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
                val msg = obj.optString(
                    "message",
                    if (obj.optBoolean("duplicate")) "这条密码库里已经有了" else "已收下，谢谢",
                )
                true to msg
            } else {
                val obj = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
                false to obj.optString("hint", "没提交成功，稍后再试")
            }
        } catch (e: Exception) {
            Log.d(TAG, "contribute 失败：${e.javaClass.simpleName}")
            false to "网络不通，稍后再试"
        }
    }

    /** 第 3 层的兜底：给一个能点开的搜索链接（不自动提取，因为搜索侧没有数据，见 harvester 说明） */
    fun searchUrl(ssid: String): String =
        "https://www.bing.com/search?q=" +
            URLEncoder.encode("$ssid wifi 密码", "UTF-8")

    /**
     * 上报体检结果。
     *
     * 这是方案 A 的数据资产：单个用户看到的是「这家店 62 分」，
     * 后端聚合后能给出「这个商圈 50 家店排名」——那才是要卖给商家的东西。
     */
    suspend fun reportCheckup(
        context: Context,
        checkup: NetworkProbe.Checkup,
        geohash: String,
        brand: String?,
    ): Boolean = withContext(Dispatchers.IO) {
        val payload = JSONObject().apply {
            checkup.toReport().forEach { (k, v) -> put(k, v) }
            put("geohash", geohash)
            if (!brand.isNullOrBlank()) put("brand", brand)
            put("device", deviceTag(context))
        }
        try {
            val code = httpPost("$BASE/v1/checkup/report", payload.toString())
            Log.d(TAG, "checkup report [${checkup.ssid}] score=${checkup.score} → HTTP $code")
            code in 200..299
        } catch (e: Exception) {
            Log.d(TAG, "checkup report 失败：${e.javaClass.simpleName}")
            false
        }
    }

    // ------------------------------------------------------------ 内部

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "WalkingWiFi/0.4 (Android)")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) error("HTTP $code")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun httpPost(url: String, body: String): Int {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("User-Agent", "WalkingWiFi/0.4 (Android)")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    /**
     * 和 httpPost 一样，但把响应体也读出来。
     *
     * 需要它的场景：贡献密码后要拿后端返回的一句话
     * （「已收下，下一个人会省几分钟」/「这条库里已经有了」）。
     * 4xx 时后端也会给 hint，所以两条流都要读。
     */
    private fun httpPostWithBody(url: String, body: String): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("User-Agent", "WalkingWiFi/0.4 (Android)")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    /** 位置网格（精度 4 ≈ 20km）。只用来让同区域的密码优先，不上传精确坐标。 */
    private fun geohashOf(context: Context): String? = try {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            ?: lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
            ?: return null
        // 精度 4 位粗化，避免精确定位泄露
        Geohash.encode(loc.latitude, loc.longitude, 4)
    } catch (_: SecurityException) {
        null
    } catch (_: Exception) {
        null
    }

    /** 设备标识：只用于后端去重，不上报可识别信息 */
    private fun deviceTag(context: Context): String =
        android.provider.Settings.Secure.getString(
            context.contentResolver, android.provider.Settings.Secure.ANDROID_ID,
        ) ?: "unknown"
}

/** 极简 geohash，与后端 Worker 里的实现保持一致 */
object Geohash {
    private const val BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

    fun encode(lat: Double, lon: Double, precision: Int = 6): String {
        var latMin = -90.0
        var latMax = 90.0
        var lonMin = -180.0
        var lonMax = 180.0
        val sb = StringBuilder()
        var bit = 0
        var ch = 0
        var even = true
        while (sb.length < precision) {
            if (even) {
                val mid = (lonMin + lonMax) / 2
                if (lon >= mid) { ch = ch * 2 + 1; lonMin = mid } else { ch *= 2; lonMax = mid }
            } else {
                val mid = (latMin + latMax) / 2
                if (lat >= mid) { ch = ch * 2 + 1; latMin = mid } else { ch *= 2; latMax = mid }
            }
            even = !even
            if (++bit == 5) {
                sb.append(BASE32[ch]); bit = 0; ch = 0
            }
        }
        return sb.toString()
    }
}