let payload = null;
let rows = [];
let hasActuals = false;

// sort state per section: sectionKey => { key, dir }
const sortState = {};

// ─── utilities ──────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v) || v === "") return "-";
  if (typeof v === "number") return nf.format(v);
  return v;
}

function mmdd(isoDate) {
  if (!isoDate || isoDate === "-") return "-";
  const parts = isoDate.split("-");
  if (parts.length < 3) return isoDate;
  return `${Number(parts[1]).toString().padStart(2,"0")}-${Number(parts[2]).toString().padStart(2,"0")}`;
}

function nextBizDay(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate + "T00:00:00");
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  // Use local date components to avoid UTC offset shifting the date
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mktTag(r) {
  const isOtc = (r["market"] || "TWSE") === "OTC";
  return isOtc
    ? `<span class="mkt mkt-otc">櫃</span>`
    : `<span class="mkt mkt-twse">市</span>`;
}

function turnoverCell(r) {
  const vol    = Number(r["5_12成交量千股"]);       // 張
  const turn   = Number(r["5_12週轉率"]);            // %（已用實收資本重算）
  const issued = Number(r["5_12已發行股數千股"]);    // 張（實收資本/10，直接輸出）
  const date   = r["prev_close_date"]
    ? String(r["prev_close_date"]).slice(5).replace("-", "/")
    : "";
  if (!Number.isFinite(vol) || !Number.isFinite(turn) || turn <= 0)
    return `<span class="b-date">-</span>`;
  // 優先用直接輸出的已發行股數；舊版 JSON 無此欄則反推
  const shares = Number.isFinite(issued) && issued > 0
    ? issued
    : Math.round(vol * 100 / turn);
  const dateLabel = date ? `<span class="b-date" style="font-size:10px;display:block;margin-bottom:1px">${date}</span>` : "";
  return `<div style="font-size:12px;line-height:1.6;text-align:center">
    ${dateLabel}<span style="font-weight:600">${fmt(turn)}%</span><br>
    <span class="b-date" style="font-size:11px">${nf.format(vol)}張&thinsp;/&thinsp;${nf.format(shares)}張</span>
  </div>`;
}

// ─── badges ─────────────────────────────────────────────────────────────────

// Effective gap from current price to a threshold:
//   0  — "跌停仍觸" (threshold ≤ limit-down, ANY tomorrow's close triggers it)
//   0  — price already above threshold (k6 case, condition met)
//   otherwise — absolute distance from close to threshold
function thresholdGap(r, thresholdPrice, direction) {
  const price = Number(thresholdPrice);
  if (!Number.isFinite(price)) return Infinity;
  const prev  = Number(r["prev_close_for_eval"] ?? r["5_12收盤價"]);
  const close = Number(r["5_12收盤價"]);
  // already in zone: direction=down AND threshold > close → condition currently met
  if (direction === "down" && Number.isFinite(close) && close < price) return 0;
  if (direction === "down") {
    // DOWN trigger: stock needs to FALL to threshold.
    // "跌停仍觸" only when limit_down_price <= threshold (at limit down, price is still ≤ DOWN trigger).
    const lim = Number(r["limit_down_price"]) || (Number.isFinite(prev) && prev > 0 ? prev * 0.9 : NaN);
    if (Number.isFinite(lim) && lim <= price) return 0;
    // 不會達到: even at limit-down, price stays above threshold → deprioritise but preserve ordering
    return Number.isFinite(close) ? 1e9 + Math.abs(price - close) : Infinity;
  } else {
    // UP trigger (or undefined): threshold below current → at limit down (~-10%) still above threshold.
    if (Number.isFinite(prev) && prev > 0 && (price - prev) / prev * 100 <= -11) return 0;
    // 不會達到: threshold > 10% above current → can't reach at limit-up
    if (Number.isFinite(prev) && prev > 0 && (price - prev) / prev * 100 > 10)
      return Number.isFinite(close) ? 1e9 + Math.abs(price - close) : Infinity;
  }
  if (Number.isFinite(close) && close >= price) return 0;
  return Number.isFinite(close) ? Math.abs(price - close) : Infinity;
}

function priceBadge(r, target, direction) {
  const prev = Number(r["prev_close_for_eval"] ?? r["5_12收盤價"]);
  const price = Number(target);
  if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(price))
    return `<span class="b-pbadge b-pbadge-neutral">--</span>`;
  const pct = ((price - prev) / prev) * 100;
  if (direction === "down") {
    // DOWN trigger: stock must FALL to threshold.
    const lim = Number(r["limit_down_price"]) || prev * 0.9;
    if (Number.isFinite(lim) && lim <= price)
      return `<span class="b-pbadge b-pbadge-halt">⚠ 跌停仍觸</span>`;
    // limit_down > threshold → even at daily limit-down, k1 DOWN cannot trigger tomorrow
    return `<span class="b-pbadge b-pbadge-neutral">不會達到</span>`;
  } else {
    // UP trigger (or undefined): threshold ≤ 11% below current → limit down still above threshold.
    if (pct <= -11) return `<span class="b-pbadge b-pbadge-halt">⚠ 跌停仍觸</span>`;
    // threshold > 10% above current → can't reach even at daily limit-up
    if (pct > 10) return `<span class="b-pbadge b-pbadge-neutral">不會達到</span>`;
    // threshold is below prev (up-side already triggered): check if limit-down still keeps condition met
    if (pct < 0) {
      const lim = Number(r["limit_down_price"]) || prev * 0.9;
      if (Number.isFinite(lim) && lim >= price)
        return `<span class="b-pbadge b-pbadge-halt">⚠ 跌停仍觸</span>`;
    }
  }
  // already in zone: direction=down AND threshold > close → condition currently satisfied
  if (direction === "down" && pct > 0)
    return `<span class="b-pbadge b-pbadge-zone">≤${fmt(price)}元（+${fmt(pct)}%以下觸）</span>`;
  const sign = pct > 0 ? "+" : "";
  const dir = pct > 0 ? "↑" : "↓";
  const cls = pct > 0 ? "b-pbadge-up" : "b-pbadge-down";
  return `<span class="b-pbadge ${cls}">${fmt(price)}${dir}(${sign}${fmt(pct)}%)</span>`;
}

function isK1ReachableToday(r) {
  const k1p  = Number(r["k1_price_threshold"]);
  const prev = Number(r["prev_close_for_eval"] ?? r["5_12收盤價"]);
  if (!Number.isFinite(k1p) || !Number.isFinite(prev) || prev <= 0) return false;
  const pct  = (k1p - prev) / prev * 100;
  const dir  = r["k1_nearest_direction"];
  if (dir === "down") {
    const lim = Number(r["limit_down_price"]) || prev * 0.9;
    return Number.isFinite(lim) && lim <= k1p;
  } else {
    if (pct <= -11) return true;
    if (pct > 10)   return false;
    return true;
  }
}

function reasonChip(text) {
  if (!text || text === "-") return `<span class="b-chip b-chip-other">-</span>`;
  const t = String(text);
  if (/連[續]?[三3]|3個營業日|三個營業日/.test(t)) return `<span class="b-chip b-chip-3">連三</span>`;
  if (/連[續]?[五5]|5個營業日|五個營業日/.test(t)) return `<span class="b-chip b-chip-5">連五</span>`;
  if (/十個營業日|10個營業日|最近十|最近10/.test(t)) return `<span class="b-chip b-chip-10">10日中6日</span>`;
  if (/三十個|30個|30日|最近三十|最近30/.test(t)) return `<span class="b-chip b-chip-30">30日</span>`;
  const label = t.length > 12 ? t.slice(0, 12) + "…" : t;
  return `<span class="b-chip b-chip-other">${label}</span>`;
}

function minutesChip(text) {
  if (!text) return `<span class="b-chip b-chip-exit">-</span>`;
  if (text === "5分盤")  return `<span class="b-chip b-chip-5min">5分盤</span>`;
  if (text === "10分盤") return `<span class="b-chip b-chip-5min">10分盤</span>`;
  if (text === "20分盤") return `<span class="b-chip b-chip-20min">20分盤</span>`;
  if (text === "25分盤") return `<span class="b-chip b-chip-20min">25分盤</span>`;
  if (text === "45分盤") return `<span class="b-chip b-chip-20min" style="background:rgba(139,92,246,.25);color:#c4b5fd">45分盤</span>`;
  if (text === "60分盤") return `<span class="b-chip b-chip-20min" style="background:rgba(139,92,246,.35);color:#c4b5fd">60分盤</span>`;
  if (text === "90分盤") return `<span class="b-chip b-chip-20min" style="background:rgba(139,92,246,.5);color:#ddd6fe">90分盤</span>`;
  if (text === "已出關") return `<span class="b-chip b-chip-exit">已出關</span>`;
  return `<span class="b-chip b-chip-exit">${text}</span>`;
}

// ─── dot visualization ──────────────────────────────────────────────────────

// dates = "MM/DD,MM/DD,..." string from JSON; used to add title tooltips to earned dots
function dots(count, target, willAdd, sm = false, showToday = true, dates = "") {
  const cls = sm ? "dots dots-sm" : "dots";
  const dateArr = dates ? dates.split(",").map(s => s.trim()).filter(Boolean) : [];
  const evalMM = payload?.eval_date?.slice(5)?.replace("-", "/") || "";
  const d = [];
  for (let i = 0; i < target; i++) {
    if (i < count) {
      const t = dateArr[i] ? ` data-tip="${dateArr[i]}"` : "";
      d.push(`<span class="dot dot-earned"${t}></span>`);
    } else if (i === count && willAdd && showToday) {
      const t = evalMM ? ` data-tip="${evalMM}(估)" data-tip-today` : ` data-tip="今日(估)" data-tip-today`;
      d.push(`<span class="dot dot-today"${t}></span>`);
    } else {
      d.push(`<span class="dot dot-empty"></span>`);
    }
  }
  return `<div class="${cls}">${d.join("")}</div>`;
}

// ─── leading path helper ─────────────────────────────────────────────────────
// Returns which accumulation path is closest to triggering 2nd disposal,
// and whether 連3第1款 is the SOLE leading path (only 款① can trigger).

function getLeadingPath(r) {
  const c3   = Number(r["處置後連3第1款"]    ?? r["截至5_11連3第1款"] ?? 0);
  const c5   = Number(r["處置後連5第1到8款"] ?? r["截至5_11連5第1到8款"] ?? 0);
  const c10  = Number(r["處置後10日次數"]    ?? r["截至5_11_10日第1到8款次數"] ?? 0);
  const c30d = Number(r["處置後30日次數"]    ?? r["截至5_11_30日第1到8款次數"] ?? 0);
  const remK1   = Math.max(0, 3  - c3);
  const remK18a = Math.max(0, 5  - c5);
  const remK18b = Math.max(0, 6  - c10);
  const remK18c = Math.max(0, 12 - c30d);
  const remK18  = Math.min(remK18a, remK18b, remK18c);
  const minRem  = Math.min(remK1, remK18);
  // k1Only: 連3第1款 is sole minimum → only 款① can trigger the next disposal
  const k1Only  = remK1 === minRem && remK18 > minRem;
  return { remK1, remK18, minRem, k1Only };
}

// ─── threshold condition column ─────────────────────────────────────────────

function conditionCol(r) {
  const { k1Only } = getLeadingPath(r);
  const k1p = Number(r["k1_price_threshold"]);

  // If 連3第1款 is the sole leading path, only 款① can push this stock into disposal.
  // Showing a lower 款②/⑥ price would be misleading — those clauses don't help.
  // Exception: if k1 itself is 不會達到, fall through to show the next reachable clause instead.
  if (k1Only && Number.isFinite(k1p)) {
    const _k1gap = thresholdGap(r, k1p, r["k1_nearest_direction"]);
    if (_k1gap < 1e9)
      return `<div class="cond-row"><span class="cond-clause">①</span>${priceBadge(r, k1p, r["k1_nearest_direction"])}</div>`;
    // k1 不會達到 → fall through to candidates sort below
  }

  // Both paths can work → show the minimum-gap clause across ①②⑥.
  const k6v = Number(r["k6_turnover_volume_threshold_k"]);
  const k3v = Number(r["k3_day_volume_threshold_k"]);
  const k4v = Number(r["k4_turnover_volume_threshold_k"]);
  const k57p = Number(r["k5_k7_price_threshold"]);
  const candidates = [
    ["①",      r["k1_price_threshold"], [], r["k1_nearest_direction"]],
    ...(r["k2_exempt"] ? [] : [["②", r["k2_price_threshold"], []]]),
    ["⑥",      r["k6_min_price_to_trigger"],
                (Number.isFinite(k6v) && k6v > 0) ? [`量≥${fmt(k6v)}張`] : []],
    // Include ③④⑤⑦ only when their price threshold is calculable; show only easiest vol
    ...(Number.isFinite(k57p) ? [["③④⑤⑦", k57p, (() => {
        const has3 = Number.isFinite(k3v) && k3v > 0;
        const has4 = Number.isFinite(k4v) && k4v > 0;
        if (has3 && has4) return k4v <= k3v ? [`量④≥${fmt(k4v)}張`] : [`量③≥${fmt(k3v)}張`];
        if (has4) return [`量④≥${fmt(k4v)}張`];
        if (has3) return [`量③≥${fmt(k3v)}張`];
        return [];
      })()]] : []),
  ].map(([lbl, v, extras, dir]) => [lbl, Number(v), thresholdGap(r, v, dir), extras, dir])
   .filter(([, v]) => Number.isFinite(v));
  if (!candidates.length) return "-";
  candidates.sort((a, b) => {
    if (a[2] !== b[2]) return a[2] - b[2];
    // tie-break within 不會達到 group: ① goes last so other clauses with volume info win
    if (a[2] >= 1e9) {
      if (a[0] === "①" && b[0] !== "①") return 1;
      if (a[0] !== "①" && b[0] === "①") return -1;
    }
    return 0;
  });
  const [lbl, price, , extras, bestDir] = candidates[0];
  const extrasHtml = extras.map(e => `<span class="b-chip b-chip-3" style="font-size:10px;padding:1px 5px">${e}</span>`).join("");
  return `<div class="cond-row"><span class="cond-clause">${lbl}</span>${priceBadge(r, price, bestDir)}${extrasHtml}</div>`;
}

// ─── k1 market/industry diff sub-block ──────────────────────────────────────

function k1Detail(r, isBold) {
  const ret5    = r["k1_prev5_return_pct"];
  const mktAvg  = r["k1_mkt_avg"];
  const indAvg  = r["k1_ind_avg"];
  const mktDiff = r["k1_mkt_diff"];
  const indDiff = r["k1_ind_diff"];
  if (ret5 == null && mktAvg == null) return "";

  const pct  = v => v != null ? `${v >= 0 ? "+" : ""}${fmt(v)}%` : "-";
  const sign = v => v != null && v >= 0 ? "+" : "";

  // directional differential: (ret - avg) × sign(ret)
  const signRet = (ret5 != null && ret5 < 0) ? -1 : 1;
  const mktDirDiff = mktDiff != null ? mktDiff * signRet : null;
  const indDirDiff = indDiff != null ? indDiff * signRet : null;
  const mktOk  = mktDirDiff != null && mktDirDiff >= 20;
  const indOk  = indDirDiff != null && indDirDiff >= 20;

  const mktNote = mktAvg != null
    ? `<span class="b-k2-note">（大盤均${pct(mktAvg)}+20%=${fmt(mktAvg != null ? Math.round((mktAvg + (ret5 >= 0 ? 20 : -20)) * 100) / 100 : null)}%）</span>`
    : "";
  const indLabel = indAvg == null
    ? `同類差 無（產業資料不足，免計）`
    : `同類差 ${pct(indDiff)}${indDirDiff != null ? (indOk ? " ✓" : " ✗") : ""}`;

  return `<div class="b-k2-detail">
    <div class="b-k2-window ${isBold ? "b-k2-nearest" : ""}">
      <span class="b-k2-label">5日：</span>
      5日累積 ${pct(ret5)}
      ｜ 全體差 ${pct(mktDiff)}${mktDiff != null ? (mktOk ? " ✓" : " ✗") : ""}${mktNote}
      / ${indLabel}
    </div>
  </div>`;
}

// ─── k2 window detail sub-block ──────────────────────────────────────────────

function k2WindowsDetail(r, isK2Bold) {
  const windows = [
    { w: "30d", label: "30日", absThr: 100, diffThr: 85 },
    { w: "60d", label: "60日", absThr: 130, diffThr: 110 },
    { w: "90d", label: "90日", absThr: 160, diffThr: 135 },
  ];
  const validInd = r["k2_valid_ind"];
  const prevClose = Number(r["prev_close_for_eval"] ?? r["5_12收盤價"]);

  const rows = windows.map(({ w, label, absThr, diffThr }) => {
    const baseDate  = r[`k2_${w}_base_date`];
    const basePrice = r[`k2_${w}_base_price`];
    if (basePrice == null) return "";

    const mktAvg   = r[`k2_${w}_mkt_avg`];
    const indAvg   = r[`k2_${w}_ind_avg`];
    const basePriceNum = Number(basePrice);
    const curRet = (basePriceNum > 0 && Number.isFinite(prevClose) && prevClose > 0)
      ? Math.round((prevClose / basePriceNum - 1) * 10000) / 100
      : r[`k2_${w}_cur_ret`];
    const mktDiff  = (curRet != null && mktAvg != null) ? Math.round((curRet - mktAvg) * 100) / 100 : r[`k2_${w}_mkt_diff`];
    const indDiff  = (curRet != null && indAvg != null) ? Math.round((curRet - indAvg) * 100) / 100 : r[`k2_${w}_ind_diff`];
    const upPrice  = r[`k2_${w}_up_price`];
    const effUpRet = r[`k2_${w}_eff_up_ret`];
    const baseDateShort = baseDate ? String(baseDate).slice(5).replace("-", "/") : "-";
    const sign = v => (v != null && v >= 0) ? "+" : "";
    const pct  = v => v != null ? `${sign(v)}${fmt(v)}%` : "-";

    // 括號：「市場均 X% + 85% = Y%」
    const mktThr = mktAvg != null ? Math.round((mktAvg + diffThr) * 100) / 100 : null;
    const indThr = indAvg != null ? Math.round((indAvg + diffThr) * 100) / 100 : null;
    const mktNote = mktThr != null ? `<span class="b-k2-note">（市場均${pct(mktAvg)}+${diffThr}%=${mktThr}%）</span>` : "";
    const indNote = indThr != null ? `<span class="b-k2-note">（同類均${pct(indAvg)}+${diffThr}%=${indThr}%）</span>` : "";
    const indLabel = !validInd
      ? `同類差 無（產業資料不足，免計）`
      : `同類差 ${pct(indDiff)}${indNote}`;

    // 有效漲門檻：觸發價+需漲幅
    let thrStr = "-";
    if (upPrice != null && Number.isFinite(prevClose) && prevClose > 0) {
      const needPct = Math.round((upPrice / prevClose - 1) * 10000) / 100;
      const needSign = needPct >= 0 ? "+" : "";
      thrStr = `↑${fmt(upPrice)}元（開盤參考${needSign}${fmt(needPct)}%，需漲至${effUpRet}%）`;
    } else if (upPrice != null) {
      thrStr = `↑${fmt(upPrice)}元（需報酬${effUpRet}%）`;
    }

    return `<div class="b-k2-window ${isK2Bold ? "b-k2-nearest" : ""}">
      <span class="b-k2-label">${label}：</span>
      基準 ${baseDateShort} 收${fmt(basePrice)}，
      現報酬 ${pct(curRet)}（需&gt;${absThr}%）
      ｜ 全體差 ${pct(mktDiff)}${mktNote}
      / ${indLabel}
      ｜ ${thrStr}
    </div>`;
  }).join("");

  return `<div class="b-k2-detail">${rows}</div>`;
}

// ─── k6 PE/PB detail sub-block ───────────────────────────────────────────────

function k6Detail(r, isBold) {
  const close   = Number(r["prev_close_for_eval"] ?? r["5_12收盤價"]);
  const eps     = Number(r["eps_from_pe"]);
  const pbr     = Number(r["pbr_est_512"]);
  const bps     = Number(r["bps_from_pbr"]);

  const ok  = s => `<span class="k6-tag k6-ok">${s}</span>`;
  const no  = s => `<span class="k6-tag k6-no">${s}</span>`;
  const dim = s => `<span class="k6-dim">${s}</span>`;

  const rows = [];

  // ① PE condition
  const peReq  = Number(r["k6_pe_required_ratio"]);
  const peSafe = Number(r["k6_pe_threshold"]);
  const priceAtPeReq  = Number(r["k6_price_by_pe_threshold"]);
  const priceAtPeSafe = (Number.isFinite(peSafe) && Number.isFinite(eps) && eps > 0) ? Math.round(peSafe * eps) : null;
  const currentPE     = (Number.isFinite(close) && Number.isFinite(eps) && eps > 0) ? Math.round(close / eps * 100) / 100 : null;
  const peMet = r["k6_pe_negative"] || (currentPE != null && Number.isFinite(peReq) && currentPE >= peReq);
  if (r["k6_pe_negative"]) {
    rows.push(`<div class="k6-row">① PE 為負（EPS≤0，自動達標）${ok("已達標")}</div>`);
  } else if (Number.isFinite(peReq)) {
    const curPEstr = currentPE != null ? `PE ${fmt(currentPE)}` : "PE -";
    const epsStr   = Number.isFinite(eps) ? `EPS ${fmt(eps)}` : "";
    const safeStr  = priceAtPeSafe != null ? dim(`安全線 PE=${peSafe} → ${priceAtPeSafe}元`) : "";
    rows.push(`<div class="k6-row">
      ① ${curPEstr}（門檻≥${fmt(peReq)}）${dim(epsStr)}${peMet ? ok("已達標") : no("未達標")}
      <span class="k6-price-note">觸發價 ${Number.isFinite(priceAtPeReq) ? fmt(priceAtPeReq) : "-"}元 ${priceBadge(r, priceAtPeReq)}</span>
      ${safeStr}
    </div>`);
  }

  // ② PBR condition — show market-avg×2 sub-threshold
  const mktPbrThr    = Number(r["k6_mkt_pbr_threshold"]);     // 市場均×2
  const mktWavgPbr   = Number(r["k6_mkt_wavg_pbr"]);
  const priceAtMktPbr = Number(r["k6_price_by_mkt_pbr"]);
  const pbrMet = Number.isFinite(pbr) && Number.isFinite(mktPbrThr) && pbr >= mktPbrThr;
  if (Number.isFinite(mktPbrThr)) {
    const mktAvgStr = Number.isFinite(mktWavgPbr) ? dim(`全體均${Math.round(mktWavgPbr)}（${fmt(mktWavgPbr)}）`) : "";
    const bpsStr    = Number.isFinite(bps) ? dim(`淨值${fmt(bps)}`) : "";
    rows.push(`<div class="k6-row">
      ② PB ${Number.isFinite(pbr) ? fmt(pbr) : "-"} ${mktAvgStr} ${bpsStr} 門檻≥${fmt(mktPbrThr)}${pbrMet ? ok("已達標") : no("未達標")}
      <span class="k6-price-note">全均×2 ${Number.isFinite(priceAtMktPbr) ? fmt(priceAtMktPbr) : "-"}元 ${priceBadge(r, priceAtMktPbr)}</span>
    </div>`);
  }

  // ④ Additional: industry PBR × mult
  const indWavgPbr   = Number(r["k6_ind_wavg_pbr"]);
  const indPbrThr    = Number(r["k6_ind_pbr_threshold"]);
  const indMult      = Number(r["k6_ind_mult"]) || 2;
  const priceAtIndPbr = Number(r["k6_price_by_ind_pbr"]);
  const indPbrMet    = Number.isFinite(pbr) && Number.isFinite(indPbrThr) && pbr >= indPbrThr;
  if (Number.isFinite(indPbrThr)) {
    rows.push(`<div class="k6-row">
      ④ 附加（産業×${indMult}）産業均${Number.isFinite(indWavgPbr) ? `${Math.round(indWavgPbr)}（${fmt(indWavgPbr)}）` : "-"} 門檻 PB≥${fmt(indPbrThr)}${indPbrMet ? ok("已達標") : no("未達標")}
      <span class="k6-price-note">觸發價 ${Number.isFinite(priceAtIndPbr) ? fmt(priceAtIndPbr) : "-"}元 ${priceBadge(r, priceAtIndPbr)}</span>
      ${dim("單一（券商/投資人）占比條件需分點資料，無法預估")}
    </div>`);
  }

  // ③ Volume/turnover condition
  const volReq     = Number(r["k6_min_trade_volume_threshold_k"]);
  const turnVolReq = Number(r["k6_turnover_rate_volume_threshold_k"]);
  const vol512     = Number(r["5_12成交量千股"]);
  const turn512    = Number(r["5_12週轉率"]);
  const turnMet    = Number.isFinite(turn512) && turn512 >= 5;
  const volMet     = Number.isFinite(vol512) && Number.isFinite(volReq) && vol512 >= volReq;
  const prevDate   = r["prev_close_date"] ? String(r["prev_close_date"]).slice(5).replace("-", "/") : "";
  const prevLabel  = prevDate ? `前日(${prevDate}) ` : "";
  rows.push(`<div class="k6-row">
    ③ ${prevLabel}週轉率 ${Number.isFinite(turn512) ? fmt(turn512) : "-"}%（≥5%）${turnMet ? ok("達標") : no("未達")}
    量 ${Number.isFinite(vol512) ? fmt(vol512) : "-"}張（最低≥${Number.isFinite(volReq) ? fmt(volReq) : "-"}張、週轉量≥${Number.isFinite(turnVolReq) ? fmt(turnVolReq) : "-"}張）${volMet ? ok("達標") : no("未達")}
  </div>`);

  // Summary
  const k6min = Number(r["k6_min_price_to_trigger"]);
  const limitDown = r["k6_limit_down_still_triggers"];
  const summaryTag = limitDown ? ok("跌停仍觸") : "";
  rows.push(`<div class="k6-summary">
    最低觸發價 <b>${Number.isFinite(k6min) ? fmt(k6min) : "-"}元</b>（PE/PB條件取較嚴格者）${summaryTag}
  </div>`);

  return `<div class="b-k6-detail${isBold ? " b-k6-nearest" : ""}">${rows.join("")}</div>`;
}

// ─── clause threshold detail (for dot-row expand) ───────────────────────────

function clauseThresholdDetail(r) {
  const { k1Only } = getLeadingPath(r);
  const close  = Number(r["5_12收盤價"]);
  const k1bd   = r["k1_base_date"], k1bp = r["k1_base_price"];
  const lines  = [];

  // 款① k1
  const k1p = Number(r["k1_price_threshold"]);
  const k1dir = r["k1_nearest_direction"];
  if (Number.isFinite(k1p)) {
    lines.push({ label: "款①", price: k1p, gap: thresholdGap(r, k1p, k1dir), dir: k1dir, vols: [], notes: [], baseDate: k1bd, basePrice: k1bp, isK1: true });
  }

  // 款② k2
  const k2p = Number(r["k2_price_threshold"]);
  if (r["k2_exempt"]) {
    lines.push({ label: `款②（豁免中）`, price: null, gap: Infinity, vols: [], notes: [r["k2_exempt_reason"] || "第3條第三款豁免"], baseDate: null, basePrice: null, isK2: true, exempt: true });
  } else if (Number.isFinite(k2p)) {
    lines.push({ label: `款②${r["k2_nearest_window"] ? `(${r["k2_nearest_window"]})` : ""}`, price: k2p, gap: thresholdGap(r, k2p), vols: [], notes: [], baseDate: r["k2_nearest_base_date"], basePrice: r["k2_nearest_base_price"], isK2: true });
  }

  // 款③④⑤⑦ — 共用同一漲幅門檻，合併為一行
  const k57p = Number(r["k5_k7_price_threshold"]);
  const k3v  = Number(r["k3_day_volume_threshold_k"]);
  const k4v  = Number(r["k4_turnover_volume_threshold_k"]);
  const hasK3  = Number.isFinite(k3v) && k3v > 0;
  const hasK4  = Number.isFinite(k4v) && k4v > 0;
  const hasK57 = Number.isFinite(k57p);
  if (hasK3 || hasK4 || hasK57) {
    const ids = [], vols = [], notes = [];
    if (hasK3)  { ids.push("③"); vols.push(`量③≥${fmt(k3v)}張`); }
    if (hasK4)  { ids.push("④"); vols.push(`量④≥${fmt(k4v)}張`); }
    if (hasK57) {
      ids.push("⑤", "⑦");
      notes.push(`⑤ ${r["k5_note"] || "仍需考慮當日券商資料"}`);
      notes.push(`⑦ ${r["k7_note"] || "需考慮當日資券比"}`);
    }
    lines.push({ label: `款${ids.join("")}`, price: hasK57 ? k57p : null, gap: hasK57 ? thresholdGap(r, k57p) : Infinity, vols, notes, baseDate: k1bd, basePrice: k1bp });
  }

  // 款⑥ k6
  const k6p = Number(r["k6_min_price_to_trigger"]);
  if (Number.isFinite(k6p) && r["k6_threshold_computable"]) {
    const k6v = Number(r["k6_turnover_volume_threshold_k"]);
    lines.push({ label: "款⑥", price: k6p, gap: thresholdGap(r, k6p), vols: (Number.isFinite(k6v) && k6v > 0) ? [`量≥${fmt(k6v)}張`] : [], notes: [], baseDate: null, basePrice: null, isK6: true });
  }

  if (!lines.length) return "<span class='b-clause-note'>無可計算門檻</span>";

  // market summary header
  const prevDate  = r["prev_close_date"] ? String(r["prev_close_date"]).slice(5).replace("-", "/") : "-";
  const prevVol   = r["5_12成交量千股"]   != null ? `${fmt(r["5_12成交量千股"])}張` : "-";
  const prevTurn  = r["5_12週轉率"]       != null ? `${fmt(r["5_12週轉率"])}%` : "-";
  const ret5      = r["k1_prev5_return_pct"];
  const ret5Str   = ret5 != null ? `${ret5 >= 0 ? "+" : ""}${fmt(ret5)}%` : "-";
  const avg59Line = (hasK3 && Number.isFinite(k3v) && k3v > 0)
    ? `<div class="b-clause-mkt b-clause-mkt-sub">近59日均量 ${fmt(Math.round(k3v / 5))}張（原條文為近60日含當日，因此需考慮當日）</div>`
    : "";
  const mktLine   = `<div class="b-clause-mkt">前日(${prevDate}) 量 ${prevVol} ▪ 週轉 ${prevTurn}</div>${avg59Line}`;

  const minGap = Math.min(...lines.map(l => Number.isFinite(l.gap) ? l.gap : Infinity));
  const rowsHtml = lines.map(l => {
    const isBold = k1Only
      ? l.label === "款①"
      : (Number.isFinite(l.gap) && l.gap === minGap);
    const priceCell = l.price != null ? priceBadge(r, l.price, l.dir) : `<span class="b-date">-</span>`;
    const baseHtml  = (l.baseDate && l.basePrice != null)
      ? `<span class="b-clause-base">基準 ${String(l.baseDate).slice(5).replace("-","/")} 收 ${fmt(l.basePrice)}</span>`
      : "";
    const volsHtml  = l.vols.map(v  => `<span class="b-chip b-chip-vol">${v}</span>`).join("");
    const notesHtml = l.notes.map(n => `<span class="b-clause-note">${n}</span>`).join("");
    const subDetail = l.isK1 ? k1Detail(r, isBold) : l.isK2 ? k2WindowsDetail(r, isBold) : l.isK6 ? k6Detail(r, isBold) : "";
    return `<div class="b-clause-row${isBold ? " b-clause-bold" : ""}"><span class="b-clause-label">${l.label}</span>${priceCell}${volsHtml}${notesHtml}${baseHtml}</div>${subDetail}`;
  }).join("");
  return mktLine + rowsHtml;
}

// ─── near2 table column: most likely trigger clause + price ──────────────────

function near2CondCell(r) {
  const { k1Only } = getLeadingPath(r);
  const close = Number(r["5_12收盤價"]);
  if (k1Only) {
    const k1p = Number(r["k1_price_threshold"]);
    if (Number.isFinite(k1p)) {
      const _k1gap = thresholdGap(r, k1p, r["k1_nearest_direction"]);
      if (_k1gap < 1e9)
        return `<div class="cond-row"><span class="cond-clause">款①</span>${priceBadge(r, k1p, r["k1_nearest_direction"])}</div>`;
      // k1 不會達到 → fall through to candidates sort
    }
  }
  // All k1–k8 clauses eligible: show the one with smallest price gap
  const k57p = Number(r["k5_k7_price_threshold"]);
  const k6p  = Number(r["k6_min_price_to_trigger"]);
  const k1dir = r["k1_nearest_direction"];
  const candidates = [
    { label: "款①",    price: Number(r["k1_price_threshold"]),  gap: thresholdGap(r, r["k1_price_threshold"], k1dir), dir: k1dir },
    ...(r["k2_exempt"] ? [] : [{ label: "款②", price: Number(r["k2_price_threshold"]), gap: Number(r["k2_price_gap"]) }]),
    { label: "款③④⑤⑦", price: k57p, gap: Number(r["k5_k7_price_gap"]) },
    { label: "款⑥",    price: k6p,  gap: Number.isFinite(close) && Number.isFinite(k6p) ? Math.abs(close - k6p) : Infinity },
  ].filter(c => Number.isFinite(c.price) && Number.isFinite(c.gap));
  if (!candidates.length) return `<span class="b-date">-</span>`;
  candidates.sort((a, b) => a.gap - b.gap);
  const best = candidates[0];
  let volBadges = "";
  if (best.label === "款③④⑤⑦") {
    const k3v = Number(r["k3_day_volume_threshold_k"]);
    const k4v = Number(r["k4_turnover_volume_threshold_k"]);
    const has3 = Number.isFinite(k3v) && k3v > 0;
    const has4 = Number.isFinite(k4v) && k4v > 0;
    // 只顯示最容易達到（最小值）的量能門檻
    if (has3 && has4) {
      if (k4v <= k3v) volBadges = `<span class="b-chip b-chip-3" style="font-size:10px;padding:1px 5px;margin-left:4px">量④≥${fmt(k4v)}張</span>`;
      else            volBadges = `<span class="b-chip b-chip-3" style="font-size:10px;padding:1px 5px;margin-left:4px">量③≥${fmt(k3v)}張</span>`;
    } else if (has4) volBadges = `<span class="b-chip b-chip-3" style="font-size:10px;padding:1px 5px;margin-left:4px">量④≥${fmt(k4v)}張</span>`;
    else if (has3)   volBadges = `<span class="b-chip b-chip-3" style="font-size:10px;padding:1px 5px;margin-left:4px">量③≥${fmt(k3v)}張</span>`;
  }
  return `<div class="cond-row"><span class="cond-clause">${best.label}</span>${priceBadge(r, best.price, best.dir)}${volBadges}</div>`;
}

// ─── fastest disposal ────────────────────────────────────────────────────────

function fastestDisp(r) {
  const triggered = r["若評估日成為注意_觸發處置類別"];
  const order   = r["若5_12觸發_預估處置次數"];
  const minutes = r["若5_12觸發_預估分盤"];
  const remain  = Number(r["最接近類別尚差"]);

  // Already triggers on eval_date → disposal = next biz day
  if (triggered && order) {
    const dispDate = nextBizDay(payload.eval_date);
    const dateLabel = mmdd(dispDate);
    const orderShort = order.includes("第二次") ? "第2次" : "第1次";
    const minShort = minutes ? minutes.replace("分盤", "分") : "";
    const chipCls = minutes === "20分盤" ? "b-chip-20min" : "b-chip-5min";
    return `<span class="fastest"><span class="fastest-date">${dateLabel}</span><span class="b-chip ${chipCls}">${orderShort}${minShort}</span></span>`;
  }

  // 差 N 次：show the N-th next biz day from eval_date as earliest possible
  if (remain === 1) {
    const d = nextBizDay(payload.eval_date); // triggers today → disposal starts next biz day
    const isSecond = r["近30天內曾處置"] || String(r["若5_12觸發_預估處置次數"] || "").includes("第二次");
    const orderShort = isSecond ? "第2次" : "第1次";
    const minShort   = isSecond ? "20分" : "5分";
    const chipCls    = isSecond ? "b-chip-20min" : "b-chip-5min";
    return `<span class="fastest"><span class="fastest-date">${mmdd(d)}</span><span class="b-muted" style="font-size:10px;margin-left:3px">最快</span><span class="b-chip ${chipCls}" style="margin-left:5px">${orderShort}${minShort}</span></span>`;
  }

  if (remain === 2) {
    let d = payload.eval_date;
    d = nextBizDay(d); // 1st notice day
    d = nextBizDay(d); // disposal start
    const isSecond = r["近30天內曾處置"];
    const orderShort = isSecond ? "第2次" : "第1次";
    const minShort   = isSecond ? "20分" : "5分";
    const chipCls    = isSecond ? "b-chip-20min" : "b-chip-5min";
    return `<span class="fastest"><span class="fastest-date">${mmdd(d)}</span><span class="b-muted" style="font-size:10px;margin-left:3px">最快</span><span class="b-chip ${chipCls}" style="margin-left:5px">${orderShort}${minShort}</span></span>`;
  }

  return `<span class="b-date">-</span>`;
}

// ─── grouping ────────────────────────────────────────────────────────────────

function getGroups() {
  const allActive = rows.filter(r => r["處置中_5_12"] || r["已出關"]);
  // split active by proximity to 2nd disposal (uses 距第二次尚差 added in Python)
  const near2_1   = allActive.filter(r => r["距第二次尚差"] != null && Number(r["距第二次尚差"]) <= 1)
    .sort((a, b) => {
      // 今天k1能觸到的排前面；k1不可達的排後面
      const aK1 = isK1ReachableToday(a);
      const bK1 = isK1ReachableToday(b);
      if (aK1 === bK1) return 0;
      return aK1 ? -1 : 1;
    });
  const near2_2   = allActive.filter(r => r["距第二次尚差"] != null && Number(r["距第二次尚差"]) === 2);
  const active    = allActive.filter(r => !near2_1.includes(r) && !near2_2.includes(r));

  const diff1all = rows.filter(r => Number(r["最接近類別尚差"]) === 1 && !r["處置中_5_12"] && !r["已出關"]);
  // 20分盤: 近30天內曾被處置 (regardless of whether today's eval day triggers)
  const diff1_20 = diff1all.filter(r => r["近30天內曾處置"] || String(r["若5_12觸發_預估處置次數"] || "").includes("第二次"));
  const diff1_5  = diff1all.filter(r => !r["近30天內曾處置"] && !String(r["若5_12觸發_預估處置次數"] || "").includes("第二次"));
  const diff2    = rows.filter(r => Number(r["最接近類別尚差"]) === 2 && !r["處置中_5_12"] && !r["已出關"]);
  return { active, near2_1, near2_2, diff1_5, diff1_20, diff2 };
}

// ─── sorting ─────────────────────────────────────────────────────────────────

function sorted(arr, sk) {
  if (!sk?.key) return arr;
  return [...arr].sort((a, b) => {
    let av = a[sk.key], bv = b[sk.key];
    const aN = av == null || av === "" || av === "-";
    const bN = bv == null || bv === "" || bv === "-";
    if (aN && bN) return 0;
    if (aN) return 1;   // null always last
    if (bN) return -1;
    av = Number(av); bv = Number(bv);
    if (!isNaN(av) && !isNaN(bv)) return (av - bv) * sk.dir;
    av = a[sk.key]; bv = b[sk.key];
    return String(av).localeCompare(String(bv), "zh-Hant") * sk.dir;
  });
}

// ─── tables ──────────────────────────────────────────────────────────────────

function disposalTable(secKey, groupRows, isNear2 = false) {
  if (!groupRows.length) return `<div class="b-empty">目前無處置中或近期出關</div>`;
  const sk = sortState[secKey];
  const data = sorted(groupRows, sk);
  const thd = (key, label, align = "") => {
    const cls = sk?.key === key ? (sk.dir > 0 ? "sort-asc" : "sort-desc") : "";
    const st  = align ? ` style="text-align:${align}"` : "";
    return `<th data-sort="${key}" class="${cls}"${st}>${label}</th>`;
  };
  const COLS = (isNear2 ? 14 : 13) + (hasActuals ? 1 : 0);
  const actTh = hasActuals ? `<th>實際結果</th>` : "";
  const header = `<thead><tr>
    <th>所</th>
    ${thd("證券代碼","代號")}
    ${thd("證券名稱","名稱")}
    ${thd("市場產業","產業")}
    ${thd("5_12週轉率","前日週轉","center")}
    ${thd("5_12收盤價","收盤")}
    ${actTh}
    ${isNear2 ? `<th>最可能觸發</th>` : ""}
    ${thd("目前處置原因","處置原因")}
    ${thd("目前處置開始日","開始日")}
    ${thd("目前處置結束日","結束日")}
    ${thd("目前處置結束日","出關日")}
    ${thd("目前處置剩餘交易日","剩餘")}
    ${thd("目前處置分盤","分盤")}
    ${thd("近30天第二次處置次數","近30天2+")}
  </tr></thead>`;
  const body = data.map(r => {
    const code = r["證券代碼"];
    const endDate = r["目前處置結束日"];
    const exitIso = endDate ? nextBizDay(endDate) : null;
    const remainCell = r["已出關"]
      ? `<span class="b-chip b-chip-exit">已出關</span>`
      : (r["目前處置剩餘交易日"] != null ? `${r["目前處置剩餘交易日"]} 日` : "-");
    const cnt30 = r["近30天第二次處置次數"] || 0;
    const cnt30cell = cnt30 > 0
      ? `<span class="b-chip b-chip-20min" style="cursor:pointer">近30天 ${cnt30} 次 ▾</span>`
      : `<span class="b-date">-</span>`;
    const periods = r["近30天第二次處置區間"] || [];
    const periodHtml = periods.length
      ? periods.map(p => `<span class="period-tag">${mmdd(p.start)} ～ ${mmdd(p.end)}</span>`).join("")
      : `<span class="b-date">（無前次紀錄）</span>`;

    // attention re-trigger dots — for active disposals use post-disposal-start counts only
    // (pre-disposal days that caused the current disposal must not count toward the next one)
    const c3   = Number(r["處置後連3第1款"]    ?? r["截至5_11連3第1款"] ?? 0);
    const c5   = Number(r["處置後連5第1到8款"] ?? r["截至5_11連5第1到8款"] ?? 0);
    const c10  = Number(r["處置後10日次數"]    ?? r["截至5_11_10日第1到8款次數"] ?? 0);
    const c30d = Number(r["處置後30日次數"]    ?? r["截至5_11_30日第1到8款次數"] ?? 0);
    const addK1    = !!(r["處置後加評估日連3"])    || isK1ReachableToday(r);
    const addK1to8 = !!(r["處置後加評估日連5to8"]) || !!(r["5_12是否新增第1到8款"]);
    const forecast = r["若評估日成為注意_觸發處置類別"] || "";
    const remain   = Number(r["最接近類別尚差"] ?? 99);
    const alertHtml = forecast
      ? `<span class="b-chip b-chip-20min" style="margin-left:10px">⚠ ${forecast} 觸發！</span>`
      : remain <= 2 ? `<span class="b-chip b-chip-5" style="margin-left:10px">差 ${remain} 次</span>` : "";

    const dotRow = (label, count, target, willAdd, dates) => {
      const triggered = count >= target;
      const labelCls = triggered ? "dot-label triggered" : "dot-label";
      return `<div class="dot-track-row">
        <span class="${labelCls}">${label}</span>
        ${dots(count, target, willAdd, target >= 10, true, dates || "")}
        <span class="dot-count ${triggered ? "triggered" : ""}">${count}/${target}</span>
      </div>`;
    };

    const remain2nd = r["距第二次尚差"] != null ? Number(r["距第二次尚差"]) : null;
    const thresholdSection = (remain2nd != null && remain2nd <= 2)
      ? `<div class="detail-section">
            <span class="detail-label">⚠ 差 ${remain2nd} 次進第二次 — 各款觸發門檻：</span>
            <div class="b-clause-grid">${clauseThresholdDetail(r)}</div>
          </div>`
      : "";
    const nextDispOrder  = r["若5_12觸發_預估處置次數"] || "";
    const nextDispMin    = r["若5_12觸發_預估分盤"] || "";
    const nextDispStart  = r["評估日"] ? nextBizDay(r["評估日"]) : null;
    const nextDispSection = (remain2nd != null && remain2nd <= 1 && nextDispOrder)
      ? `<div class="detail-section">
            <span class="detail-label">🔴 若今日觸發 → 最快 ${nextDispStart ? mmdd(nextDispStart) : "?"} 起，${nextDispOrder}（${nextDispMin || "?"}）</span>
          </div>`
      : "";

    const detailRow = `<tr class="disp-detail" data-code="${code}" style="display:none">
      <td colspan="${COLS}" class="disp-detail-cell">
        <div class="detail-sections">
          <div class="detail-section">
            <span class="detail-label">前次第二次處置：</span>${periodHtml}
          </div>
          <div class="detail-section">
            <span class="detail-label">注意股再觸發追蹤${alertHtml}：</span>
            <div class="dot-track-grid">
              ${dotRow("連3①", c3, 3, addK1, r["處置後連3集點日期"])}
              ${dotRow("連5①", c5, 5, addK1to8, r["處置後連5集點日期"])}
              ${dotRow("10日/6①", c10, 6, addK1to8, r["處置後10日集點日期"])}
              ${dotRow("30日/12①", c30d, 12, addK1to8, r["處置後30日集點日期"])}
            </div>
          </div>
          ${thresholdSection}
          ${nextDispSection}
        </div>
      </td>
    </tr>`;
    const remain2ndVal = r["距第二次尚差"] != null ? Number(r["距第二次尚差"]) : null;
    const k1OnlyRisk = remain2ndVal === 1 && !isK1ReachableToday(r);  // 差1次但k1今天不可達
    const rowWarnStyle = (isNear2 && remain2ndVal != null && remain2ndVal <= 1)
      ? k1OnlyRisk
        ? ` style="background:rgba(100,100,100,0.08);opacity:0.6"`
        : ` style="background:rgba(251,191,36,0.06)"`
      : "";
    const nextDispLine = (remain2ndVal != null && remain2ndVal <= 1 && nextDispOrder)
      ? k1OnlyRisk
        ? `<div style="font-size:10px;color:#6b7280;margin-top:3px">⚠ 第一款今日不可達，連三不進展（若未來觸第一款 → 最快 ${nextDispStart ? mmdd(nextDispStart) : "?"} 起，${nextDispMin || nextDispOrder}）</div>`
        : `<div style="font-size:10px;color:#f87171;margin-top:3px">🔴 若今日觸發 → 最快 ${nextDispStart ? mmdd(nextDispStart) : "?"} 起，${nextDispMin || nextDispOrder}</div>`
      : "";
    const near2Cell = isNear2 ? `<td>${near2CondCell(r)}${nextDispLine}</td>` : "";
    const dispOutcomeClass = r.actual_punish ? " row-punish" : r.actual_notice ? " row-notice" : "";
    const actCell = hasActuals ? `<td>${outcomeBadge(r)}</td>` : "";
    return `<tr class="disp-row${dispOutcomeClass}"${rowWarnStyle} data-code="${code}">
      <td>${mktTag(r)}</td>
      <td class="b-code">${code}</td>
      <td>${r["證券名稱"]}${r["出關期間預估k1"] ? `<span title="出關期間預估觸發第1款注意，出關後連三風險極高" style="margin-left:4px;cursor:help">❗</span>` : ""}</td>
      <td class="b-date" style="font-size:11px">${r["市場產業"] || r["TSE產業"] || "-"}</td>
      <td>${turnoverCell(r)}</td>
      <td>${fmt(r["5_12收盤價"])}</td>
      ${actCell}
      ${near2Cell}
      <td>${reasonChip(r["目前處置原因"])}</td>
      <td class="b-date">${mmdd(r["目前處置開始日"])}</td>
      <td class="b-date">${mmdd(r["目前處置結束日"])}</td>
      <td class="b-date">${mmdd(exitIso)}</td>
      <td>${remainCell}</td>
      <td>${minutesChip(r["目前處置分盤"])}</td>
      <td>${cnt30cell}</td>
    </tr>${detailRow}`;
  }).join("");
  return `<div class="b-table-scroll" data-sec="${secKey}">
    <table class="bt">${header}<tbody>${body}</tbody></table>
  </div>`;
}

function dotTable(secKey, groupRows) {
  if (!groupRows.length) return `<div class="b-empty">無符合條件股票</div>`;
  const sk = sortState[secKey];
  const data = sorted(groupRows, sk);
  const evalMM = payload?.eval_date?.slice(5)?.replace("-", "/") || "評估日";
  const DOT_COLS = 12 + (hasActuals ? 1 : 0);
  const thd = (key, label, align = "") => {
    const cls = sk?.key === key ? (sk.dir > 0 ? "sort-asc" : "sort-desc") : "";
    const st  = align ? ` style="text-align:${align}"` : "";
    return `<th data-sort="${key}" class="${cls}"${st}>${label}</th>`;
  };
  const actTh = hasActuals ? `<th>實際結果</th>` : "";
  const header = `<thead><tr>
    <th>所</th>
    ${thd("證券代碼","代號")}
    ${thd("證券名稱","名稱")}
    ${thd("市場產業","產業")}
    ${thd("5_12週轉率","前日週轉","center")}
    ${thd("5_12收盤價","收盤")}
    ${actTh}
    <th>${evalMM} 最低門檻</th>
    <th>最快處置</th>
    ${thd("截至5_11連3第1款","連3①")}
    ${thd("截至5_11連5第1到8款","連5①")}
    ${thd("截至5_11_10日第1到8款次數","10日/6①")}
    ${thd("截至5_11_30日第1到8款次數","30日/12①")}
  </tr></thead>`;
  const body = data.map(r => {
    const code = r["證券代碼"];
    const c3  = Number(r["截至5_11連3第1款"] ?? 0);
    const c5  = Number(r["截至5_11連5第1到8款"] ?? 0);
    const c10 = Number(r["截至5_11_10日第1到8款次數"] ?? 0);
    const c30 = Number(r["截至5_11_30日第1到8款次數"] ?? 0);
    const addK1    = !!r["5_12是否新增第1款"];
    const addK1to8 = !!r["5_12是否新增第1到8款"];
    const closest  = r["最接近類別"] || "";
    const isC3  = closest === "連3第1款";
    const isC5  = closest === "連5第1-8款";
    const isC10 = closest === "10日6次";
    const isC30 = closest === "30日12次";
    const detailRow = `<tr class="dot-detail" data-code="${code}" style="display:none">
      <td colspan="${DOT_COLS}" class="dot-detail-cell">
        <div class="b-clause-title">各款項最低觸發門檻（點擊收起）</div>
        <div class="b-clause-grid">${clauseThresholdDetail(r)}</div>
      </td>
    </tr>`;
    const outcomeClass = r.actual_punish ? " row-punish" : r.actual_notice ? " row-notice" : "";
    const actCell = hasActuals ? `<td>${outcomeBadge(r)}</td>` : "";
    return `<tr class="dot-row${outcomeClass}" data-code="${code}">
      <td>${mktTag(r)}</td>
      <td class="b-code">${code}</td>
      <td>${r["證券名稱"]}</td>
      <td class="b-date">${r["TSE產業"] || r["市場產業"] || "-"}</td>
      <td>${turnoverCell(r)}</td>
      <td>${fmt(r["5_12收盤價"])}</td>
      ${actCell}
      <td>${conditionCol(r)}</td>
      <td>${fastestDisp(r)}</td>
      <td>${dots(c3,  3,  addK1,    false, isC3,  r["連3第1款集點日期"]  || "")}</td>
      <td>${dots(c5,  5,  addK1to8, false, isC5,  r["連5第1到8款集點日期"] || "")}</td>
      <td>${dots(c10, 6,  addK1to8, false, isC10, r["10日6次集點日期"]  || "")}</td>
      <td>${dots(c30, 12, addK1to8, true,  isC30, r["30日12次集點日期"] || "")}</td>
    </tr>${detailRow}`;
  }).join("");
  return `<div class="b-table-scroll" data-sec="${secKey}">
    <table class="bt">${header}<tbody>${body}</tbody></table>
  </div>`;
}

function section(secKey, title, count, content, variant, note = "") {
  return `<section class="b-section" id="sec-${secKey}">
    <div class="b-section-header ${variant}">
      <span class="b-sdot"></span>
      <span class="b-stitle">${title}</span>
      <span class="b-scount">${count} 檔</span>
      ${note ? `<span style="font-size:11px;color:#9ca3af;margin-left:12px;font-weight:normal">${note}</span>` : ""}
    </div>
    <div class="b-table-wrap">${content}</div>
  </section>`;
}

// ─── render ──────────────────────────────────────────────────────────────────

function render() {
  const { active, near2_1, near2_2, diff1_5, diff1_20, diff2 } = getGroups();
  document.getElementById("boardContent").innerHTML = [
    section("d1_5",    "差一次被處置 ▸ 第一次 5分盤",         diff1_5.length,  dotTable("d1_5",  diff1_5),  "first"),
    section("d1_20",   "差一次被處置 ▸ 第二次以上 20分盤",     diff1_20.length, dotTable("d1_20", diff1_20), ""),
    section("d2",      "差兩次被處置",                        diff2.length,    dotTable("d2",    diff2),    "far"),
    section("near2_1", "處置中／已出關 ▸ 差一次進第二次處置",   near2_1.length,  disposalTable("near2_1", near2_1, true), "disposal", near2_1.some(r=>r["出關期間預估k1"]) ? "❗ = 出關三天內預估觸發第1款，連三再處置風險極高" : ""),
    section("near2_2", "處置中／已出關 ▸ 差兩次進第二次處置",   near2_2.length,  disposalTable("near2_2", near2_2, true), "disposal", near2_2.some(r=>r["出關期間預估k1"]) ? "❗ = 出關三天內預估觸發第1款，連三再處置風險極高" : ""),
    section("active",  "正在處置 / 近期出關",                  active.length,   disposalTable("active",  active),  "disposal"),
  ].join("");

  // attach sort listeners and disposal detail toggle
  document.querySelectorAll(".b-table-scroll[data-sec]").forEach(wrap => {
    const secKey = wrap.dataset.sec;
    wrap.querySelectorAll("th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        const cur = sortState[secKey];
        if (cur?.key === key) sortState[secKey] = { key, dir: cur.dir * -1 };
        else sortState[secKey] = { key, dir: 1 };
        render();
      });
    });
    // toggle detail row on disposal row click
    wrap.querySelectorAll("tr.disp-row").forEach(tr => {
      tr.addEventListener("click", () => {
        const detail = wrap.querySelector(`tr.disp-detail[data-code="${tr.dataset.code}"]`);
        if (detail) detail.style.display = detail.style.display === "none" ? "" : "none";
        updateStickyState(wrap);
      });
    });
    // toggle clause threshold detail on dot row click
    wrap.querySelectorAll("tr.dot-row").forEach(tr => {
      tr.addEventListener("click", () => {
        const detail = wrap.querySelector(`tr.dot-detail[data-code="${tr.dataset.code}"]`);
        if (detail) detail.style.display = detail.style.display === "none" ? "" : "none";
        updateStickyState(wrap);
      });
    });
  });

  applyStickyColumns(3);
}

// ─── outcome badge ────────────────────────────────────────────────────────────

const ZH_NUM = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8 };
const ZH_NUM_EXT = { 九:9, 十:10, 十一:11, 十二:12, 十三:13 };
const CIRCLE = ["", "①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩","⑪","⑫","⑬"];
function parseClauses(s) {
  if (!s) return "";
  const nums = new Set();
  for (const [, zh] of s.matchAll(/第([一二三四五六七八])款/g)) nums.add(ZH_NUM[zh]);
  for (const [, n]  of s.matchAll(/第([1-8])款/g)) nums.add(Number(n));
  return [...nums].sort().map(n => CIRCLE[n] || n).join("");
}
function parseClauses913(s) {
  if (!s) return "";
  const nums = new Set();
  for (const [, zh] of s.matchAll(/第(十[一二三]|九|十)款/g)) {
    const n = ZH_NUM_EXT[zh]; if (n) nums.add(n);
  }
  for (const [, n] of s.matchAll(/第(9|10|11|12|13)款/g)) nums.add(Number(n));
  return [...nums].sort().map(n => CIRCLE[n] || n).join("");
}

function outcomeBadge(r) {
  const stats = r.actual_close != null
    ? `<span class="outcome-stats">${fmt(r.actual_close)}元　週轉${fmt(r.actual_turn)}%　量${fmt(r.actual_vol_k)}張</span>`
    : "";
  if (r.actual_punish) return `<span class="outcome-badge outcome-punish">⚡處置</span>${stats}`;
  if (r.actual_notice) {
    const clause18  = r.actual_clauses ? parseClauses(r.actual_clauses)    : "";
    const clause913 = r.actual_clauses ? parseClauses913(r.actual_clauses) : "";
    const c18html  = clause18  ? `<span class="outcome-clause">${clause18}</span>`       : "";
    const c913html = clause913 ? `<span class="outcome-clause-muted">${clause913}</span>` : "";
    return `<span class="outcome-badge outcome-notice">⚡注意</span>${c18html}${c913html}${stats}`;
  }
  if (r.actual_close != null) return `<span class="outcome-badge outcome-safe">無觸發</span>${stats}`;
  return `<span class="outcome-badge outcome-none">-</span>`;
}

// ─── boot ────────────────────────────────────────────────────────────────────

function applyPayload(p) {
  payload = p;
  rows = payload.rows || [];
  hasActuals = rows.some(r => r.actual_close != null);
  document.getElementById("generatedAt").textContent = `產生時間 ${payload.generated_at}`;
  document.getElementById("asOf").textContent = `注意資料至 ${payload.asof_notice}，評估 ${payload.eval_date}`;
  // default sort for disposal sections: fewest remaining days first (already-exited = Infinity)
  ["near2_1", "near2_2", "active"].forEach(sec => {
    sortState[sec] = { key: "目前處置剩餘交易日", dir: 1 };
  });
  render();
}

async function loadHistoryIndex() {
  let index;
  try {
    index = await fetch(`./history/index.json?v=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
  } catch { return; }
  const sel = document.getElementById("historySelect");
  if (!sel || !index?.dates?.length) return;
  index.dates.forEach(({ base_date, eval_date }) => {
    const bm = Number(base_date.slice(4, 6)), bday = Number(base_date.slice(6, 8));
    const [, em, ed] = eval_date.split("-");
    const opt = document.createElement("option");
    opt.value = base_date;
    opt.textContent = `${bm}/${bday} 預測 → ${Number(em)}/${Number(ed)}`;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", async () => {
    const val = sel.value;
    const url = val
      ? `./history/${val}.json?v=${Date.now()}`
      : `./attention_512_results.json?v=${Date.now()}`;
    const p = await fetch(url, { cache: "no-store" }).then(r => r.json());
    applyPayload(p);
  });
}

async function boot() {
  let p = window.__ATTENTION_PAYLOAD__;
  if (!p) {
    p = await fetch(`./attention_512_results.json?v=${Date.now()}`, { cache: "no-store" }).then(r => r.json());
  }
  applyPayload(p);
  initSearch();
  await loadHistoryIndex();
}

boot().catch(err => {
  document.body.innerHTML = `<pre style="color:#f87171;padding:32px;background:#12151e">${err.stack || err}</pre>`;
});

// ─── search ──────────────────────────────────────────────────────────────────

function groupLabel(r) {
  const { active, near2_1, near2_2, diff1_5, diff1_20, diff2 } = getGroups();
  if (near2_1.includes(r))  return "處置中 ▸ 差一次進第二次";
  if (near2_2.includes(r))  return "處置中 ▸ 差兩次進第二次";
  if (active.includes(r))   return "正在處置 / 近期出關";
  if (diff1_20.includes(r)) return "差一次 ▸ 第二次以上 20分盤";
  if (diff1_5.includes(r))  return "差一次 ▸ 第一次 5分盤";
  if (diff2.includes(r))    return "差兩次被處置";
  return "其他注意股";
}

function renderSearchResult(r) {
  const panel = document.getElementById("searchResult");
  if (!r) { panel.style.display = "none"; return; }

  const code    = r["證券代碼"] || "-";
  const name    = r["證券名稱"] || "-";
  const grp     = groupLabel(r);
  const close   = r["5_12收盤價"] != null ? fmt(r["5_12收盤價"]) : "-";
  const ind     = r["TSE產業"] || r["市場產業"] || "-";
  const fastest = fastestDisp(r);
  const cond    = conditionCol(r);

  // determine which detail to show
  const isDisposal = r["處置中_5_12"] || r["已出關"];
  let detailHtml = "";
  if (isDisposal) {
    // disposal detail
    const c3   = Number(r["處置後連3第1款"]    ?? r["截至5_11連3第1款"] ?? 0);
    const c5   = Number(r["處置後連5第1到8款"] ?? r["截至5_11連5第1到8款"] ?? 0);
    const c10  = Number(r["處置後10日次數"]    ?? r["截至5_11_10日第1到8款次數"] ?? 0);
    const c30d = Number(r["處置後30日次數"]    ?? r["截至5_11_30日第1到8款次數"] ?? 0);
    const addK1    = !!r["處置後加評估日連3"];
    const addK1to8 = !!r["處置後加評估日連5to8"];
    const dotRowHtml = (label, count, target, willAdd, dates) => `
      <div class="dot-track-row">
        <span class="dot-label ${count>=target?"triggered":""}">${label}</span>
        ${dots(count, target, willAdd, target >= 10, true, dates || "")}
        <span class="dot-count ${count>=target?"triggered":""}">${count}/${target}</span>
      </div>`;
    detailHtml = `
      <div class="dot-track-grid" style="margin-top:8px">
        ${dotRowHtml("連3①",    c3,   3,  addK1,    r["處置後連3集點日期"])}
        ${dotRowHtml("連5①",    c5,   5,  addK1to8, r["處置後連5集點日期"])}
        ${dotRowHtml("10日/6①", c10,  6,  addK1to8, r["處置後10日集點日期"])}
        ${dotRowHtml("30日/12①",c30d, 12, addK1to8, r["處置後30日集點日期"])}
      </div>`;
  } else {
    // clause threshold detail
    detailHtml = `<div class="sr-detail-wrap"><div class="b-clause-grid" style="margin-top:8px">${clauseThresholdDetail(r)}</div></div>`;
  }

  const dispInfo = isDisposal ? `
    <span><span class="sr-label">分盤</span>${minutesBadge(r["目前處置分盤"])}</span>
    <span><span class="sr-label">處置期間</span><span class="b-date">${mmdd(r["目前處置開始日"])} ~ ${mmdd(r["目前處置結束日"])}</span></span>
    <span><span class="sr-label">剩餘交易日</span>${r["目前處置剩餘交易日"] ?? "-"}</span>` : `
    <span><span class="sr-label">最快處置</span>${fastest}</span>`;

  panel.innerHTML = `
    <div class="sr-header">
      ${mktTag(r)}
      <span class="sr-code">${code}</span>
      <span class="sr-name">${name}</span>
      <span class="b-date" style="font-size:12px">${ind}</span>
      <span class="sr-group">📍 ${grp}</span>
    </div>
    <div class="sr-body">
      <div class="sr-row-info">
        <span><span class="sr-label">收盤</span><b style="font-size:16px">${close}</b></span>
        <span><span class="sr-label">最低門檻</span>${cond}</span>
        ${dispInfo}
      </div>
      ${detailHtml}
    </div>`;
  panel.style.display = "";
}

function initSearch() {
  const input = document.getElementById("boardSearch");
  if (!input) return;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q) { renderSearchResult(null); return; }
    const hit = rows.find(r =>
      String(r["證券代碼"] || "").startsWith(q) ||
      String(r["證券名稱"] || "").includes(q)
    );
    renderSearchResult(hit || null);
    if (!hit) {
      const panel = document.getElementById("searchResult");
      panel.innerHTML = `<div class="b-empty" style="padding:20px">找不到「${q}」</div>`;
      panel.style.display = "";
    }
  });

  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { input.value = ""; renderSearchResult(null); }
  });
}

// ─── sticky columns ──────────────────────────────────────────────────────────

// Called after each detail row toggle — add/remove no-sticky based on open rows
function updateStickyState(wrap) {
  const table = wrap.querySelector("table.bt");
  if (!table) return;
  const hasOpen = wrap.querySelector("tr.disp-detail:not([style*='none']), tr.dot-detail:not([style*='none'])");
  table.classList.toggle("no-sticky", !!hasOpen);
}

// Freezes the first N columns of every .bt table by measuring actual widths
// after layout and applying position:sticky + left offset.
function applyStickyColumns(n = 3) {
  requestAnimationFrame(() => {
    document.querySelectorAll(".b-table-scroll table.bt").forEach(table => {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (!rows.length) return;
      const headerRow = rows.find(r => r.querySelector("th"));
      if (!headerRow) return;
      const headerCells = Array.from(headerRow.querySelectorAll("th")).slice(0, n);
      const lefts = [];
      let acc = 0;
      headerCells.forEach(th => { lefts.push(acc); acc += th.offsetWidth; });
      rows.forEach(row => {
        Array.from(row.querySelectorAll("th, td")).slice(0, n).forEach((cell, i) => {
          cell.classList.add("s-col");
          cell.style.left = lefts[i] + "px";
        });
      });
    });
  });
}

// ─── custom dot tooltip ───────────────────────────────────────────────────────
(function () {
  const tip = document.createElement("div");
  tip.id = "dot-tip";
  document.body.appendChild(tip);

  document.addEventListener("mouseover", e => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    tip.textContent = el.dataset.tip;
    tip.className = "today" in el.dataset ? "today" : "";
    tip.style.opacity = "1";
  });

  document.addEventListener("mousemove", e => {
    if (tip.style.opacity === "0") return;
    tip.style.left = (e.clientX + 12) + "px";
    tip.style.top  = (e.clientY - 28) + "px";
  });

  document.addEventListener("mouseout", e => {
    if (!e.target.closest("[data-tip]")) return;
    tip.style.opacity = "0";
  });
})();
