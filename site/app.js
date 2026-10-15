const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const periods = [
  { k: "today", l: "今日" },
  { k: "yesterday", l: "昨日" },
  { k: "7d", l: "近7天" },
  { k: "30d", l: "近30天" },
  { k: "month", l: "本月" },
  { k: "lastMonth", l: "上月" },
  { k: "all", l: "累计" },
];
const metricNames = { orders: "订单", gmv: "成交", commission: "佣金" };
const periodNames = Object.fromEntries(periods.map((period) => [period.k, period.l]));
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("zh-CN");
let state = {
  data: null,
  password: "",
  period: "7d",
  metric: "orders",
  selectedChannels: new Set(),
  selectedPromotions: new Set(),
  trendChannel: "all",
  rankingDimension: "channel",
  query: "",
  sort: "stat_date",
  desc: true,
};

const b64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const iso = (date) => date.toISOString().slice(0, 10);
const parseDate = (value) => new Date(`${value}T00:00:00Z`);
const addDays = (value, days) => {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
};
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
}[character]));
const normalizeData = (data) => ({ ...data, promotions: data.promotions || [], promotionRows: data.promotionRows || [] });
const formatMetric = (value, metric = state.metric) => {
  if (value == null) return "暂无记录";
  return metric === "orders" ? `${num.format(value)} 单` : money.format(value);
};

function sourceTotal(total = {}) {
  return {
    orders: Number(total.valid_num),
    commission: Number(total.estimate_valid_amount),
    gmv: Number(total.valid_amount),
    orders30d: Number(total.days_valid_num),
    commission30d: Number(total.days_estimate_valid_amount),
    gmv30d: Number(total.days_valid_amount),
  };
}

async function fetchUpstream(kind, item, accountId, fetchedAt) {
  const endpoint = new URL("https://alliance.yunzhanxinxi.com/promotion/statistics");
  endpoint.searchParams.set("accountsid", accountId);
  endpoint.searchParams.set(kind === "channel" ? "channelid" : "promotionid", item.id);
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 200 || !payload?.data) throw new Error(`source code ${payload?.code ?? "unknown"}`);
    const sourceRows = Array.isArray(payload.data.statistics_list) ? payload.data.statistics_list : [];
    const updatedItem = {
      ...item,
      status: "ok",
      error: null,
      total: sourceTotal(payload.data.statistics_total),
      sourceRowCount: sourceRows.length,
    };
    const rows = sourceRows.map((row) => kind === "channel" ? {
      channel_id: item.id,
      channel_name: item.name,
      stat_date: row.statistics_date,
      orders: Number(row.valid_num),
      commission: Number(row.estimate_valid_amount),
      gmv: Number(row.valid_amount),
      observed_at: fetchedAt,
    } : {
      promotion_id: item.id,
      promotion_name: item.name,
      channel_name: item.channelName,
      stat_date: row.statistics_date,
      orders: Number(row.valid_num),
      commission: Number(row.estimate_valid_amount),
      gmv: Number(row.valid_amount),
      observed_at: fetchedAt,
    });
    return { ok: true, item: updatedItem, rows };
  } catch (error) {
    return { ok: false, item, rows: [], error: error instanceof Error ? error.message : "unknown" };
  }
}

async function fetchInBatches(kind, items, accountId, fetchedAt, batchSize) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.all(items.slice(index, index + batchSize).map((item) => fetchUpstream(kind, item, accountId, fetchedAt))));
  }
  return results;
}

function mergeHistory(previousRows, incomingRows, keyFor) {
  const rowsByKey = new Map(previousRows.map((row) => [keyFor(row), row]));
  for (const row of incomingRows) rowsByKey.set(keyFor(row), row);
  return [...rowsByKey.values()].sort((left, right) => left.stat_date.localeCompare(right.stat_date));
}

async function fetchLiveData(data) {
  if (!data.accountId) throw new Error("当前数据版本不支持浏览器实时刷新");
  const fetchedAt = new Date().toISOString();
  const channelResults = await fetchInBatches("channel", data.channels, data.accountId, fetchedAt, 3);
  const promotionResults = await fetchInBatches("promotion", data.promotions, data.accountId, fetchedAt, 6);
  const successfulChannels = channelResults.filter((result) => result.ok);
  if (!successfulChannels.length) throw new Error("实时数据源暂时不可用");
  const channelById = new Map(channelResults.filter((result) => result.ok).map((result) => [result.item.id, result.item]));
  const promotionById = new Map(promotionResults.filter((result) => result.ok).map((result) => [result.item.id, result.item]));
  const rows = mergeHistory(data.rows, successfulChannels.flatMap((result) => result.rows), (row) => `${row.channel_id}:${row.stat_date}`);
  const promotionRows = mergeHistory(data.promotionRows, promotionResults.filter((result) => result.ok).flatMap((result) => result.rows), (row) => `${row.promotion_id}:${row.stat_date}`);
  return normalizeData({
    ...data,
    fetchedAt,
    rows,
    promotionRows,
    channels: data.channels.map((channel) => channelById.get(channel.id) || channel),
    promotions: data.promotions.map((promotion) => promotionById.get(promotion.id) || promotion),
    liveSource: true,
    liveFailures: channelResults.filter((result) => !result.ok).length + promotionResults.filter((result) => !result.ok).length,
  });
}

async function decryptEnvelope(envelope, password) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(envelope.salt), iterations: envelope.iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(envelope.iv) }, key, b64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(clear));
}

async function fetchData(password) {
  if (window.__DASHBOARD_ENVELOPE__) return decryptEnvelope(window.__DASHBOARD_ENVELOPE__, password);
  const response = await fetch(`./data.enc.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("数据文件尚未生成");
  return decryptEnvelope(await response.json(), password);
}

async function login(event) {
  event.preventDefault();
  const error = $("#login-error");
  error.hidden = true;
  const password = $("#password").value;
  try {
    state.data = normalizeData(await fetchData(password));
    state.password = password;
    state.selectedChannels = new Set(state.data.channels.map((channel) => channel.id));
    state.selectedPromotions = new Set(state.data.promotions.map((promotion) => promotion.id));
    $("#login").hidden = true;
    $("#dashboard").hidden = false;
    initialize();
    render();
    refresh({ silent: true });
  } catch (loginError) {
    error.textContent = loginError.message.includes("decrypt") || loginError.name === "OperationError"
      ? "密码不正确，或数据正在更新，请稍后重试。"
      : loginError.message;
    error.hidden = false;
  }
}

function rangeFor(period, anchor, first) {
  const current = parseDate(anchor);
  if (period === "today") return [anchor, anchor];
  if (period === "yesterday") {
    const date = addDays(anchor, -1);
    return [date, date];
  }
  if (period === "7d") return [addDays(anchor, -6), anchor];
  if (period === "30d") return [addDays(anchor, -29), anchor];
  if (period === "month") return [`${anchor.slice(0, 7)}-01`, anchor];
  if (period === "lastMonth") {
    return [
      iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1))),
      iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0))),
    ];
  }
  return [first || addDays(anchor, -29), anchor];
}

function initialize() {
  $("#periods").innerHTML = periods.map((period) => `<button data-period="${period.k}">${period.l}</button>`).join("");
  $("#metric-tabs").innerHTML = Object.entries(metricNames).map(([key, label]) => `<button data-metric="${key}">${label}</button>`).join("");
  $("#channel-menu").innerHTML = `
    <div class="menu-actions"><button data-all="1">全选</button><button data-none="1">清空</button></div>
    ${state.data.channels.map((channel) => `
      <label>
        <input type="checkbox" value="${channel.id}" checked>
        <span>${escapeHtml(channel.name)}</span>
        <small class="${channel.sourceRowCount ? "" : "missing"}">${channel.sourceRowCount ? "已接入" : "缺明细"}</small>
      </label>
    `).join("")}`;
  $("#promotion-menu").innerHTML = `
    <div class="menu-actions"><button data-all="1">全选</button><button data-none="1">清空</button></div>
    ${state.data.promotions.map((promotion) => `
      <label>
        <input type="checkbox" value="${promotion.id}" checked>
        <span>${escapeHtml(promotion.name)}</span>
        <small>${escapeHtml(promotion.channelName)}</small>
      </label>
    `).join("")}` || '<div class="empty">暂无推广位数据</div>';
  $("#sources").innerHTML = "<b>数据来源</b>" + state.data.channels.map((channel) => `<a href="${channel.sourceUrl}" target="_blank" rel="noreferrer">${escapeHtml(channel.name)}</a>`).join("");

  $("#periods").onclick = (event) => {
    const period = event.target.dataset.period;
    if (period) {
      state.period = period;
      render();
    }
  };
  $("#metric-tabs").onclick = (event) => {
    const metric = event.target.dataset.metric;
    if (metric) {
      state.metric = metric;
      render();
    }
  };
  $("#ranking-dimension").onclick = (event) => {
    const dimension = event.target.dataset.dimension;
    if (dimension) {
      state.rankingDimension = dimension;
      renderRanking(context());
      syncActiveControls();
    }
  };
  $("#channel-menu").onclick = (event) => {
    if (event.target.dataset.all) {
      state.selectedChannels = new Set(state.data.channels.map((channel) => channel.id));
      $$("#channel-menu input").forEach((input) => { input.checked = true; });
      render();
    }
    if (event.target.dataset.none) {
      state.selectedChannels.clear();
      $$("#channel-menu input").forEach((input) => { input.checked = false; });
      render();
    }
  };
  $("#channel-menu").onchange = (event) => {
    if (event.target.matches("input")) {
      event.target.checked ? state.selectedChannels.add(event.target.value) : state.selectedChannels.delete(event.target.value);
      render();
    }
  };
  $("#promotion-menu").onclick = (event) => {
    if (event.target.dataset.all) {
      state.selectedPromotions = new Set(state.data.promotions.map((promotion) => promotion.id));
      $$("#promotion-menu input").forEach((input) => { input.checked = true; });
      render();
    }
    if (event.target.dataset.none) {
      state.selectedPromotions.clear();
      $$("#promotion-menu input").forEach((input) => { input.checked = false; });
      render();
    }
  };
  $("#promotion-menu").onchange = (event) => {
    if (event.target.matches("input")) {
      event.target.checked ? state.selectedPromotions.add(event.target.value) : state.selectedPromotions.delete(event.target.value);
      render();
    }
  };
  $("#trend-channel").onchange = (event) => {
    state.trendChannel = event.target.value;
    renderChart(context());
  };
  $("#search").oninput = (event) => {
    state.query = event.target.value;
    renderTable();
  };
  $$("th[data-sort]").forEach((header) => {
    header.onclick = () => {
      const field = header.dataset.sort;
      if (state.sort === field) state.desc = !state.desc;
      else {
        state.sort = field;
        state.desc = true;
      }
      renderTable();
    };
  });
}

function context() {
  const data = state.data;
  const anchor = data.rows.reduce((latest, row) => row.stat_date > latest ? row.stat_date : latest, "")
    || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
  const [start, end] = rangeFor(state.period, anchor, data.historyStart);
  const channelRows = data.rows.filter((row) => state.selectedChannels.has(row.channel_id) && row.stat_date >= start && row.stat_date <= end);
  const selectedChannelNames = new Set(data.channels.filter((channel) => state.selectedChannels.has(channel.id)).map((channel) => channel.name));
  const eligiblePromotions = data.promotions.filter((promotion) => selectedChannelNames.has(promotion.channelName));
  const promotions = eligiblePromotions.filter((promotion) => state.selectedPromotions.has(promotion.id));
  const promotionIds = new Set(promotions.map((promotion) => promotion.id));
  const promotionRows = data.promotionRows.filter((row) => promotionIds.has(row.promotion_id) && row.stat_date >= start && row.stat_date <= end);
  const promotionSlice = promotions.length !== eligiblePromotions.length;
  const selectedChannelRows = data.rows.filter((row) => state.selectedChannels.has(row.channel_id));
  const allSelectedPromotionRows = data.promotionRows.filter((row) => promotionIds.has(row.promotion_id));
  const analysisRows = promotionSlice ? aggregatePromotionRows(allSelectedPromotionRows, data.channels) : selectedChannelRows;
  const rows = promotionSlice ? analysisRows.filter((row) => row.stat_date >= start && row.stat_date <= end) : channelRows;
  const days = Math.max(1, Math.round((parseDate(end) - parseDate(start)) / 86400000) + 1);
  return { data, anchor, start, end, rows, channelRows, promotions, promotionRows, analysisRows, promotionSlice, days };
}

function aggregatePromotionRows(rows, channels) {
  const channelByName = new Map(channels.map((channel) => [channel.name, channel]));
  const aggregates = new Map();
  for (const row of rows) {
    const channel = channelByName.get(row.channel_name);
    if (!channel) continue;
    const key = `${channel.id}:${row.stat_date}`;
    const aggregate = aggregates.get(key) || {
      channel_id: channel.id,
      channel_name: channel.name,
      stat_date: row.stat_date,
      orders: 0,
      commission: 0,
      gmv: 0,
    };
    aggregate.orders += Number(row.orders || 0);
    aggregate.commission += Number(row.commission || 0);
    aggregate.gmv += Number(row.gmv || 0);
    aggregates.set(key, aggregate);
  }
  return [...aggregates.values()];
}

function syncTrendOptions() {
  const channels = state.data.channels.filter((channel) => state.selectedChannels.has(channel.id));
  if (state.trendChannel !== "all" && !channels.some((channel) => channel.id === state.trendChannel)) state.trendChannel = "all";
  $("#trend-channel").innerHTML = `<option value="all">全部渠道合计</option>${channels.map((channel) => `<option value="${channel.id}">${escapeHtml(channel.name)}</option>`).join("")}`;
  $("#trend-channel").value = state.trendChannel;
}

function syncActiveControls() {
  $$("#periods button").forEach((button) => button.classList.toggle("active", button.dataset.period === state.period));
  $$("#metric-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.metric === state.metric));
  $$("#ranking-dimension button").forEach((button) => button.classList.toggle("active", button.dataset.dimension === state.rankingDimension));
}

function render() {
  syncTrendOptions();
  syncActiveControls();
  const current = context();
  $("#channel-summary").textContent = state.selectedChannels.size === state.data.channels.length ? `全部 ${state.data.channels.length} 个` : `已选 ${state.selectedChannels.size} 个`;
  $("#promotion-summary").textContent = state.selectedPromotions.size === state.data.promotions.length ? `全部 ${state.data.promotions.length} 个` : `已选 ${state.selectedPromotions.size} 个`;
  renderStatus(current);
  renderKpis(current);
  renderChart(current);
  renderRanking(current);
  renderAlerts(current);
  renderComparison(current);
  renderTable(current);
}

function renderStatus(current) {
  const expected = state.selectedChannels.size * current.days;
  const coverage = expected ? current.channelRows.length / expected : 0;
  const promotionExpected = current.promotions.length * current.days;
  const promotionCoverage = promotionExpected ? current.promotionRows.length / promotionExpected : 0;
  $("#status").innerHTML = `
    <span>数据更新时间：${new Date(current.data.fetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span>
    <span>当前口径：${state.period === "all" ? "平台累计汇总（趋势为已保存历史）" : `${current.start} 至 ${current.end} · 当前筛选周期`}</span>
    <span class="${coverage === 1 ? "good" : "warn"}">渠道明细覆盖 ${Math.min(100, Math.round(coverage * 100))}%</span>
    <span class="${promotionCoverage === 1 ? "good" : "warn"}">推广位明细覆盖 ${Math.min(100, Math.round(promotionCoverage * 100))}%</span>
  `;
}

function getTotals(current) {
  if (state.period === "all") {
    if (current.promotionSlice) {
      const available = current.promotions.filter((promotion) => promotion.total);
      return available.reduce((total, promotion) => ({
        orders: total.orders + promotion.total.orders,
        commission: total.commission + promotion.total.commission,
        gmv: total.gmv + promotion.total.gmv,
        hasData: true,
      }), { orders: 0, commission: 0, gmv: 0, hasData: false });
    }
    return current.data.channels
      .filter((channel) => state.selectedChannels.has(channel.id) && channel.total)
      .reduce((total, channel) => ({
        orders: total.orders + channel.total.orders,
        commission: total.commission + channel.total.commission,
        gmv: total.gmv + channel.total.gmv,
        hasData: true,
      }), { orders: 0, commission: 0, gmv: 0, hasData: false });
  }
  return {
    orders: sum(current.rows, "orders"),
    commission: sum(current.rows, "commission"),
    gmv: sum(current.rows, "gmv"),
    hasData: current.rows.length > 0,
  };
}

function renderKpis(current) {
  const totals = getTotals(current);
  const rate = totals.gmv ? totals.commission / totals.gmv : null;
  const priorEnd = addDays(current.start, -1);
  const priorStart = addDays(priorEnd, -(current.days - 1));
  const priorRows = current.analysisRows.filter((row) => row.stat_date >= priorStart && row.stat_date <= priorEnd);
  const prior = {
    orders: sum(priorRows, "orders"),
    commission: sum(priorRows, "commission"),
    gmv: sum(priorRows, "gmv"),
  };
  const prefix = periodNames[state.period];
  const items = [
    { label: `${prefix}有效订单`, value: totals.hasData ? `${num.format(totals.orders)} 单` : "暂无记录", key: "orders" },
    { label: `${prefix}预估佣金`, value: totals.hasData ? money.format(totals.commission) : "暂无记录", key: "commission" },
    { label: `${prefix}有效成交金额`, value: totals.hasData ? money.format(totals.gmv) : "暂无记录", key: "gmv" },
    { label: `${prefix}佣金率`, value: !totals.hasData ? "暂无记录" : rate == null ? "不适用" : `${(rate * 100).toFixed(2)}%`, help: current.promotionSlice ? "已选推广位：预估佣金 ÷ 有效成交金额" : "预估佣金 ÷ 有效成交金额" },
  ];
  $("#kpis").innerHTML = items.map((item) => {
    let foot = item.help || "平台累计";
    if (!item.help && state.period !== "all" && totals.hasData) {
      const previous = prior[item.key];
      foot = previous
        ? `<span class="${totals[item.key] >= previous ? "delta-up" : "delta-down"}">${totals[item.key] >= previous ? "↑" : "↓"} ${Math.abs((totals[item.key] - previous) / previous * 100).toFixed(1)}%</span> · 较前 ${current.days} 天`
        : `较前 ${current.days} 天暂无可比数据`;
    }
    if (!item.help && current.promotionSlice) foot = totals.hasData ? `已按 ${current.promotions.length} 个推广位筛选` : "已选推广位暂无记录";
    return `<article class="kpi"><span>${item.label}</span><strong>${item.value}</strong><small>${foot}</small></article>`;
  }).join("");
}

function dailySeries(rows, start, end) {
  const byDate = new Map();
  for (const row of rows) {
    const aggregate = byDate.get(row.stat_date) || { date: row.stat_date, orders: 0, commission: 0, gmv: 0, records: 0 };
    aggregate.orders += Number(row.orders || 0);
    aggregate.commission += Number(row.commission || 0);
    aggregate.gmv += Number(row.gmv || 0);
    aggregate.records += 1;
    byDate.set(row.stat_date, aggregate);
  }
  const result = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    result.push(byDate.get(date) || { date, orders: null, commission: null, gmv: null, records: 0 });
  }
  return result;
}

function renderChart(current) {
  const channel = state.trendChannel === "all" ? null : current.data.channels.find((item) => item.id === state.trendChannel);
  const sourceRows = state.trendChannel === "all" ? current.rows : current.rows.filter((row) => row.channel_id === state.trendChannel);
  const daily = dailySeries(sourceRows, current.start, current.end);
  const available = daily.filter((day) => day[state.metric] != null);
  const subject = channel ? channel.name : "全部已选渠道";
  const sliceLabel = current.promotionSlice ? ` · ${current.promotions.length} 个推广位` : "";
  $("#trend-note").textContent = available.length < current.days
    ? `${subject}存在缺失日期；缺失值保留为“暂无记录”`
    : `${subject}${sliceLabel} · ${periodNames[state.period]}每日${metricNames[state.metric]}`;
  $("#trend-values").innerHTML = daily.map((day) => `
    <div class="trend-value ${day[state.metric] == null ? "missing" : ""}">
      <span>${day.date.slice(5).replace("-", "/")}</span>
      <b>${formatMetric(day[state.metric])}</b>
    </div>
  `).join("");
  if (!available.length) {
    $("#chart").innerHTML = '<div class="empty trend-empty">当前渠道在该时间范围暂无逐日记录</div>';
    return;
  }

  const width = 760;
  const height = 280;
  const padding = { left: 52, right: 18, top: 28, bottom: 34 };
  const values = available.map((day) => day[state.metric]);
  const maximum = Math.max(1, ...values);
  const x = (index) => padding.left + (width - padding.left - padding.right) * (daily.length === 1 ? 0.5 : index / (daily.length - 1));
  const y = (value) => padding.top + (height - padding.top - padding.bottom) * (1 - value / maximum);
  let grid = "";
  for (let index = 0; index < 5; index += 1) {
    const lineY = padding.top + (height - padding.top - padding.bottom) * index / 4;
    const value = maximum * (1 - index / 4);
    grid += `<line class="grid" x1="${padding.left}" y1="${lineY}" x2="${width - padding.right}" y2="${lineY}"/><text x="2" y="${lineY + 4}">${state.metric === "orders" ? Math.round(value) : Math.round(value)}</text>`;
  }
  const labels = daily.map((day, index) => {
    if (index % Math.max(1, Math.ceil(daily.length / 7)) !== 0 && index !== daily.length - 1) return "";
    return `<text text-anchor="middle" x="${x(index)}" y="${height - 6}">${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))}</text>`;
  }).join("");

  if (daily.length === 1) {
    const value = daily[0][state.metric];
    const rawBarY = y(value);
    const barHeight = Math.max(3, height - padding.bottom - rawBarY);
    const barY = height - padding.bottom - barHeight;
    $("#chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(subject)}${metricNames[state.metric]}每日趋势">${grid}<rect class="single-bar" x="${width / 2 - 44}" y="${barY}" width="88" height="${barHeight}" rx="10"/><text class="value-label" text-anchor="middle" x="${width / 2}" y="${Math.max(18, barY - 10)}">${formatMetric(value)}</text>${labels}</svg>`;
    return;
  }

  const segments = [];
  let segment = [];
  daily.forEach((day, index) => {
    if (day[state.metric] == null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else {
      segment.push({ index, day });
    }
  });
  if (segment.length) segments.push(segment);
  const lines = segments.map((items) => {
    if (items.length === 1) return "";
    return `<polyline class="line" points="${items.map(({ index, day }) => `${x(index)},${y(day[state.metric])}`).join(" ")}"/>`;
  }).join("");
  const points = segments.flat().map(({ index, day }) => `<circle class="point" cx="${x(index)}" cy="${y(day[state.metric])}" r="4"/>`).join("");
  const valueLabels = daily.length <= 14 ? segments.flat().map(({ index, day }) => `<text class="value-label" text-anchor="middle" x="${x(index)}" y="${Math.max(16, y(day[state.metric]) - 10)}">${state.metric === "orders" ? num.format(day[state.metric]) : money.format(day[state.metric])}</text>`).join("") : "";
  $("#chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(subject)}${metricNames[state.metric]}每日趋势">${grid}${lines}${points}${valueLabels}${labels}</svg>`;
}

function renderRanking(current) {
  const isPromotion = state.rankingDimension === "promotion";
  const list = isPromotion
    ? current.promotions.map((promotion) => {
      const rows = current.promotionRows.filter((row) => row.promotion_id === promotion.id);
      const value = state.period === "all" ? (promotion.total?.[state.metric] ?? null) : (rows.length ? sum(rows, state.metric) : null);
      return { id: promotion.id, name: promotion.name, parent: promotion.channelName, value };
    })
    : current.data.channels.filter((channel) => state.selectedChannels.has(channel.id)).map((channel) => {
      const rows = current.rows.filter((row) => row.channel_id === channel.id);
      let value;
      if (state.period === "all" && current.promotionSlice) {
        const totals = current.promotions.filter((promotion) => promotion.channelName === channel.name && promotion.total);
        value = totals.length ? sum(totals.map((promotion) => promotion.total), state.metric) : null;
      } else {
        value = state.period === "all" ? (channel.total?.[state.metric] ?? null) : (rows.length ? sum(rows, state.metric) : null);
      }
      return { id: channel.id, name: channel.name, parent: null, value };
    });
  list.sort((left, right) => (right.value ?? -1) - (left.value ?? -1));
  const maximum = Math.max(1, ...list.map((item) => item.value || 0));
  $("#ranking-title").textContent = `${isPromotion ? "推广位" : "渠道"}表现排名`;
  $("#ranking-note").textContent = `${periodNames[state.period]} · 按${metricNames[state.metric]}从高到低`;
  $("#ranking").innerHTML = list.length ? list.map((item, index) => `
    <div class="rank">
      <i>${index + 1}</i>
      <div class="rank-main">
        <div class="rank-label">
          <b>${escapeHtml(item.name)}${item.parent ? `<em>${escapeHtml(item.parent)}</em>` : ""}</b>
          <span>${formatMetric(item.value)}</span>
        </div>
        <div class="bar"><i style="width:${item.value == null ? 0 : Math.max(item.value === 0 ? 0 : 2, item.value / maximum * 100)}%"></i></div>
      </div>
    </div>
  `).join("") : '<div class="empty">当前筛选范围暂无记录</div>';
}

function findPrevious(rows, row) {
  return rows.find((item) => item.channel_id === row.channel_id && item.stat_date === addDays(row.stat_date, -1));
}

function tagFor(rows, row) {
  const previous = findPrevious(rows, row);
  if (row.orders > 0 && previous?.orders === 0) return ["新增出单", "up"];
  if (previous && previous.orders >= 2 && row.orders <= previous.orders * 0.5) return ["明显回落", "down"];
  if (previous && row.orders >= Math.max(3, previous.orders * 2)) return ["明显放量", "up"];
  return ["—", "muted"];
}

function renderAlerts(current) {
  const list = [];
  for (const channel of current.data.channels.filter((item) => state.selectedChannels.has(item.id))) {
    const rows = current.analysisRows.filter((row) => row.channel_id === channel.id).sort((left, right) => right.stat_date.localeCompare(left.stat_date));
    const currentRow = rows.find((row) => row.stat_date === current.anchor);
    const previousRow = rows.find((row) => row.stat_date === addDays(current.anchor, -1));
    if (!rows.length) list.push({ tone: "missing", title: `${channel.name}：逐日明细缺失`, detail: current.promotionSlice ? "已选推广位未返回逐日行，未按真实 0 处理。" : "源站未返回逐日行，未按真实 0 处理。" });
    else if (currentRow && previousRow && currentRow.orders > 0 && previousRow.orders === 0) list.push({ tone: "up", title: `${channel.name}：新增出单`, detail: `今日 ${currentRow.orders} 单，昨日为 0 单。` });
    else if (currentRow && previousRow && previousRow.orders >= 2 && currentRow.orders <= previousRow.orders * 0.5) list.push({ tone: "down", title: `${channel.name}：明显回落`, detail: `订单从 ${previousRow.orders} 单降至 ${currentRow.orders} 单。` });
    else if (currentRow && previousRow && currentRow.orders >= Math.max(3, previousRow.orders * 2)) list.push({ tone: "up", title: `${channel.name}：明显放量`, detail: `订单从 ${previousRow.orders} 单升至 ${currentRow.orders} 单。` });
  }
  $("#alerts").innerHTML = list.length
    ? list.slice(0, 6).map((item) => `<div class="alert ${item.tone}"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p></div>`).join("")
    : '<div class="empty">当前渠道暂无明显异常</div>';
}

function renderComparison(current) {
  const weekday = current.rows.filter((row) => {
    const day = parseDate(row.stat_date).getUTCDay();
    return day > 0 && day < 6;
  });
  const weekend = current.rows.filter((row) => {
    const day = parseDate(row.stat_date).getUTCDay();
    return day === 0 || day === 6;
  });
  const average = (rows) => {
    const days = new Set(rows.map((row) => row.stat_date)).size;
    return days ? sum(rows, "orders") / days : null;
  };
  const weekdayAverage = average(weekday);
  const weekendAverage = average(weekend);
  $("#comparison").innerHTML = `
    <div class="comparison">
      <div><span>工作日平均订单</span><b>${weekdayAverage == null ? "暂无记录" : `${weekdayAverage.toFixed(1)} 单/日`}</b></div>
      <div><span>周末平均订单</span><b>${weekendAverage == null ? "暂无记录" : `${weekendAverage.toFixed(1)} 单/日`}</b></div>
      <p>${weekdayAverage != null && weekendAverage != null ? `当前筛选中，${weekdayAverage >= weekendAverage ? "工作日" : "周末"}日均订单更高。` : "需同时覆盖工作日与周末后才能比较。"}</p>
    </div>
  `;
}

function renderTable(current = context()) {
  const rows = [...current.rows]
    .filter((row) => row.channel_name.includes(state.query.trim()))
    .sort((left, right) => {
      const result = state.sort === "stat_date"
        ? left.stat_date.localeCompare(right.stat_date)
        : Number(left[state.sort]) - Number(right[state.sort]);
      return state.desc ? -result : result;
    });
  $("#detail-body").innerHTML = rows.map((row) => {
    const [tag, tone] = tagFor(current.analysisRows, row);
    return `
      <tr>
        <td>${row.stat_date}</td><td><b>${escapeHtml(row.channel_name)}</b></td>
        <td>${num.format(row.orders)}</td><td>${money.format(row.commission)}</td><td>${money.format(row.gmv)}</td>
        <td>${row.gmv ? `${(row.commission / row.gmv * 100).toFixed(2)}%` : "不适用"}</td>
        <td><span class="tag ${tone}">${tag}</span></td>
      </tr>
    `;
  }).join("");
  $("#empty-detail").hidden = rows.length > 0;
  $$("th[data-sort]").forEach((header) => {
    header.textContent = header.dataset.sort === "stat_date"
      ? `日期${state.sort === "stat_date" ? (state.desc ? " ↓" : " ↑") : ""}`
      : ({ orders: "订单", commission: "预估佣金", gmv: "成交金额" }[header.dataset.sort] + (state.sort === header.dataset.sort ? (state.desc ? " ↓" : " ↑") : ""));
  });
}

async function refresh({ silent = false } = {}) {
  if (!state.password || state.refreshing) return;
  state.refreshing = true;
  const button = $("#refresh");
  button.disabled = true;
  button.textContent = "…";
  $(".live").innerHTML = "<i></i> 正在获取源数据";
  try {
    const next = await fetchLiveData(state.data);
    state.data = next;
    state.selectedChannels = new Set([...state.selectedChannels].filter((id) => next.channels.some((channel) => channel.id === id)));
    state.selectedPromotions = new Set([...state.selectedPromotions].filter((id) => next.promotions.some((promotion) => promotion.id === id)));
    render();
    const time = new Date(next.fetchedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" });
    $(".live").innerHTML = `<i></i> ${next.liveFailures ? `已更新，${next.liveFailures} 个来源暂不可用` : `实时更新于 ${time}`}`;
  } catch (liveError) {
    try {
      const snapshot = normalizeData(await fetchData(state.password));
      if (snapshot.fetchedAt > state.data.fetchedAt) state.data = snapshot;
      render();
      $(".live").innerHTML = `<i></i> 实时连接失败，显示最近快照`;
    } catch {
      $("#dashboard").hidden = true;
      $("#login").hidden = false;
      $("#login-error").textContent = "密码或数据版本已更新，请重新登录。";
      $("#login-error").hidden = false;
      state.password = "";
    }
    if (!silent) console.warn(liveError);
  } finally {
    state.refreshing = false;
    button.disabled = false;
    button.textContent = "↻";
  }
}

$("#login-form").addEventListener("submit", login);
$("#show-password").onclick = () => {
  const input = $("#password");
  input.type = input.type === "password" ? "text" : "password";
  $("#show-password").textContent = input.type === "password" ? "显示" : "隐藏";
};
$("#refresh").onclick = () => refresh();
$("#logout").onclick = () => {
  state.password = "";
  state.data = null;
  $("#password").value = "";
  $("#dashboard").hidden = true;
  $("#login").hidden = false;
};
setInterval(() => { if (state.password) refresh(); }, 300_000);
if (location.protocol === "file:") $(".live").innerHTML = "<i></i> 本地加密快照";
