package com.walkingwifi.app

import android.content.Context
import org.json.JSONObject
import java.util.Locale

/**
 * 本地密码库 + 候选密码生成。
 *
 * 数据来源两层：
 *  1. assets/seed_wifi.json —— 内置的公开门店 WiFi 信息（首次启动加载）
 *  2. SharedPreferences —— 用户实测成功过的密码（优先级最高）
 *
 * 候选生成逻辑移植自桌面版 wifik/pskgen.py，核心思想：
 *   按「这个 SSID 像什么」分层给密码，越具体的排越前。
 */
class CredStore(private val context: Context) {

    private val prefs = context.getSharedPreferences("cred_store", Context.MODE_PRIVATE)
    private val seed: List<Entry> by lazy { loadSeed() }

    /**
     * 通用弱口令，来自 assets/weak_passwords.txt。
     * 这个文件由 harvester 从公开字典项目（FreeZeroDays/Coffee-Shop-WiFi-Wordlist）采下来，
     * 是 Layer 1 的第二批候选——比硬编码的 VENUE_PSK 更全。
     */
    private val assetWeak: List<String> by lazy { loadWeakPasswords() }

    /**
     * 品牌规则库（assets/brand_rules.json）。
     *
     * 为什么这个最重要：门店 WiFi 密码有强烈规律——品牌拼音/缩写 + 数字。
     * 实测采集到的 37 家连锁里，haidilao888 / example-psk-f / yangguofu888 / lawson123
     * 全是这个套路。所以只要能把「扫描到的 SSID」对上「品牌」，命中率就从
     * 「随机猜通用弱口令」跳到「有明确方向的几个候选」。
     */
    private val brandRules: List<BrandRule> by lazy { loadBrandRules() }

    data class BrandRule(
        val brand: String,
        val aliases: List<String>,
        val psks: List<String>,
        val suffixes: List<String>,
        val note: String,
    ) {
        /** 判断一个归一化后的 SSID 是否属于这个品牌 */
        fun matches(ssidNorm: String): Boolean =
            aliases.any { a ->
                val an = a.lowercase(Locale.ROOT).replace(Regex("[\\s\\-_]"), "")
                an.isNotEmpty() && ssidNorm.contains(an)
            }
    }

    /** 对外：某个 SSID 匹配到了哪个品牌（没匹配到返回 null）。UI 用来提示用户。 */
    fun brandOf(ssid: String): String? {
        val n = normalize(ssid)
        return brandRules.firstOrNull { it.matches(n) }?.brand
    }

    /** 品牌库覆盖的品牌数，用于界面展示。 */
    fun brandCount(): Int = brandRules.size

    // ------------------------------------------------------------ 成功率统计
    //
    // 「连接率有多少」这个问题，我不靠猜——App 自己数。
    // 每次点一个网络试密码都记一次，成功的也记。界面上直接显示真实数字。

    /** 记一次尝试结果。 */
    fun recordAttempt(success: Boolean) {
        val total = prefs.getInt("att_total", 0) + 1
        val win = prefs.getInt("att_success", 0) + if (success) 1 else 0
        prefs.edit().putInt("att_total", total).putInt("att_success", win).apply()
    }

    /** 返回 (成功次数, 总尝试次数)。从没试过返回 (0, 0)。 */
    fun attemptStats(): Pair<Int, Int> =
        prefs.getInt("att_success", 0) to prefs.getInt("att_total", 0)

    /** 界面用的一句话统计。 */
    fun statsLine(): String {
        val (win, total) = attemptStats()
        return if (total == 0) {
            "还没试过 · 品牌库 ${brandCount()} 家"
        } else {
            val pct = win * 100 / total
            "试过 $total 次 · 成功 $win 次 · $pct% · 品牌库 ${brandCount()} 家"
        }
    }

    data class Entry(
        val ssid: String,
        val psk: String,
        val source: String,   // seed / verified
        val score: Int,
    )

    companion object {
        // 分层分值：越高越优先试
        private const val SCORE_VERIFIED = 100
        private const val SCORE_BRAND = 82
        private const val SCORE_VENUE = 80
        private const val SCORE_DERIVE = 60
        private const val SCORE_GENERIC = 52

        // 商家/公共场所最常见的一批弱口令
        private val VENUE_PSK = listOf(
            "88888888", "12345678", "66666666", "00000000", "8888888888",
            "123456789", "11111111", "12341234", "a12345678", "admin123",
        )

        /**
         * 第一层用的「公用 WiFi 常用密码」。
         *
         * 和 VENUE_PSK 的区别：这个是**实际跑在第一层**的清单，顺序按真实出现频率排。
         * 数量控制在 12 个——配合 Specifier 探测（每个错密码 0.3-0.5 秒），
         * 一轮五六秒就能试完，用户不会有明显等待感。
         *
         * 再往上加会拉长每一轮的固定成本，收益不划算。
         */
        private val COMMON_PSK = listOf(
            "88888888",   // 中国门店出现频率最高
            "12345678",   // 第二
            "{{SECRET_vgsexu6d}}",   // 星巴克等连锁常用
            "66668888",        // 餐厅常见
            "12345678",
            "88888888",
            "12345678",
            "00000000",
            "88888888",
            "a1234567",
            "12341234",
            "admin123",
        )

        // 店名/SSID 后缀模板
        private val SUFFIXES = listOf(
            "888", "8888", "123", "1234", "123456", "666", "0000", "2024", "2025", "520",
        )
    }

    // ---------------------------------------------------------------- 对外

    fun count(): Int = seed.size + verifiedMap().size

    /** 内置种子条数（assets 里带的）。 */
    fun seedCount(): Int = seed.size

    /** 用户实测连通并记下来的条数。 */
    fun verifiedCount(): Int = verifiedMap().values.sumOf { it.size }

    /**
     * 第一层：公用 WiFi 常用密码。
     *
     * 这一层**不看 SSID**——不管走到哪家店，先拿这十几个最常见的碰一遍。
     * 理由是成本极低：配合 Specifier 探测，每个错密码只要 0.3-0.5 秒，
     * 十二个也就五六秒，却能把「店里就设了 12345678 这种」的情况直接拿下来。
     *
     * 排序按真实出现频率，最常用的在前。
     */
    fun quickCommonPasswords(): List<String> = COMMON_PSK

    /**
     * 第二层：自带密码库。
     *
     * 这一层**看 SSID**——认出门店品牌（奶茶店、餐厅、便利店…）后，
     * 拿该品牌的已知密码和规律变体去试。命中率比第一层高，但只在认得出品牌时有用。
     */
    fun localBrandCandidates(ssid: String): List<String> {
        val out = LinkedHashMap<String, Int>()
        fun add(psk: String, score: Int) {
            if (psk.length < 8 || psk.length > 63) return
            val old = out[psk]
            if (old == null || score > old) out[psk] = score
        }

        val norm = normalize(ssid)

        // 用户自己试通过的
        verifiedMap()[norm]?.forEach { add(it, SCORE_VERIFIED) }

        // 品牌命中
        val hitBrand = brandRules.firstOrNull { it.matches(norm) }
        if (hitBrand != null) {
            hitBrand.psks.forEach { add(it, SCORE_BRAND + 10) }
            hitBrand.suffixes.forEach { add(normOf(hitBrand.brand) + it, SCORE_BRAND) }
            hitBrand.aliases.forEach { alias ->
                val a = alias.lowercase(Locale.ROOT).replace(Regex("[\\s\\-_]"), "")
                if (a.length >= 3) hitBrand.suffixes.forEach { add(a + it, SCORE_BRAND - 4) }
            }
        }

        // 种子库里同名/相似的
        seed.filter { normalize(it.ssid) == norm || norm.contains(normalize(it.ssid)) }
            .forEach { add(it.psk, it.score) }

        // SSID 派生
        val base = stripNoise(ssid)
        if (base.length >= 2) {
            SUFFIXES.forEach { add(base + it, SCORE_DERIVE) }
            add(base + base, SCORE_DERIVE - 5)
            val digits = base.filter { it.isDigit() }
            if (digits.length >= 3) add(digits + digits, SCORE_DERIVE - 6)
        }

        return out.entries.sortedByDescending { it.value }.map { it.key }.take(30)
    }

    /** 给一个 SSID，返回按优先级排序的候选密码。 */
    fun candidatesFor(ssid: String): List<String> {
        val out = LinkedHashMap<String, Int>() // psk -> score（保留插入顺序，同分先到先得）
        fun add(psk: String, score: Int) {
            if (psk.length < 8 || psk.length > 63) return
            val old = out[psk]
            if (old == null || score > old) out[psk] = score
        }

        // 1) 用户实测成功过的
        verifiedMap()[normalize(ssid)]?.forEach { add(it, SCORE_VERIFIED) }

        // 2) ★品牌命中★ —— 这是命中率的关键
        //    SSID 里出现品牌别名（mixue / haidilao / luckin / mxbc …）就把该品牌
        //    已知密码和「品牌名+后缀」变体全部排到最前面。
        val norm = normalize(ssid)
        val hitBrand = brandRules.firstOrNull { it.matches(norm) }
        if (hitBrand != null) {
            hitBrand.psks.forEach { add(it, SCORE_BRAND + 10) }
            hitBrand.suffixes.forEach { add(normOf(hitBrand.brand) + it, SCORE_BRAND) }
            hitBrand.aliases.forEach { alias ->
                val a = alias.lowercase(Locale.ROOT).replace(Regex("[\\s\\-_]"), "")
                if (a.length >= 3) hitBrand.suffixes.forEach { add(a + it, SCORE_BRAND - 4) }
            }
        }

        // 3) 种子库里同名/相似 SSID 的密码
        seed.filter { normalize(it.ssid) == norm || norm.contains(normalize(it.ssid)) }
            .forEach { add(it.psk, it.score) }

        // 4) 品牌/店名衍生 —— SSID 本身就是线索
        val base = stripNoise(ssid)
        if (base.length >= 2) {
            SUFFIXES.forEach { add(base + it, SCORE_DERIVE) }
            add(base + base, SCORE_DERIVE - 5)
            // 纯数字段重复（3105 -> 31053105）
            val digits = base.filter { it.isDigit() }
            if (digits.length >= 3) add(digits + digits, SCORE_DERIVE - 6)
        }

        // 5) 通用弱口令兜底（硬编码的一小批 + assets 里采来的字典）
        VENUE_PSK.forEachIndexed { i, p ->
            add(p, maxOf(SCORE_GENERIC - i, 40))
        }
        assetWeak.forEachIndexed { i, p ->
            add(p, (SCORE_GENERIC - 12 - i / 3).coerceAtLeast(35))
        }

        return out.entries
            .sortedByDescending { it.value }
            .map { it.key }
            .take(30)   // 最多 30 个，避免一轮试太久
    }

    /** 标记某 SSID 已用某密码连通。 */
    fun markVerified(ssid: String, psk: String) {
        val key = normalize(ssid)
        val existing = verifiedMap().toMutableMap()
        val list = (existing[key] ?: emptyList()).toMutableList()
        if (!list.contains(psk)) list.add(0, psk)
        existing[key] = list.take(5)
        prefs.edit().putString("verified", encode(existing)).apply()
    }

    // ---------------------------------------------------------------- 内部

    private fun verifiedMap(): Map<String, List<String>> {
        val raw = prefs.getString("verified", null) ?: return emptyMap()
        return try {
            val obj = JSONObject(raw)
            obj.keys().asSequence().associateWith { k ->
                val arr = obj.getJSONArray(k)
                (0 until arr.length()).map { arr.getString(it) }
            }
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun encode(map: Map<String, List<String>>): String {
        val obj = JSONObject()
        map.forEach { (k, v) ->
            val arr = org.json.JSONArray()
            v.forEach { arr.put(it) }
            obj.put(k, arr)
        }
        return obj.toString()
    }

    private fun loadSeed(): List<Entry> {
        val text = try {
            context.assets.open("seed_wifi.json").bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            return emptyList()
        }
        return try {
            val arr = org.json.JSONArray(text)
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.getJSONObject(i)
                val ssid = o.optString("ssid")
                val psks = o.optJSONArray("passwords")
                if (ssid.isBlank() || psks == null || psks.length() == 0) return@mapNotNull null
                // 只取第一条密码作为该店的代表
                Entry(ssid, psks.getString(0), "seed", o.optInt("score", SCORE_VENUE))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * 读品牌规则。优先读热更新下来的那份（filesDir），没有再读 APK 内置的（assets）。
     * 这样改了密码库不用重新发版——见 RulesUpdater。
     */
    private fun loadBrandRules(): List<BrandRule> {
        val text = readBrandRulesText() ?: return emptyList()
        if (text.isBlank()) return emptyList()
        return try {
            val arr = JSONObject(text).getJSONArray("brands")
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.getJSONObject(i)
                val brand = o.optString("brand")
                if (brand.isBlank()) return@mapNotNull null
                fun strList(key: String): List<String> {
                    val a = o.optJSONArray(key) ?: return emptyList()
                    return (0 until a.length()).map { a.getString(it) }.filter { it.isNotBlank() }
                }
                BrandRule(
                    brand = brand,
                    aliases = strList("aliases").ifEmpty { listOf(brand) },
                    psks = strList("psks"),
                    suffixes = strList("suffixes").ifEmpty { listOf("888", "123", "2024") },
                    note = o.optString("note"),
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** 品牌名归一化，用于拼「品牌名+后缀」的候选 */
    private fun normOf(s: String): String =
        s.trim().lowercase(Locale.ROOT)
            .replace(Regex("[\\s\\-_·]"), "")
            .replace(Regex("[（）()【】]"), "")

    /**
     * 读品牌规则文本：优先热更新下来的（filesDir），退回 APK 内置的（assets）。
     * 热更新那份由 RulesUpdater 写入，改密码库不用重新发版。
     */
    private fun readBrandRulesText(): String? {
        // 1) 热更新文件
        try {
            val f = RulesUpdater.cachedFile(context)
            if (f.exists() && f.length() > 64) {
                val t = f.readText()
                if (t.contains("\"brands\"")) return t
            }
        } catch (_: Exception) {
        }
        // 2) APK 内置
        return try {
            context.assets.open("brand_rules.json").bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        }
    }

    /** 当前用的是热更新包还是 APK 内置包，界面展示用。 */
    fun rulesSource(): String {
        val v = RulesUpdater.localVersion(context)
        return if (v > 0) "规则包 v$v（云端）" else "规则包（内置）"
    }

    /** 归一化：小写、去掉引号、去掉 -5G / _5G 这类频段后缀。 */
    private fun normalize(ssid: String): String {
        var s = ssid.trim().trim('"').lowercase(Locale.ROOT)
        s = s.replace(Regex("[-_ ]?(5g|2\\.4g|2g|6g)$"), "")
        s = s.replace(Regex("[\\s\\-_]"), "")
        return s
    }

    /**
     * 读 assets/weak_passwords.txt。
     * 由 harvester 采集器从公开字典项目生成，一行一个密码，8–63 位。
     */
    private fun loadWeakPasswords(): List<String> = try {
        context.assets.open("weak_passwords.txt").bufferedReader().use { r ->
            r.readLines()
                .map { it.trim() }
                .filter { it.length in 8..63 && !it.startsWith("#") }
                .distinct()
        }
    } catch (_: Exception) {
        emptyList()
    }

    /** 去掉噪声后的「名字主体」，用于生成 名字+后缀 的候选。 */
    private fun stripNoise(ssid: String): String {
        var s = ssid.trim().trim('"')
        s = s.replace(Regex("(?i)[-_ ]?(5g|2\\.4g|2g|6g)$"), "")
        s = s.replace(Regex("[\\s\\-_]"), "")
        return s.lowercase(Locale.ROOT)
    }
}