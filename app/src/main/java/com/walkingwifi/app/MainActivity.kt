package com.walkingwifi.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.ScanResult
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.walkingwifi.app.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var wifiRepo: WifiRepository
    private lateinit var credStore: CredStore
    private lateinit var adapter: WifiAdapter

    private var scanResults: List<ScanResult> = emptyList()

    /** 当前筛选：ALL / OPEN / PASSWORD */
    private enum class Filter { ALL, OPEN, PASSWORD }
    private var filter = Filter.ALL
    private var allItems: List<WifiAdapter.Item> = emptyList()

    companion object {
        private const val REQ_PERMS = 100
        private val REQUIRED = if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.NEARBY_WIFI_DEVICES,
            )
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        wifiRepo = WifiRepository(this)
        credStore = CredStore(this)

        adapter = WifiAdapter { result -> onItemClicked(result) }
        binding.recycler.layoutManager = LinearLayoutManager(this)
        binding.recycler.adapter = adapter
        binding.recycler.addItemDecoration(WifiAdapter.DividerDecoration())

        binding.btnRescan.setOnClickListener { startScan() }
        binding.segAll.setOnClickListener { setFilter(Filter.ALL) }
        binding.segOpen.setOnClickListener { setFilter(Filter.OPEN) }
        binding.segPass.setOnClickListener { setFilter(Filter.PASSWORD) }
        binding.pillSeed.setOnClickListener {
            toast("内置种子 ${credStore.seedCount()} 条")
        }
        binding.pillVerified.setOnClickListener {
            toast("已实测连通 ${credStore.verifiedCount()} 条")
        }
        binding.pillAdd.setOnClickListener {
            toast("录入功能下一步接后端时开放")
        }
        binding.emptyBox.setOnClickListener { startScan() }

        if (!hasPermissions()) {
            ActivityCompat.requestPermissions(this, REQUIRED, REQ_PERMS)
        } else {
            startScan()
        }

        // 规则包热更新：后台悄悄做，失败不打扰用户
        lifecycleScope.launch {
            val r = RulesUpdater.checkAndUpdate(this@MainActivity)
            if (r.updated) {
                toast("密码库已更新到 v${r.remoteVersion}")
                // 规则变了，重算候选数和品牌标签
                render()
            }
            Log.d("WalkingWiFi", "规则包：${r.message}")
        }
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun hasPermissions(): Boolean =
        REQUIRED.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<String>, grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERMS) {
            if (grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                startScan()
            } else {
                showStatus("需要「附近的设备 / 定位」权限才能扫到网络（Android 系统要求）")
                showEmpty("权限没给够", "到系统设置里打开本应用的「附近的设备」和「位置信息」权限")
            }
        }
    }

    // ------------------------------------------------------------ 扫描

    private fun startScan() {
        if (!hasPermissions()) {
            ActivityCompat.requestPermissions(this, REQUIRED, REQ_PERMS)
            return
        }
        binding.btnRescan.isEnabled = false
        binding.btnRescan.text = "扫描中"
        binding.btnRescan.alpha = 0.55f
        showStatus("正在扫描周边网络…")

        lifecycleScope.launch {
            val results = wifiRepo.scan()
            scanResults = results
            render()
            binding.btnRescan.isEnabled = true
            binding.btnRescan.text = "扫描"
            binding.btnRescan.alpha = 1f

            if (results.isEmpty()) {
                showEmpty("没扫到任何网络", "确认系统「位置信息」已打开——这是 Android 扫描 WiFi 的硬性前提")
                showStatus("扫描完成，但没有结果。请检查定位开关。")
            } else {
                binding.emptyBox.visibility = View.GONE
                binding.recycler.visibility = View.VISIBLE
                hideStatus()
            }
        }
    }

    private fun render() {
        val currentSsid = currentSsid()
        // 按 SSID 合并：同一网络的多个 BSSID / 2.4G+5G 同名只占一行
        allItems = WifiAdapter.Item.aggregate(scanResults, credStore, currentSsid)
            .sortedWith(
                compareByDescending<WifiAdapter.Item> { it.connected }
                    .thenByDescending { it.level },
            )
        applyFilter()
    }

    // ────────────────────────────────────────────────────────────
    //  智能选网：打开就告诉你「先试这个」
    // ────────────────────────────────────────────────────────────

    /** 候选打分，越高越值得先试 */
    private fun targetScore(it: WifiAdapter.Item): Int {
        var s = 0
        if (it.brand != null) s += 60          // 认出品牌，命中率最高
        if (it.kind == WifiAdapter.Kind.OPEN) s += 50   // 开放网络不用密码
        if (it.knownCount > 0) s += 15         // 库里多少有点存货
        s += it.level * 2                      // 信号（0..4 → 0..8）
        if (it.kind == WifiAdapter.Kind.PORTAL) s -= 20 // 要认证，麻烦
        return s
    }

    /**
     * 挑出最该先试的一个。
     *
     * 排除：已连接的（不用试）、隐藏网络（连不上）、企业级（基本连不上）。
     * 如果挑不出来（全被排除），返回 null，界面就不显示建议。
     */
    private fun pickBestTarget(): WifiAdapter.Item? = allItems.asSequence()
        .filter { !it.connected && it.ssid.isNotBlank() }
        .filter { it.kind != WifiAdapter.Kind.ENTERPRISE }
        .maxByOrNull { targetScore(it) }

    /** 更新顶部那句建议 */
    private fun updateHint() {
        val best = pickBestTarget()
        binding.hintText.text = when {
            best == null -> "自动扫网 · 依次试：公用常用密码 → 自带品牌库 → 后端密码库"
            best.brand != null -> "建议先试「${best.ssid}」（认出 ${best.brand}，命中率最高）"
            best.kind == WifiAdapter.Kind.OPEN -> "建议先试「${best.ssid}」（开放网络，不用密码）"
            else -> "建议先试「${best.ssid}」（信号 ${NetworkProbe.rssiLabel(best.rssi)}）"
        }
        // 点这句直接试最佳目标，省一次点击
        binding.hintText.isClickable = best != null
        binding.hintText.setOnClickListener { best?.let { onItemClicked(it) } }
    }

    /** 切换筛选并重排滑块。滑块视觉照 magpie：选中项浮起成卡片色，其余透明。 */
    private fun setFilter(f: Filter) {
        if (filter == f) return
        filter = f
        applyFilter()
    }

    private fun applyFilter() {
        val shown = when (filter) {
            Filter.ALL -> allItems
            Filter.OPEN -> allItems.filter {
                it.kind == WifiAdapter.Kind.OPEN || it.connected
            }
            Filter.PASSWORD -> allItems.filter {
                it.kind == WifiAdapter.Kind.PASSWORD ||
                    it.kind == WifiAdapter.Kind.WEAK ||
                    it.kind == WifiAdapter.Kind.ENTERPRISE ||
                    it.connected
            }
        }
        adapter.submit(shown)

        // 滑块状态
        val segs = listOf(
            Filter.ALL to binding.segAll,
            Filter.OPEN to binding.segOpen,
            Filter.PASSWORD to binding.segPass,
        )
        segs.forEach { (f, v) ->
            val on = f == filter
            v.background = if (on) {
                ContextCompat.getDrawable(this, R.drawable.bg_seg_thumb)
            } else {
                null
            }
            v.setTextColor(
                ContextCompat.getColor(this, if (on) R.color.fg else R.color.ctl_fg),
            )
        }

        // 计数
        binding.countText.text = buildString {
            append("${shown.size} 个网络")
            val hidden = allItems.size - shown.size
            if (filter != Filter.ALL && hidden > 0) append(" · 已筛选 $hidden 个")
            val merged = scanResults.size - allItems.size
            if (merged > 0) append(" · 合并 $merged 个同名接入点")
        }
        binding.dbText.text = "库 ${credStore.count()} 条"
        // 真实成功率，App 自己数的，不是估的
        binding.statsText.text = credStore.statsLine()
        // 智能建议：打开就知道先试哪个
        updateHint()

        if (shown.isEmpty() && allItems.isNotEmpty()) {
            showEmpty(
                "这个筛选下没有网络",
                "切回「全部」看看，或者点右上角重新扫描",
            )
        }
    }

    private fun currentSsid(): String? = try {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wm.connectionInfo?.ssid?.trim('"')?.takeIf {
            it.isNotBlank() && !it.equals("<unknown ssid>", true)
        }
    } catch (_: Exception) {
        null
    }

    // ------------------------------------------------------------ 点击：四层取密降级链

    /**
     * 用户点一行之后的完整流程，严格按四层降级：
     *
     *   Layer 0  检测状态     —— 已连上且能上网就直接结束
     *   Layer 1  本地弱口令    —— 内置高频口令 + SSID 派生，不需要网络
     *   Layer 2  后端密码库    —— GET /v1/lookup，拿到云端候选后合并
     *   Layer 3  搜索兜底      —— 前两层都没有时，给一个可点的搜索链接
     *
     * 每层都会把当前状态写进状态条，用户能看见走到哪一步了。
     */
    private fun onItemClicked(item: WifiAdapter.Item) {
        val ssid = item.ssid
        if (ssid.isBlank()) {
            toast("隐藏网络无法通过建议接口连接")
            return
        }

        // ── 已连接的 → 体检（方案 A 的核心场景）──────────────
        //    你正连着这个网，App 告诉你它到底靠不靠谱
        if (item.connected) {
            runCheckup(item)
            return
        }

        lifecycleScope.launch {
            binding.btnRescan.isEnabled = false

            // ══════════════════════════════════════════════════════
            //  三层取密：公用常用 → 自带品牌库 → 后端密码库
            //
            //  设计原则：严格按顺序，前一层没中才走下一层。
            //  为什么不合并成一个长列表？因为用户需要知道「走到第几层了」，
            //  而且前两层极快（L1 约 5 秒，L2 约 10 秒），合并反而看不出进度。
            // ══════════════════════════════════════════════════════

            var hit: WifiConnector.Result? = null
            var triedTotal = 0

            // ── Layer 1：公用 WiFi 常用密码（不看 SSID，全场景通用）──
            val common = credStore.quickCommonPasswords()
            showStatus("① 公用常用密码：试 ${common.size} 个…")
            val r1 = withContext(Dispatchers.IO) {
                WifiConnector.tryConnect(this@MainActivity, ssid, common) { i, total, psk ->
                    runOnUiThread { showStatus("① 公用常用 · 第 $i/${common.size} 个") }
                }
            }
            triedTotal += r1.tried
            if (r1.success) hit = r1

            // ── Layer 2：自带密码库（认品牌：奶茶店、餐厅、便利店…）──
            if (hit == null) {
                val local = credStore.localBrandCandidates(ssid)
                val brand = credStore.brandOf(ssid)
                if (local.isEmpty()) {
                    showStatus("② 自带密码库：没认出品牌，跳过")
                } else {
                    val tag = if (brand != null) "已认出 $brand" else "SSID 派生"
                    showStatus("② 自带密码库（$tag）：试 ${local.size} 个…")
                    val r2 = withContext(Dispatchers.IO) {
                        WifiConnector.tryConnect(this@MainActivity, ssid, local) { i, total, psk ->
                            runOnUiThread { showStatus("② 自带库 · 第 $i/${local.size} 个") }
                        }
                    }
                    triedTotal += r2.tried
                    if (r2.success) hit = r2
                }
            }

            // ── Layer 3：后端密码库（兜底，搜索也在这里完成）────────
            if (hit == null) {
                showStatus("③ 正在查后端密码库…")
                val remote = ApiClient.lookup(this@MainActivity, ssid)
                val remotePsks = remote.candidates.map { it.psk }.filter { it.isNotBlank() }

                if (remotePsks.isEmpty()) {
                    // 后端也没有 → 它会把这个 SSID 排进采集队列，持续更新
                    showStatus(
                        "③ 后端暂无该门店密码，已排入采集队列。" +
                            "后端会持续搜集，下次打开可能就有了。",
                    )
                } else {
                    showStatus("③ 后端库有 ${remotePsks.size} 个候选，开始试…")
                    val r3 = withContext(Dispatchers.IO) {
                        WifiConnector.tryConnect(this@MainActivity, ssid, remotePsks) { i, total, psk ->
                            runOnUiThread { showStatus("③ 后端库 · 第 $i/${remotePsks.size} 个") }
                        }
                    }
                    triedTotal += r3.tried
                    if (r3.success) hit = r3
                }
            }

            binding.btnRescan.isEnabled = true
            val result = hit
            credStore.recordAttempt(result != null)

            when {
                result != null && result.psk != null -> {
                    credStore.markVerified(ssid, result.psk)
                    toast("连上了，密码已保存")
                    showStatus("✅ 连上 $ssid · 密码 ${result.psk}（已入库 + 已上报）")
                    lifecycleScope.launch {
                        ApiClient.report(this@MainActivity, ssid, result.psk, "worked")
                    }
                }
                result != null -> {
                    showStatus("✅ 连上 $ssid（系统里已有配置，密码未知）")
                }
                else -> {
                    // 三层全失败：不说"搜一下"了，因为搜索已移到后端
                    showStatus(
                        "三层都没命中（共试 $triedTotal 个密码）。" +
                            "已上报后端，它会继续搜集这家店的密码。",
                    )
                    lifecycleScope.launch {
                        ApiClient.report(this@MainActivity, ssid, null, "failed")
                    }
                    // 反正是失败了，不如请用户帮个忙——比只显示"失败"有用
                    showContributeCard(ssid)
                }
            }
            render()
        }
    }

    /** Layer 3：搜索兜底。给可点的搜索链接，不假装能自动提取（搜索侧实测没有数据）。 */
    private fun showSearchFallback(ssid: String, reason: String? = null) {
        val msg = buildString {
            append("③ 搜索兜底：本地和云端都没连上")
            if (reason != null) append("（$reason）")
            append("\n点这里去搜索「$ssid wifi 密码」")
        }
        showStatus(msg)
        binding.statusText.setOnClickListener {
            try {
                startActivity(
                    android.content.Intent(
                        android.content.Intent.ACTION_VIEW,
                        android.net.Uri.parse(ApiClient.searchUrl(ssid)),
                    ),
                )
            } catch (_: Exception) {
                toast("没有可用的浏览器")
            }
        }
        binding.statusText.isClickable = true
    }

    // ------------------------------------------------------------ 卡片内空态

    private fun showEmpty(title: String, hint: String) {
        binding.emptyBox.visibility = View.VISIBLE
        binding.recycler.visibility = View.GONE
        binding.emptyTitle.text = title
        binding.emptyHint.text = hint
        binding.countText.text = "—"
    }

    private fun showStatus(msg: String) {
        binding.statusText.visibility = View.VISIBLE
        binding.statusText.text = msg
    }

    private fun hideStatus() {
        binding.statusText.visibility = View.GONE
    }

    // ────────────────────────────────────────────────────────────
    //  体检（方案 A 的核心）
    // ────────────────────────────────────────────────────────────

    /**
     * 对一个网络做体检。
     *
     * 和「试密码」的区别：试密码的产出是「连上了/没连上」，
     * 体检的产出是「这个网值不值得用」——连不上也有结论，这是关键。
     */
    private fun runCheckup(item: WifiAdapter.Item) {
        lifecycleScope.launch {
            binding.btnRescan.isEnabled = false
            hideStatus()

            // 先亮出卡片并显示「正在测」，让用户知道在干活
            showCheckupSkeleton(item)

            val sec = NetworkProbe.securityOf(item.auth)
            val checkup = NetworkProbe.checkup(
                context = this@MainActivity,
                ssid = item.ssid,
                bssid = item.bssid,
                rssi = item.rssi,
                security = sec,
                psk = null,   // 已连接的网络不需要密码
            )
            renderCheckup(checkup)
            binding.btnRescan.isEnabled = true

            // 上报：这是方案 A 的数据资产，将来卖给商家
            lifecycleScope.launch {
                // 没拿定位权限时不伪造坐标——传空串，后端会把它排除在商圈排行之外。
                // 伪造会比没有更糟：会把无关的门店聚成一个假商圈。
                ApiClient.reportCheckup(this@MainActivity, checkup, "", credStore.brandOf(item.ssid))
            }
        }
    }

    /** 卡片先显示出来，避免用户以为没反应 */
    // ────────────────────────────────────────────────────────────
    //  匿名贡献：三层都没试出来时，请用户帮个忙
    // ────────────────────────────────────────────────────────────

    /**
     * 显示贡献卡片。
     *
     * 产品意图：失败时说「你帮个忙」比说「你失败了」有用。
     * 用户此刻就在店里、就在墙边、抬头就能看到密码贴——
     * 这个时机是拿众包数据最好的时候，过了这个村就没这个店。
     */
    private fun showContributeCard(ssid: String) {
        binding.contributeCard.visibility = View.VISIBLE
        binding.contributeInput.setText("")
        binding.contributeInput.hint = "输入「$ssid」的密码"

        binding.btnContribute.setOnClickListener {
            val psk = binding.contributeInput.text.toString().trim()
            if (psk.length < 8) {
                toast("WiFi 密码至少 8 位")
                return@setOnClickListener
            }
            binding.btnContribute.isEnabled = false
            lifecycleScope.launch {
                val (ok, msg) = ApiClient.contribute(ssid, psk)
                binding.btnContribute.isEnabled = true
                toast(msg)
                if (ok) {
                    // 收下了：卡片刻换成一句确认，不再留输入框
                    binding.contributeCard.visibility = View.GONE
                    showStatus("已收下 $ssid 的密码。下一个人在这家店会省几分钟。")
                    // 本地也记一份，自己下次来直接能用
                    credStore.markVerified(ssid, psk)
                    render()
                }
            }
        }

        binding.btnContributeSkip.setOnClickListener {
            binding.contributeCard.visibility = View.GONE
        }
    }

    private fun showCheckupSkeleton(item: WifiAdapter.Item) {
        val b = binding
        b.checkupCard.visibility = View.VISIBLE
        b.scoreValue.text = "…"
        b.scoreGrade.text = "测试中"
        b.checkupSsid.text = item.ssid
        b.verdictText.text = "正在测速和检查加密方式，大约 10 秒…"
        b.mSignal.text = NetworkProbe.rssiLabel(item.rssi)
        b.mSecurity.text = NetworkProbe.securityOf(item.auth).label
        b.mSpeed.text = "…"
        b.mLatency.text = "…"
        b.tipsText.text = "测试期间会短暂占用网络"
    }

    /** 把体检结果铺到卡片上 */
    private fun renderCheckup(c: NetworkProbe.Checkup) {
        val b = binding
        b.checkupCard.visibility = View.VISIBLE
        b.scoreValue.text = c.score.toString()
        b.scoreValue.setTextColor(scoreColor(c.score))
        b.scoreGrade.text = c.grade
        b.checkupSsid.text = c.ssid
        b.verdictText.text = c.verdict

        b.mSignal.text = "${NetworkProbe.rssiLabel(c.rssi)} ${c.rssi}"
        b.mSecurity.text = c.security.label
        b.mSpeed.text = if (c.speedTested) "${"%.1f".format(c.downloadMbps)} Mbps" else "未测"
        b.mLatency.text = if (c.speedTested) "${c.ttfbMs} ms" else "未测"
        b.tipsText.text = c.tips.joinToString("\n") { "· $it" }

        // 分级配色：好绿、中黄、差红
        b.scoreGrade.backgroundTintList =
            android.content.res.ColorStateList.valueOf(scoreColor(c.score))
    }

    private fun scoreColor(score: Int): Int = when {
        score >= 70 -> getColor(R.color.green)
        score >= 50 -> getColor(R.color.amber)
        else -> getColor(R.color.red)
    }
}