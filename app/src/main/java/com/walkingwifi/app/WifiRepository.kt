package com.walkingwifi.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * 封装系统 WiFi 扫描。
 * 限制（系统级，无法绕过）：
 *  - Android 9+ 每个前台 App 约 4 次扫描 / 2 分钟
 *  - Android 8+ 后台扫描被进一步限制
 *  - 拿到的列表是系统缓存，startScan 只是请求刷新
 */
class WifiRepository(private val context: Context) {

    private val wifi: WifiManager =
        context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    /** 发起扫描并等待结果；失败时退回系统缓存的最近一次扫描结果。 */
    suspend fun scan(): List<ScanResult> {
        val granted = ContextCompat.checkSelfPermission(
            context, android.Manifest.permission.ACCESS_FINE_LOCATION,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) return emptyList()

        val latch = kotlinx.coroutines.CompletableDeferred<Boolean>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                val ok = intent?.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false) == true
                android.util.Log.d(TAG, "onScanResultsAvailable updated=$ok")
                if (!latch.isCompleted) latch.complete(ok)
            }
        }
        val filter = IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
        ContextCompat.registerReceiver(
            context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        val started = try {
            val r = wifi.startScan()
            android.util.Log.d(TAG, "startScan returned=$r (false 通常=限频)")
            r
        } catch (e: SecurityException) {
            android.util.Log.e(TAG, "startScan SecurityException", e)
            false
        }

        // 最多等 8 秒；限频时 startScan 会返回 false 或不回调
        val updated = if (started) {
            kotlinx.coroutines.withTimeoutOrNull(8_000) { latch.await() } ?: false
        } else false

        try { context.unregisterReceiver(receiver) } catch (_: Exception) {}

        // 无论本轮是否触发系统刷新，都读回 scanResults（是系统最近一次扫描的缓存）
        val results = try {
            val r = wifi.scanResults
            android.util.Log.d(TAG, "scanResults size=${r.size} updated=$updated")
            r
        } catch (e: SecurityException) {
            android.util.Log.e(TAG, "getScanResults SecurityException", e)
            emptyList()
        }
        return results
    }

    companion object {
        private const val TAG = "WalkingWiFi"
    }
}
