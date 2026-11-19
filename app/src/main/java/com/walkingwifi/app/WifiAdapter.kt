package com.walkingwifi.app

import android.graphics.Canvas
import android.graphics.Rect
import android.net.wifi.ScanResult
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import com.walkingwifi.app.databinding.ItemWifiBinding

/**
 * WiFi 列表适配器。
 *
 * 视觉参考 yetone/magpie 的 .row：
 *   左信号条 │ SSID + meta 副标题 │ 右侧状态胶囊
 * 行间分割线由 [DividerDecoration] 统一画，行自身不画线。
 */
class WifiAdapter(private val onClick: (Item) -> Unit) :
    RecyclerView.Adapter<WifiAdapter.VH>() {

    enum class Kind { OPEN, PORTAL, PASSWORD, ENTERPRISE, WEAK }

    data class Item(
        val ssid: String,
        val bssid: String,
        val level: Int,        // 0..4
        val rssi: Int,
        val auth: String,      // WPA3 / WPA2 / WEP / 802.1X / OPEN
        val kind: Kind,
        val kindLabel: String,
        val knownCount: Int,
        val connected: Boolean = false,
        val apCount: Int = 1,  // 同一 SSID 有几个接入点（2.4G/5G 同名）
        val brand: String? = null,  // 匹配到的连锁品牌（命中则密码有明确方向）
    ) {
        companion object {
            /** 单个接入点 → Item */
            fun from(r: ScanResult, store: CredStore, connectedSsid: String?): Item {
                val ssid = r.SSID ?: ""
                val caps = r.capabilities ?: ""
                val auth = when {
                    caps.contains("SAE", true) -> "WPA3"
                    caps.contains("PSK", true) -> "WPA2"
                    caps.contains("WEP", true) -> "WEP"
                    caps.contains("EAP", true) -> "802.1X"
                    else -> "OPEN"
                }
                val kind = when (auth) {
                    "OPEN" -> Kind.OPEN
                    "WEP" -> Kind.WEAK
                    "802.1X" -> Kind.ENTERPRISE
                    else -> Kind.PASSWORD
                }
                val label = when (kind) {
                    Kind.OPEN -> "开放"
                    Kind.WEAK -> "弱加密"
                    Kind.ENTERPRISE -> "企业网"
                    Kind.PORTAL -> "需认证"
                    Kind.PASSWORD -> "需密码"
                }
                val level = android.net.wifi.WifiManager.calculateSignalLevel(r.level, 5)
                val isConnected = ssid.isNotBlank() && ssid == connectedSsid
                return Item(
                    ssid = ssid,
                    bssid = r.BSSID ?: "",
                    level = level,
                    rssi = r.level,
                    auth = auth,
                    kind = kind,
                    kindLabel = label,
                    knownCount = if (ssid.isBlank()) 0 else store.candidatesFor(ssid).size,
                    connected = isConnected,
                    brand = if (ssid.isBlank()) null else store.brandOf(ssid),
                )
            }

            /**
             * 把扫描结果按 SSID 合并，一个网络只占一行，取信号最强的那个 AP 作代表。
             *
             * 理由：同一个路由器常同时广播 `XXX` 和 `XXX-5G`，或者同一 SSID 有多个 BSSID
             * （Mesh / 多 AP）。对用户来说这是"一个网络"，逐条列出会让列表翻倍，
             * 也让"已连接"看起来出现了两次。
             */
            fun aggregate(
                results: List<ScanResult>,
                store: CredStore,
                connectedSsid: String?,
            ): List<Item> {
                val bySsid = LinkedHashMap<String, MutableList<ScanResult>>()
                for (r in results) {
                    val key = (r.SSID ?: "").trim()
                    bySsid.getOrPut(key) { mutableListOf() }.add(r)
                }
                return bySsid.map { (ssid, aps) ->
                    val best = aps.maxByOrNull { it.level } ?: aps.first()
                    from(best, store, connectedSsid).copy(apCount = aps.size)
                }
            }
        }
    }

    private val items = mutableListOf<Item>()

    fun submit(list: List<Item>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val b = ItemWifiBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return VH(b)
    }

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    override fun getItemCount(): Int = items.size

    inner class VH(private val b: ItemWifiBinding) : RecyclerView.ViewHolder(b.root) {
        fun bind(item: Item) {
            val ctx = b.root.context

            b.ssid.text = if (item.ssid.isBlank()) "<隐藏网络>" else item.ssid

            // meta：magpie 的「· 」分隔多段
            val parts = mutableListOf(item.auth, "${item.rssi} dBm")
            if (item.apCount > 1) parts += "${item.apCount} 个接入点"
            // 品牌命中是比「库里 N 个候选」更强的信号，优先显示
            if (item.brand != null) {
                parts += "★ ${item.brand}"
            } else {
                parts += if (item.knownCount > 0) "库中 ${item.knownCount} 个候选" else "库中无记录"
            }
            b.meta.text = parts.joinToString(" · ")

            // 信号条：亮到 level 格，其余用 faint
            val bars = listOf(b.bar1, b.bar2, b.bar3, b.bar4)
            val onColor = when {
                item.level >= 3 -> R.color.green
                item.level == 2 -> R.color.amber
                else -> R.color.red
            }
            bars.forEachIndexed { i, v ->
                v.setBackgroundColor(
                    ContextCompat.getColor(ctx, if (i < item.level) onColor else R.color.faint),
                )
                // 弱信号时降低不透明度，保持"安静"
                v.alpha = if (i < item.level) 1f else 0.35f
            }

            // 状态胶囊：已连接 > 开放 > Portal > 需密码
            // 注意：必须用 backgroundTint 而不是 setBackgroundColor，
            // 后者会把带圆角的 drawable 整个替换成纯色矩形，圆角就没了。
            val (label, fg, bg) = when {
                item.connected -> Triple("已连接", R.color.green, R.color.green_soft)
                item.kind == Kind.OPEN -> Triple(item.kindLabel, R.color.accent, R.color.accent_soft)
                item.kind == Kind.WEAK -> Triple(item.kindLabel, R.color.red, R.color.red_soft)
                item.kind == Kind.ENTERPRISE -> Triple(item.kindLabel, R.color.muted, R.color.pill)
                else -> Triple(item.kindLabel, R.color.amber, R.color.amber_soft)
            }
            b.kind.text = label
            b.kind.setTextColor(ContextCompat.getColor(ctx, fg))
            b.kind.backgroundTintList =
                android.content.res.ColorStateList.valueOf(ContextCompat.getColor(ctx, bg))

            b.root.setOnClickListener { onClick(item) }
        }
    }

    /**
     * 行间 1px 分割线，颜色用 magpie 的 --line-2，且两侧留出内边距——
     * 这样线只在文字区域内，不顶到卡片边框，跟 magpie 的 .row + .row 一致。
     */
    class DividerDecoration(private val insetDp: Int = 14) : RecyclerView.ItemDecoration() {
        private val paint = android.graphics.Paint()
        private var inset = 0

        override fun getItemOffsets(
            outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State,
        ) {
        }

        override fun onDraw(c: Canvas, parent: RecyclerView, state: RecyclerView.State) {
            if (inset == 0) {
                inset = (insetDp * parent.resources.displayMetrics.density).toInt()
            }
            paint.color = ContextCompat.getColor(parent.context, R.color.line_2)
            paint.strokeWidth = parent.resources.displayMetrics.density.coerceAtLeast(1f)

            for (i in 0 until parent.childCount) {
                val child = parent.getChildAt(i)
                val pos = parent.getChildAdapterPosition(child)
                if (pos == RecyclerView.NO_POSITION) continue
                if (pos == parent.adapter?.itemCount?.minus(1)) continue // 最后一行不画
                val y = (child.bottom + child.translationY).toFloat()
                c.drawLine(
                    (child.left + inset).toFloat(), y,
                    (child.right - inset).toFloat(), y,
                    paint,
                )
            }
        }
    }
}