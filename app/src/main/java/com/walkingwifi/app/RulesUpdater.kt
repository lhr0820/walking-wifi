package com.walkingwifi.app

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 规则包热更新 —— 「广泛使用、点击即用」的前提。
 *
 * 问题：brand_rules.json 原本打包在 APK 的 assets 里，改一条密码就得重新发版，
 * 用户还得去商店更新。这对一个靠数据活着、数据天天变的 App 是致命的。
 *
 * 做法：
 *   1. App 启动时问后端「现在规则包第几版」（/v1/rules/version，很小）
 *   2. 比本地版本新 → 下载整个 JSON（/v1/rules/blob），存到 filesDir
 *   3. CredStore 加载时优先读 filesDir 的，其次才读 assets
 *   4. 全程失败不影响 App 使用（继续用 APK 内置的那份）
 *
 * 版本号存在 SharedPreferences，键 rules_version。
 */
object RulesUpdater {

    private const val TAG = "WalkingWiFi"
    private const val FILE_NAME = "brand_rules.json"
    private const val PREF_KEY = "rules_version"

    /** 热更新下载下来的规则文件；没有就是 null */
    fun cachedFile(context: Context): File = File(context.filesDir, FILE_NAME)

    /** 当前生效的版本号（0 = 用的 APK 内置版） */
    fun localVersion(context: Context): Int =
        context.getSharedPreferences("cred_store", Context.MODE_PRIVATE)
            .getInt(PREF_KEY, 0)

    data class CheckResult(
        val updated: Boolean,
        val localVersion: Int,
        val remoteVersion: Int,
        val message: String,
    )

    /**
     * 检查并更新。设计成「永远不会抛异常」——后端不可达时必须安静地跳过，
     * 不能因为一次网络失败让 App 启动变慢或报错。
     */
    suspend fun checkAndUpdate(context: Context): CheckResult = withContext(Dispatchers.IO) {
        val local = localVersion(context)
        val verUrl = ApiClient.baseUrl() + "/v1/rules/version"
        try {
            val verJson = httpGet(verUrl)
            val remote = Regex("\"version\"\\s*:\\s*(\\d+)")
                .find(verJson)?.groupValues?.get(1)?.toIntOrNull() ?: 0

            if (remote <= local) {
                Log.d(TAG, "规则包已是最新：本地 $local / 远端 $remote")
                return@withContext CheckResult(false, local, remote, "已是最新 v$local")
            }

            // 有新版本，下载
            val blob = httpGet(ApiClient.baseUrl() + "/v1/rules/blob")
            if (blob.length < 64) {
                return@withContext CheckResult(false, local, remote, "远端包异常（${blob.length} 字节）")
            }
            // 落盘前先验证是合法 JSON（粗检，够用）
            if (!blob.contains("\"brands\"")) {
                return@withContext CheckResult(false, local, remote, "远端包格式不对，忽略")
            }

            val f = cachedFile(context)
            f.writeText(blob)
            context.getSharedPreferences("cred_store", Context.MODE_PRIVATE)
                .edit().putInt(PREF_KEY, remote).apply()

            Log.d(TAG, "规则包已更新：$local → $remote（${blob.length} 字节）")
            CheckResult(true, local, remote, "已更新到 v$remote")
        } catch (e: Exception) {
            // 超时 / DNS / 被墙 —— 全部走这里，不打扰用户
            Log.d(TAG, "规则包检查失败（用本地版）：${e.javaClass.simpleName}")
            CheckResult(false, local, local, "云端不可达，用本地 v$local")
        }
    }

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 3_000
            readTimeout = 8_000
            setRequestProperty("User-Agent", "WalkingWiFi/0.6 (Android)")
        }
        try {
            if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}