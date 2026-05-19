let payload = null;
let rows = [];
let filtered = [];
let selectedCode = null;
let sortKey = "最接近類別尚差";
let sortDir = 1;
let hasActuals = false;

const GROUPS = [
  ["已被處置_第二次",       "已被處置_第二次",       "目前處置中，第二次以上處置"],
  ["已被處置_第一次",       "已被處置_第一次",       "目前處置中，仍追蹤是否碰第二次"],
  ["處置中_差一次進第二次", "處置中_差一次進第二次", "第一次處置中，差一次進第二次處置"],
  ["處置中_差兩次進第二次", "處置中_差兩次進第二次", "第一次處置中，差兩次進第二次處置"],
  ["差一次被處置",           "差一次被處置",           "已集兩點，尚差 1"],
  ["差兩次被處置",           "差兩次被處置",           "已集一點，尚差 2"],
];

const nf = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v) || v === "") return "-";
  if (typeof v === "number") return nf.format(v);
  return v;
}

function evalLabel() {
  if (!payload?.eval_date) return "估計日";
  const [, month, day] = payload.eval_date.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function rowGroup(r) {
  if (r["網站分組"]) return r["網站分組"];
  const order = r["目前處置次數"] || r["若5_12觸發_預估處置次數"] || "";
  if (r["處置中_5_12"] && String(order).includes("第二次")) return "已被處置_第二次";
  if (r["處置中_5_12"]) return "已被處置_第一次";
  if (Number(r["最接近類別尚差"]) === 1) return "差一次被處置";
  if (Number(r["最接近類別尚差"]) === 2) return "差兩次被處置";
  return "其他";
}

function riskPill(row) {
  if (row["處置中_5_12"]) return `<span class="pill danger">${fmt(row["目前處置次數"] || "處置中")}</span>`;
  if (row["5_12觸發處置類別"]) return `<span class="pill danger">${compactClauses(row["5_12觸發處置類別"])}</span>`;
  if (Number(row["最接近類別尚差"]) <= 1) return `<span class="pill warn">尚差 ${row["最接近類別尚差"]}</span>`;
  return `<span class="pill ok">觀察</span>`;
}

function compactClauses(value) {
  if (!value) return "-";
  return String(value)
    .replaceAll("(門檻)", "")
    .replaceAll("(量門檻)", "")
    .replaceAll("(週轉門檻)", "")
    .replace(/,/g, "、");
}

function clauseChips(value) {
  if (!value) return `<span class="clause-empty">-</span>`;
  return String(value)
    .split(",")
    .filter(Boolean)
    .map((x) => `<span class="clause-chip">${x}</span>`)
    .join("");
}

function minPriceThreshold(r) {
  const items = [
    ["款1", r["k1_price_threshold"]],
    [`款2${r["k2_nearest_window"] ? ` ${r["k2_nearest_window"]}` : ""}`, r["k2_price_threshold"]],
    ["款6", r["k6_min_price_to_trigger"]],
  ]
    .map(([label, value]) => [label, Number(value)])
    .filter(([, value]) => Number.isFinite(value));
  if (!items.length) return "-";
  items.sort((a, b) => a[1] - b[1]);
  return `${fmt(items[0][1])} (${items[0][0]}，${priceMoveFromPrev(r, items[0][1])})`;
}

function priceMoveFromPrev(r, target) {
  const prev = Number(r["prev_close_for_eval"] ?? r["5_12收盤價"]);
  const price = Number(target);
  if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(price))
    return `<span class="pbadge pbadge-neutral">--</span>`;
  const pct = ((price - prev) / prev) * 100;
  if (pct <= -11) return `<span class="pbadge pbadge-halt">⚠ 跌停仍觸</span>`;
  const sign = pct > 0 ? "+" : "";
  const cls = pct > 0 ? "pbadge-up" : "pbadge-down";
  return `<span class="pbadge ${cls}">${sign}${fmt(pct)}%</span>`;
}

function minutesBadge(text) {
  if (!text || text === "-") return `<span class="minutes-chip minutes-chip-exit">-</span>`;
  if (text === "5分盤")  return `<span class="minutes-chip minutes-chip-5">5分盤</span>`;
  if (text === "10分盤") return `<span class="minutes-chip minutes-chip-10">10分盤</span>`;
  if (text === "20分盤") return `<span class="minutes-chip minutes-chip-20">20分盤</span>`;
  if (text === "25分盤") return `<span class="minutes-chip minutes-chip-25">25分盤</span>`;
  if (text === "45分盤") return `<span class="minutes-chip minutes-chip-45">45分盤</span>`;
  if (text === "60分盤") return `<span class="minutes-chip minutes-chip-60">60分盤</span>`;
  if (text === "90分盤") return `<span class="minutes-chip minutes-chip-90">90分盤</span>`;
  if (text === "已出關") return `<span class="minutes-chip minutes-chip-exit">已出關</span>`;
  return `<span class="minutes-chip minutes-chip-exit">${text}</span>`;
}

function disposalReasonBadge(text) {
  if (!text || text === "-") return `<span class="reason-chip reason-chip-other">-</span>`;
  const t = String(text);
  if (/連[續]?[三3]|3個營業日|三個營業日/.test(t))
    return `<span class="reason-chip reason-chip-3">連三</span>`;
  if (/連[續]?[五5]|5個營業日|五個營業日/.test(t))
    return `<span class="reason-chip reason-chip-5">連五</span>`;
  if (/十個營業日|10個營業日|最近十|最近10/.test(t))
    return `<span class="reason-chip reason-chip-10">10日中6日</span>`;
  if (/三十個|30個|30日|最近三十|最近30/.test(t))
    return `<span class="reason-chip reason-chip-30">30日</span>`;
  const label = t.length > 14 ? t.slice(0, 14) + "…" : t;
  return `<span class="reason-chip reason-chip-other">${label}</span>`;
}

function directionLabel(v) {
  if (v === "up") return "上漲";
  if (v === "down") return "下跌";
  return fmt(v);
}

function priceUpDown(up, down) {
  return `上漲 ${fmt(up)} / 下跌 ${fmt(down)}`;
}

function renderSummary() {
  const total = rows.length;
  const counts = Object.fromEntries(GROUPS.map(([key]) => [key, rows.filter((r) => rowGroup(r) === key).length]));
  const items = [
    ["候選檔數",             total],
    ["已被處置_第二次",       counts["已被處置_第二次"]],
    ["已被處置_第一次",       counts["已被處置_第一次"]],
    ["差一次進第二次",        counts["處置中_差一次進第二次"]],
    ["差兩次進第二次",        counts["處置中_差兩次進第二次"]],
    ["差一次被處置",           counts["差一次被處置"]],
    ["差兩次被處置",           counts["差兩次被處置"]],
  ];
  document.getElementById("summaryGrid").innerHTML = items
    .map(([label, value]) => `<div class="summary-card"><span>${label}</span><b>${fmt(value)}</b></div>`)
    .join("");
}

function applyFilters() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const filter = document.getElementById("riskFilter").value;
  filtered = rows.filter((r) => {
    const hay = [r["證券代碼"], r["證券名稱"], r["市場產業"], r["5_12觸發處置類別"], r["最接近類別"]]
      .join(" ")
      .toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (filter === "triggered" && !r["5_12觸發處置類別"]) return false;
    if (filter === "near" && Number(r["最接近類別尚差"]) > 1) return false;
    if (filter === "active" && !r["處置中_5_12"]) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
    return String(av ?? "").localeCompare(String(bv ?? ""), "zh-Hant") * sortDir;
  });
  renderRows();
}

function groupKind(key) {
  if (key === "已被處置_第二次" || key === "已被處置_第一次") return "disposal";
  if (key === "處置中_差一次進第二次" || key === "處置中_差兩次進第二次") return "disposal_near2";
  return "notice";
}

function renderRows() {
  const host = document.getElementById("tableGroups");
  const actCol = hasActuals ? `<th>實際結果</th>` : "";
  const disposalHeader = `
    <thead>
      <tr>
        ${actCol}
        <th data-sort="證券代碼">代碼</th>
        <th data-sort="證券名稱">名稱</th>
        <th data-sort="5_12收盤價">收盤</th>
        <th data-sort="目前處置原因">處置原因</th>
        <th data-sort="目前處置開始日">開始日</th>
        <th data-sort="目前處置結束日">結束日</th>
        <th data-sort="目前處置剩餘交易日">剩餘交易日</th>
        <th data-sort="目前處置分盤">分盤</th>
      </tr>
    </thead>`;
  const disposalNear2Header = `
    <thead>
      <tr>
        ${actCol}
        <th data-sort="證券代碼">代碼</th>
        <th data-sort="證券名稱">名稱</th>
        <th data-sort="5_12收盤價">收盤</th>
        <th data-sort="目前處置原因">處置原因</th>
        <th data-sort="目前處置開始日">開始日</th>
        <th data-sort="目前處置結束日">結束日</th>
        <th data-sort="目前處置剩餘交易日">剩餘交易日</th>
        <th data-sort="目前處置分盤">分盤</th>
        <th data-sort="距第二次尚差">距二次尚差</th>
      </tr>
    </thead>`;
  const header = `
    <thead>
      <tr>
        ${actCol}
        <th data-sort="證券代碼">代碼</th>
        <th data-sort="證券名稱">名稱</th>
        <th data-sort="5_12收盤價">收盤</th>
        <th>最低價門檻</th>
        <th data-sort="5_12觸發處置類別">狀態</th>
        <th data-sort="最接近類別尚差">尚差</th>
        <th data-sort="最接近類別">最近類別</th>
      </tr>
    </thead>`;
  host.innerHTML = GROUPS.map(([key, title, hint]) => {
    const groupRows = filtered.filter((r) => rowGroup(r) === key);
    const kind = groupKind(key);
    const isDisposal = kind === "disposal" || kind === "disposal_near2";
    const colSpan = (kind === "disposal_near2" ? 9 : isDisposal ? 8 : 7) + (hasActuals ? 1 : 0);
    const body = groupRows.length
      ? groupRows
          .map((r) => {
            const sel = selectedCode === r["證券代碼"] ? "selected" : "";
            const code = r["證券代碼"];
            const outcomeClass = r.actual_punish ? " row-punish" : r.actual_notice ? " row-notice" : "";
            const actCell = hasActuals ? `<td>${outcomeBadge(r)}</td>` : "";
            if (kind === "disposal" || kind === "disposal_near2") {
              const remainDays = r["已出關"]
                ? `<span class="minutes-chip minutes-chip-exit">已出關</span>`
                : r["目前處置剩餘交易日"] != null ? r["目前處置剩餘交易日"] : "-";
              const extra = kind === "disposal_near2"
                ? `<td><span class="pill ${Number(r["距第二次尚差"]) <= 1 ? "danger" : "warn"}">${fmt(r["距第二次尚差"])}</span></td>`
                : "";
              return `<tr class="${sel}${outcomeClass}" data-code="${code}">
        ${actCell}
        <td class="code">${code}</td>
        <td>${r["證券名稱"]}</td>
        <td>${fmt(r["5_12收盤價"])}</td>
        <td>${disposalReasonBadge(r["目前處置原因"])}</td>
        <td>${fmt(r["目前處置開始日"])}</td>
        <td>${fmt(r["目前處置結束日"])}</td>
        <td>${remainDays}</td>
        <td>${minutesBadge(r["目前處置分盤"])}</td>
        ${extra}
      </tr>`;
            }
            return `<tr class="${sel}${outcomeClass}" data-code="${code}">
        ${actCell}
        <td class="code">${code}</td>
        <td>${r["證券名稱"]}</td>
        <td>${fmt(r["5_12收盤價"])}</td>
        <td>${minPriceThreshold(r)}</td>
        <td>${riskPill(r)}</td>
        <td>${fmt(r["最接近類別尚差"])}</td>
        <td>${fmt(r["最接近類別"])}</td>
      </tr>`;
          })
          .join("")
      : `<tr><td colspan="${colSpan}" class="empty">沒有符合條件的資料</td></tr>`;
    const theHeader = kind === "disposal_near2" ? disposalNear2Header : isDisposal ? disposalHeader : header;
    return `<section class="table-group">
      <div class="group-title"><span>${title}</span><small>${hint} / ${groupRows.length} 檔</small></div>
      <div class="group-table"><table>${theHeader}<tbody>${body}</tbody></table></div>
    </section>`;
  }).join("");

  host.querySelectorAll("tr[data-code]").forEach((tr) => {
    tr.addEventListener("click", () => {
      selectedCode = tr.dataset.code;
      renderRows();
      renderDetail(rows.find((r) => r["證券代碼"] === selectedCode));
    });
  });

  host.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir *= -1;
      else {
        sortKey = key;
        sortDir = 1;
      }
      applyFilters();
    });
  });
}

function renderDetail(r) {
  if (!r) return;
  const day = evalLabel();
  const grp = rowGroup(r);
  const kind = groupKind(grp);
  if (kind === "disposal" || kind === "disposal_near2") {
    const remainTd = r["目前處置剩餘交易日"];
    const remainStr = r["已出關"]
      ? `<span class="minutes-chip minutes-chip-exit">已出關</span>`
      : remainTd != null ? `${remainTd} 日` : "-";
    const near2Section = kind === "disposal_near2" ? `
      <div class="section-title">距第二次處置</div>
      ${kv("距第二次尚差（最小路徑）", `<span class="pill ${Number(r["距第二次尚差"]) <= 1 ? "danger" : "warn"}">${fmt(r["距第二次尚差"])} 次</span>`)}
      ${kv("處置後連3第1款", `${fmt(r["處置後連3第1款"])} / 3`)}
      ${kv("處置後連5第1-8款", `${fmt(r["處置後連5第1到8款"])} / 5`)}
      ${kv("處置後10日次數", `${fmt(r["處置後10日次數"])} / 6`)}
      ${kv("處置後30日次數", `${fmt(r["處置後30日次數"])} / 12`)}
      ${r["若評估日成為注意_觸發處置類別"] ? kv("若今日再被注意將觸發", r["若評估日成為注意_觸發處置類別"]) : ""}
    ` : "";
    document.getElementById("detailPanel").innerHTML = `
      <div class="detail-title">
        <div>
          <div class="code">${r["證券代碼"]}</div>
          <h2>${r["證券名稱"]}</h2>
        </div>
        ${riskPill(r)}
      </div>
      <div class="metric-grid">
        <div class="metric"><span>基準收盤價</span><b>${fmt(r["5_12收盤價"])}</b></div>
        <div class="metric"><span>${day}處置中</span><b>是</b></div>
        <div class="metric"><span>目前處置次數</span><b>${fmt(r["目前處置次數"] || (grp === "已被處置_第二次" ? "第二次以上處置" : "第一次處置"))}</b></div>
        <div class="metric"><span>分盤</span><b>${minutesBadge(r["目前處置分盤"])}</b></div>
      </div>
      ${kv("處置原因", disposalReasonBadge(r["目前處置原因"]))}
      ${kv("開始日", fmt(r["目前處置開始日"]))}
      ${kv("結束日", fmt(r["目前處置結束日"]))}
      ${kv("剩餘交易日", remainStr)}
      ${kv("產業", fmt(r["市場產業"]))}
      ${near2Section}
    `;
    return;
  }
  const boards = [
    ["連3第1款",  r["加上5_12後連3第1款"],   3,  r["連3第1款集點日期"],    true],
    ["連5第1-8款", r["加上5_12後連5第1到8款"], 5, r["連5第1到8款集點日期"], false],
    ["10日6次",   r["加上5_12後10日次數"],    6,  r["10日6次集點日期"],     false],
    ["30日12次",  r["加上5_12後30日次數"],    12, r["30日12次集點日期"],    false],
  ];
  document.getElementById("detailPanel").innerHTML = `
    <div class="detail-title">
      <div>
        <div class="code">${r["證券代碼"]}</div>
        <h2>${r["證券名稱"]}</h2>
      </div>
      ${riskPill(r)}
    </div>
    <div class="metric-grid">
      <div class="metric"><span>基準收盤價</span><b>${fmt(r["5_12收盤價"])}</b></div>
      <div class="metric"><span>基準成交量(張)</span><b>${fmt(r["5_12成交量千股"])}</b></div>
      <div class="metric"><span>基準週轉率</span><b>${fmt(r["5_12週轉率"])}%</b></div>
      <div class="metric metric-clauses"><span>${day}門檻款</span><div>${clauseChips(r["5_12可算注意款"])}</div></div>
    </div>

    <div class="section-title">四類集點版</div>
    <div class="point-board">
      ${boards.map(([name, value, target, dates, onlyK1]) => pointCard(name, value, target, dates, r, onlyK1)).join("")}
    </div>
    ${kv("最接近類別", `${r["最接近類別"]}，尚差 ${r["最接近類別尚差"]}`)}
    ${kv(`${day}處置中`, r["處置中_5_12"] ? "是" : "否")}
    ${kv("目前處置次數", r["目前處置次數"] || "-")}
    ${kv("網站分組", rowGroup(r))}
    ${kv("若觸發預估", r["若5_12觸發_預估處置次數"] ? `${r["若5_12觸發_預估處置次數"]} / ${r["若5_12觸發_預估分盤"]}` : "-")}

    <div class="section-title">價格門檻</div>
    ${kv("最低價門檻", minPriceThreshold(r))}
    ${kv("款1 計算基準", `${fmt(r["k1_base_date"])} 收盤 ${fmt(r["k1_base_price"])}；前5日累計 ${fmt(r["k1_prev5_return_pct"])}%；前日收盤 ${fmt(r["prev_close_for_eval"])}`)}
    ${kv("款1 條件1門檻", priceUpDown(r["k1_clause1_price_threshold_up"], r["k1_clause1_price_threshold_down"]))}
    ${kv("款1 條件2門檻", `${priceUpDown(r["k1_clause2_price_threshold_up"], r["k1_clause2_price_threshold_down"])}；價差至少 ${fmt(r["k1_clause2_price_diff_threshold"])} 元`)}
    ${kv("款1 採用門檻", `${fmt(r["k1_price_threshold"])}（${fmt(r["k1_nearest_clause"])}，${directionLabel(r["k1_nearest_direction"])}，離現價 ${fmt(r["k1_price_gap"])}）`)}
    ${kv("款1 未取跳動單位前", priceUpDown(r["k1_price_threshold_raw_up"], r["k1_price_threshold_raw_down"]))}
    ${kv("款2 計算基準", `${fmt(r["k2_nearest_window"])}：${fmt(r["k2_nearest_base_date"])} 收盤 ${fmt(r["k2_nearest_base_price"])}`)}
    ${kv("款2 採用門檻", `${fmt(r["k2_price_threshold"])}（${directionLabel(r["k2_nearest_direction"])}，離現價 ${fmt(r["k2_price_gap"])}）`)}
    ${kv("款2 未取跳動單位前", fmt(r["k2_price_threshold_raw"]))}

    <div class="section-title">成交量與週轉門檻</div>
    ${kv("款3 當日量門檻", `${fmt(r["k3_day_volume_threshold_k"])} 張`)}
    ${kv("款4 週轉量門檻", `${fmt(r["k4_turnover_volume_threshold_k"])} 張`)}
    ${kv("款6 週轉量門檻（週轉率≥5% AND 量≥門檻）", r["k6_turnover_volume_threshold_k"] != null ? `${fmt(r["k6_turnover_volume_threshold_k"])} 張` : "-")}
    ${r["k5_k7_price_threshold"] != null ? kv(`款5 價格門檻（${fmt(r["k5_k7_abs_ret_threshold"])}% 漲幅，${r["k5_note"] || "仍需考慮當日券商資料"}）`, `${fmt(r["k5_k7_price_threshold"])} ${priceMoveFromPrev(r, r["k5_k7_price_threshold"])}`) : ""}
    ${r["k5_k7_price_threshold"] != null ? kv(`款7 價格門檻（${fmt(r["k5_k7_abs_ret_threshold"])}% 漲幅，${r["k7_note"] || "需考慮當日資券比"}）`, `${fmt(r["k5_k7_price_threshold"])} ${priceMoveFromPrev(r, r["k5_k7_price_threshold"])}`) : ""}
    ${kv("款3 六日累計量估算門檻", `${fmt(r["volume_6d_proxy_threshold_k"])} 張`)}
    ${kv("估算60日均量", `${fmt(r["proxy_avg60_volume_k"])} 張`)}

    <div class="section-title">款6 / PE / PB</div>
    ${kv("款6估算觸發", r["款6_估算觸發"] ? "是" : "否")}
    ${kv("款6最低觸發價", fmt(r["k6_min_price_to_trigger"]))}
    ${kv("款6最低觸發價未取跳動單位前", fmt(r["k6_min_price_to_trigger_raw"]))}
    ${kv("跌停價", fmt(r["limit_down_price"]))}
    ${kv("跌停仍觸發款6", r["k6_limit_down_still_triggers"] ? "是" : "否")}
    ${kv("跌停PBR仍超標", r["k6_pbr_limit_down_still_over"] ? "是" : "否")}
    ${kv(`${day}估算PBR`, fmt(r["pbr_est_512"]))}
    ${kv("PE負值/缺值視為負PE", r["k6_pe_negative"] ? "是" : "否")}
    ${kv("PE 需要高於平均倍數", fmt(r["k6_pe_required_ratio"]))}
    ${kv("款6 PE對應價", fmt(r["k6_price_by_pe_threshold"]))}
    ${kv("款6 PE對應價未取跳動單位前", fmt(r["k6_price_by_pe_threshold_raw"]))}
    ${kv("PBR 需要高於平均倍數", fmt(r["k6_pbr_required_ratio"]))}
    ${kv("款6 PBR對應價", fmt(r["k6_price_by_pbr_threshold"]))}
    ${kv("款6 PBR對應價未取跳動單位前", fmt(r["k6_price_by_pbr_threshold_raw"]))}
    ${kv("只看PBR最低價", fmt(r["k6_pbr_min_price_to_trigger"]))}
    ${kv("款6 週轉量門檻", `${fmt(r["k6_turnover_volume_threshold_k"])} 張`)}
    ${kv("反推EPS", fmt(r["eps_from_pe"]))}
    ${kv("款1門檻PE", fmt(r["pe_at_k1_threshold"]))}
    ${kv("款2門檻PE", fmt(r["pe_at_k2_threshold"]))}
    ${kv("PBR註記", r["pbr_note"])}
  `;
}

function kv(k, v) {
  return `<div class="kv"><span>${k}</span><strong>${v}</strong></div>`;
}

function mmddShort(iso) {
  if (!iso) return "-";
  const s = String(iso);
  const m = s.match(/(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}/${Number(m[2])}` : s.slice(-5);
}

function clauseThresholdLines(r, onlyK1) {
  const close = Number(r["5_12收盤價"]);
  const k1bd = r["k1_base_date"], k1bp = r["k1_base_price"];
  const lines = [];

  const k1p = Number(r["k1_price_threshold"]);
  const k1g = Number(r["k1_price_gap"]);
  if (Number.isFinite(k1p)) {
    lines.push({ id: "k1", label: "款①", price: k1p, gap: k1g, vols: [], notes: [], baseDate: k1bd, basePrice: k1bp });
  }

  if (!onlyK1) {
    const k2p = Number(r["k2_price_threshold"]);
    if (Number.isFinite(k2p)) {
      lines.push({ id: "k2", label: `款②${r["k2_nearest_window"] ? `(${r["k2_nearest_window"]})` : ""}`, price: k2p, gap: Number(r["k2_price_gap"]), vols: [], notes: [], baseDate: r["k2_nearest_base_date"], basePrice: r["k2_nearest_base_price"] });
    }
    const k57p = Number(r["k5_k7_price_threshold"]);
    const k57g = Number(r["k5_k7_price_gap"]);
    const pricePct = r["k5_k7_abs_ret_threshold"] != null ? `${fmt(r["k5_k7_abs_ret_threshold"])}%` : ((r["market"] === "OTC") ? "27%" : "25%");
    const k3v = Number(r["k3_day_volume_threshold_k"]);
    const k4v = Number(r["k4_turnover_volume_threshold_k"]);
    const hasK3 = Number.isFinite(k3v) && k3v > 0;
    const hasK4 = Number.isFinite(k4v) && k4v > 0;
    const hasK57 = Number.isFinite(k57p);
    if (hasK3 || hasK4 || hasK57) {
      const ids = [], vols = [], notes = [];
      if (hasK3)  { ids.push("③"); vols.push(`量③≥${fmt(k3v)}張`); }
      if (hasK4)  { ids.push("④"); vols.push(`量④≥${fmt(k4v)}張`); }
      if (hasK57) { ids.push("⑤", "⑦"); notes.push(`⑤ ${r["k5_note"] || "仍需考慮當日券商資料"}`); notes.push(`⑦ ${r["k7_note"] || "需考慮當日資券比"}`); }
      lines.push({ id: "k3457", label: `款${ids.join("")}`, price: hasK57 ? k57p : null, gap: hasK57 ? k57g : Infinity, vols, notes, baseDate: k1bd, basePrice: k1bp });
    }
    const k6p = Number(r["k6_min_price_to_trigger"]);
    if (Number.isFinite(k6p)) {
      const k6v = Number(r["k6_turnover_volume_threshold_k"]);
      const k6g = Number.isFinite(close) ? Math.abs(close - k6p) : Infinity;
      lines.push({ id: "k6", label: "款⑥", price: k6p, gap: k6g, vols: (Number.isFinite(k6v) && k6v > 0) ? [`量≥${fmt(k6v)}張`] : [], notes: ["週轉率≥5% AND 量≥門檻"], baseDate: null, basePrice: null });
    }
  }

  // market summary header: prev-day vol / turnover / 5-day cumulative
  const prevDate  = mmddShort(r["prev_close_date"]);
  const prevVol   = r["5_12成交量千股"]   != null ? `${fmt(r["5_12成交量千股"])}張` : "-";
  const prevTurn  = r["5_12週轉率"]       != null ? `${fmt(r["5_12週轉率"])}%` : "-";
  const ret5      = r["k1_prev5_return_pct"];
  const ret5Str   = ret5 != null ? `${ret5 >= 0 ? "+" : ""}${fmt(ret5)}%` : "-";
  const mktHeader = `<div class="ct-mkt-summary">前日(${prevDate}) 量 ${prevVol} ▪ 週轉 ${prevTurn} ▪ 5日累積 ${ret5Str}</div>`;

  const minGap = Math.min(...lines.map((l) => (Number.isFinite(l.gap) ? l.gap : Infinity)));
  const rowsHtml = lines.map((l) => {
    const isBold = Number.isFinite(l.gap) && l.gap === minGap;
    const priceCell = l.price != null
      ? `<span class="ct-price">${fmt(l.price)} ${priceMoveFromPrev(r, l.price)}</span>`
      : `<span class="ct-price">-</span>`;
    const volsHtml  = (l.vols  || []).map(v => `<span class="ct-vol">${v}</span>`).join("");
    const notesHtml = (l.notes || []).map(n => `<span class="ct-note">${n}</span>`).join("");
    const baseHtml  = (l.baseDate && l.basePrice != null)
      ? `<span class="ct-base">基準 ${mmddShort(l.baseDate)} 收 ${fmt(l.basePrice)}</span>`
      : "";
    return `<div class="ct-row${isBold ? " ct-bold" : ""}"><span class="ct-label">${l.label}</span>${priceCell}${baseHtml}${volsHtml}${notesHtml}</div>`;
  }).join("");
  return mktHeader + rowsHtml;
}

function pointCard(name, value, target, dates, r = null, onlyK1 = false) {
  const remain = Math.max(0, Number(target) - Number(value || 0));
  const cls = remain === 0 ? "hit" : remain === 1 ? "near" : "";
  const thresholds = r ? `<div class="clause-thresholds">${clauseThresholdLines(r, onlyK1)}</div>` : "";
  return `<details class="point-card ${cls}">
    <summary>
      <span>${name}</span>
      <b>${fmt(value)} / ${target}</b>
      <em>${remain === 0 ? "已達" : `差 ${remain}`}</em>
    </summary>
    <small>${dates || "-"}</small>
    ${thresholds}
  </details>`;
}

const ZH_NUM = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8 };
const CIRCLE = ["", "①","②","③","④","⑤","⑥","⑦","⑧"];
function parseClauses(s) {
  if (!s) return "";
  const nums = new Set();
  for (const [, zh] of s.matchAll(/第([一二三四五六七八])款/g)) nums.add(ZH_NUM[zh]);
  for (const [, n]  of s.matchAll(/第([1-8])款/g)) nums.add(Number(n));
  return [...nums].sort().map(n => CIRCLE[n] || n).join("");
}

function outcomeBadge(r) {
  const stats = r.actual_close != null
    ? `<span class="outcome-stats">${fmt(r.actual_close)}元　週轉${fmt(r.actual_turn)}%　量${fmt(r.actual_vol_k)}張</span>`
    : "";
  if (r.actual_punish) return `<span class="outcome-badge outcome-punish">⚡處置</span>${stats}`;
  if (r.actual_notice) {
    const clause = r.actual_clauses ? `<span class="outcome-clause">${parseClauses(r.actual_clauses)}</span>` : "";
    return `<span class="outcome-badge outcome-notice">⚡注意</span>${clause}${stats}`;
  }
  if (r.actual_close != null) return `<span class="outcome-badge outcome-safe">無觸發</span>${stats}`;
  return `<span class="outcome-badge outcome-none">-</span>`;
}

function applyPayload(p) {
  payload = p;
  rows = payload.rows || [];
  hasActuals = rows.some(r => r.actual_close != null);
  document.getElementById("generatedAt").textContent = `產生時間 ${payload.generated_at}`;
  document.getElementById("asOf").textContent = `注意資料至 ${payload.asof_notice}，評估 ${payload.eval_date}`;
  renderSummary();
  applyFilters();
  if (filtered[0]) {
    selectedCode = filtered[0]["證券代碼"];
    renderDetail(filtered[0]);
    renderRows();
  }
}

async function loadHistoryIndex() {
  let index;
  try {
    index = await fetch(`./history/index.json?v=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
  } catch { return; }
  const sel = document.getElementById("historySelect");
  if (!sel || !index?.dates?.length) return;
  index.dates.forEach(({ base_date, eval_date }) => {
    const bd = base_date;
    const bm = Number(bd.slice(4, 6)), bday = Number(bd.slice(6, 8));
    const [, em, ed] = eval_date.split("-");
    const opt = document.createElement("option");
    opt.value = bd;
    opt.textContent = `${bm}/${bday} 預測 → ${Number(em)}/${Number(ed)}`;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", async () => {
    const val = sel.value;
    let p;
    if (!val) {
      p = await fetch(`./attention_512_results.json?v=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
    } else {
      p = await fetch(`./history/${val}.json?v=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
    }
    applyPayload(p);
  });
}

async function boot() {
  let p = window.__ATTENTION_PAYLOAD__;
  if (!p) {
    p = await fetch(`./attention_512_results.json?v=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
  }
  applyPayload(p);
  await loadHistoryIndex();
}

document.getElementById("searchInput").addEventListener("input", applyFilters);
document.getElementById("riskFilter").addEventListener("change", applyFilters);

boot().catch((err) => {
  document.body.innerHTML = `<pre>${err.stack || err}</pre>`;
});
