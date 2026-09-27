export const NOT_ENOUGH =
  "The forecast will be calculated once this product has at least two calendar months of purchases.";

export function todayInIndia(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function formatWhen(iso, now = iso) {
  const date = typeof now === "string" ? new Date(now) : now;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function weekday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayWeight(iso, weekendWeight) {
  const day = weekday(iso);
  return day === 0 || day === 6 ? weekendWeight : 1;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function roundHalfUp(value, decimals) {
  const factor = 10 ** decimals;
  const n = value * factor;
  if (!Number.isFinite(n)) return value;
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const base = Math.floor(abs);
  const frac = abs - base;
  const rounded = frac > 0.5 || Math.abs(frac - 0.5) < 1e-8 ? base + 1 : base;
  return (sign * rounded) / factor;
}

export function eachDate(start, end) {
  if (!start || !end || end < start) return [];
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}

export function effectiveDays(start, end, weekendWeight) {
  let sum = 0;
  for (const day of eachDate(start, end)) sum = round4(sum + dayWeight(day, weekendWeight));
  return sum;
}

export function monthBounds(month) {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start, end: addDays(nextMonth, -1) };
}

export function lookbackMonths(anchorMonth, count) {
  const months = [];
  let [y, m] = anchorMonth.split("-").map(Number);
  for (let i = 0; i < count; i += 1) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months.reverse();
}

export function money(packs, price) {
  const paise = Math.round(Number(price) * 100);
  return ((packs * paise) / 100).toFixed(2);
}

export function addMoney(values) {
  const paise = values.reduce((sum, value) => sum + Math.round(Number(value) * 100), 0);
  return (paise / 100).toFixed(2);
}

function latestPrice(purchases) {
  const ordered = [...purchases].sort((a, b) => {
    if (a.purchasedOn !== b.purchasedOn) return a.purchasedOn < b.purchasedOn ? 1 : -1;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
  return ordered[0]?.pricePerPack ?? null;
}

function shelfState(purchases, counts, today) {
  const activePurchases = purchases.filter((row) => !row.deletedAt && row.purchasedOn <= today);
  const activeCounts = counts.filter((row) => !row.deletedAt && row.countedOn <= today);
  const anchor =
    [...activeCounts].sort((a, b) => (a.countedOn < b.countedOn ? 1 : -1))[0] ?? null;
  const addedAfter = anchor
    ? activePurchases.filter((row) => row.purchasedOn > anchor.countedOn)
    : activePurchases;
  const shelf = (anchor?.packs ?? 0) + addedAfter.reduce((sum, row) => sum + row.packs, 0);
  return { activePurchases, anchor, shelf };
}

export function computeProduct({ product, purchases, counts, settings, today }) {
  const { activePurchases, anchor, shelf } = shelfState(purchases, counts, today);
  const consumption = anchor
    ? activePurchases.filter((row) => row.purchasedOn <= anchor.countedOn)
    : activePurchases;

  const anchorMonth = today.slice(0, 7);
  const window = lookbackMonths(anchorMonth, settings.lookbackMonths);
  const recorded = [];
  for (const month of window) {
    const bounds = monthBounds(month);
    const end = bounds.end < today ? bounds.end : today;
    const monthPurchases = consumption.filter(
      (row) => row.purchasedOn >= bounds.start && row.purchasedOn <= end,
    );
    if (monthPurchases.length === 0) continue;
    recorded.push({
      month,
      packs: monthPurchases.reduce((sum, row) => sum + row.packs, 0),
      effectiveDays: effectiveDays(bounds.start, end, settings.weekendWeight),
    });
  }

  const base = {
    reorderLevel: product.reorderLevel,
    warningEffectiveDays: product.warningEffectiveDays,
  };

  if (recorded.length < 2) {
    return {
      ...base,
      onHand: shelf.toFixed(2),
      burnRatePerEffectiveDay: null,
      expectedDate: null,
      coverEffectiveDays: null,
      status: "not_enough_history",
      message: NOT_ENOUGH,
      trace: null,
    };
  }

  const packs = recorded.reduce((sum, month) => sum + month.packs, 0);
  const days = round4(recorded.reduce((sum, month) => sum + month.effectiveDays, 0));
  const burn = days === 0 ? null : roundHalfUp(packs / days, 2);
  if (!burn) {
    return {
      ...base,
      onHand: shelf.toFixed(2),
      burnRatePerEffectiveDay: null,
      expectedDate: null,
      coverEffectiveDays: null,
      status: "not_enough_history",
      message: NOT_ENOUGH,
      trace: { months: recorded.map((month) => month.month), packs, effectiveDays: String(days) },
    };
  }

  const later = anchor ? activePurchases.filter((row) => row.purchasedOn > anchor.countedOn) : [];
  const onHand = anchor
    ? walkOnHand({
        packs: anchor.packs,
        from: addDays(anchor.countedOn, 1),
        to: today,
        purchases: later,
        burn,
        weekendWeight: settings.weekendWeight,
      })
    : round4(shelf - burn * effectiveDays(today, today, settings.weekendWeight));
  const shown = roundHalfUp(onHand, 2);
  const projected = projectRunOut({
    today,
    onHand: shown,
    burn,
    reorderLevel: product.reorderLevel,
    weekendWeight: settings.weekendWeight,
  });
  const expectedDate = projected.expectedDate;
  const cover = Number(projected.coverEffectiveDays);

  const due =
    shown <= product.reorderLevel ||
    (expectedDate !== today &&
      effectiveDays(addDays(today, 1), expectedDate, settings.weekendWeight) <=
        product.warningEffectiveDays) ||
    (expectedDate === today && shown <= product.reorderLevel);

  return {
    ...base,
    onHand: shown.toFixed(2),
    burnRatePerEffectiveDay: burn.toFixed(2),
    expectedDate: shown <= product.reorderLevel ? today : expectedDate,
    coverEffectiveDays: shown <= product.reorderLevel ? "0.0" : cover.toFixed(1),
    status: due ? "due" : "on_track",
    message: null,
    trace: {
      months: recorded.map((month) => month.month),
      packs,
      effectiveDays: String(days),
    },
  };
}

export function shiftMonth(month, delta) {
  let [year, mon] = month.split("-").map(Number);
  mon += delta;
  while (mon > 12) {
    mon -= 12;
    year += 1;
  }
  while (mon < 1) {
    mon += 12;
    year -= 1;
  }
  return `${year}-${String(mon).padStart(2, "0")}`;
}

export function nextMonthFrame(settings, today) {
  const month = shiftMonth(today.slice(0, 7), 1);
  const bounds = monthBounds(month);
  return {
    month,
    effectiveDays: String(round4(effectiveDays(bounds.start, bounds.end, settings.weekendWeight))),
  };
}

export function monthHistory(purchases, settings, today) {
  const window = lookbackMonths(today.slice(0, 7), settings.lookbackMonths);
  return window.map((month) => {
    const bounds = monthBounds(month);
    const end = bounds.end < today ? bounds.end : today;
    const rows = purchases.filter(
      (row) => !row.deletedAt && row.purchasedOn >= bounds.start && row.purchasedOn <= end,
    );
    const packs = rows.reduce((sum, row) => sum + row.packs, 0);
    const days = round4(effectiveDays(bounds.start, end, settings.weekendWeight));
    const rate = rows.length && days > 0 ? roundHalfUp(packs / days, 2) : null;
    return {
      month,
      packs,
      spend: addMoney(rows.map((row) => money(row.packs, row.pricePerPack))),
      effectiveDays: String(days),
      rate: rate == null ? null : rate.toFixed(2),
      recorded: rows.length > 0,
    };
  });
}

function weightedAverage(rows) {
  let packs = 0;
  let paise = 0;
  for (const row of rows) {
    packs += Number(row.packs);
    paise += Number(row.packs) * Math.round(Number(row.pricePerPack) * 100);
  }
  if (!packs) return null;
  return (roundHalfUp(paise / packs, 0) / 100).toFixed(2);
}

export function scaleMoney(packs, pricePerPack) {
  const pricePaise = Math.round(Number(pricePerPack) * 100);
  return (roundHalfUp(Number(packs) * pricePaise, 0) / 100).toFixed(2);
}

export function projectMonth({ purchases, math, settings, today, basisPacks, basisSpend }) {
  const frame = nextMonthFrame(settings, today);
  const result = {
    ...frame,
    packs: null,
    spend: null,
    averagePricePerPack: null,
    basisMonth: today.slice(0, 7),
    basisPacks,
    basisSpend,
  };
  if (!math.burnRatePerEffectiveDay || !math.trace) return result;
  const months = new Set(math.trace.months);
  const rows = purchases.filter(
    (row) => !row.deletedAt && row.purchasedOn <= today && months.has(row.purchasedOn.slice(0, 7)),
  );
  const average = weightedAverage(rows);
  const packs = roundHalfUp(Number(math.burnRatePerEffectiveDay) * Number(frame.effectiveDays), 2);
  result.packs = packs.toFixed(2);
  result.averagePricePerPack = average;
  result.spend = average == null ? null : scaleMoney(packs, average);
  return result;
}

function packsByDate(rows) {
  const bought = new Map();
  for (const row of rows) bought.set(row.purchasedOn, (bought.get(row.purchasedOn) || 0) + row.packs);
  return bought;
}

function walkOnHand({ packs, from, to, purchases, burn, weekendWeight }) {
  if (!from || from > to) return packs;
  const bought = packsByDate(purchases);
  let qty = packs;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    qty = round4(qty + (bought.get(day) || 0));
    qty = round4(qty - burn * dayWeight(day, weekendWeight));
  }
  return qty;
}

export function projectRunOut({ today, onHand, burn, reorderLevel, weekendWeight, closedWeekdays = 0 }) {
  const shown = Number(onHand);
  if (!(Number(burn) > 0) || shown <= reorderLevel) {
    return { expectedDate: today, coverEffectiveDays: "0.0" };
  }
  const need = (shown - reorderLevel) / Number(burn);
  const cover = roundHalfUp(need, 1);
  let walked = 0;
  let expectedDate = addDays(today, 1);
  let closedLeft = closedWeekdays;
  for (let guard = 0; guard < 4000; guard += 1) {
    const weekend = weekday(expectedDate) === 0 || weekday(expectedDate) === 6;
    let weight = weekend ? weekendWeight : 1;
    if (!weekend && closedLeft > 0) {
      weight = 0;
      closedLeft -= 1;
    }
    walked = round4(walked + weight);
    if (walked + 1e-9 >= need) break;
    expectedDate = addDays(expectedDate, 1);
  }
  return { expectedDate, coverEffectiveDays: cover.toFixed(1) };
}

export function stockSeries({ purchases, counts, settings, today, burnRate, expectedDate, onHand }) {
  if (burnRate == null || Number(burnRate) === 0) return [];
  const burn = Number(burnRate);
  const weight = settings.weekendWeight;
  const activePurchases = purchases.filter((row) => !row.deletedAt && row.purchasedOn <= today);
  const activeCounts = counts.filter((row) => !row.deletedAt && row.countedOn <= today);
  const { anchor } = shelfState(purchases, counts, today);
  const anchorDate = anchor?.countedOn ?? null;
  const since = anchorDate ? addDays(anchorDate, 1) : today;
  let end = expectedDate && expectedDate > today ? expectedDate : today;
  end = addDays(end, 7);
  const minSpan = addDays(since, 14);
  if (end < minSpan) end = minSpan;
  const cap = addDays(today, 45);
  if (end > cap) end = cap;
  if (end < since) end = since;

  const countPacks = new Map(activeCounts.map((row) => [row.countedOn, row.packs]));
  const boughtOn = new Map();
  for (const row of activePurchases) {
    if (countPacks.has(row.purchasedOn)) continue;
    if (anchorDate && row.purchasedOn >= anchorDate) continue;
    boughtOn.set(row.purchasedOn, (boughtOn.get(row.purchasedOn) || 0) + row.packs);
  }
  const boughtAfter = new Map();
  for (const row of activePurchases) {
    if (anchorDate && row.purchasedOn > anchorDate) {
      boughtAfter.set(row.purchasedOn, (boughtAfter.get(row.purchasedOn) || 0) + row.packs);
    }
  }

  const points = [];
  const purchaseDates = [...boughtOn.keys()].sort();
  if (anchorDate && purchaseDates.length) {
    const windowStart = `${lookbackMonths(today.slice(0, 7), settings.lookbackMonths)[0]}-01`;
    let start = addDays(purchaseDates[0], -1);
    if (start < windowStart) start = windowStart;
    let qty = 0;
    const opening = activeCounts
      .filter((row) => row.countedOn <= start && row.packs > 0)
      .sort((a, b) => (a.countedOn < b.countedOn ? 1 : -1))[0];
    if (opening) qty = opening.packs;

    for (let day = start; day < anchorDate; day = addDays(day, 1)) {
      const bought = boughtOn.get(day) || 0;
      if (countPacks.has(day)) qty = countPacks.get(day);
      else if (bought) qty = round4(qty + bought);
      const baseline = day === start && !bought && !countPacks.has(day);
      if (!baseline && !countPacks.has(day)) qty = round4(qty - burn * dayWeight(day, weight));
      const point = {
        date: day,
        onHand: roundHalfUp(qty, 2).toFixed(2),
        projected: false,
      };
      if (bought) point.marker = "purchase";
      else if (countPacks.has(day)) point.marker = "count";
      points.push(point);
    }
  }

  let qty = anchor ? anchor.packs : 0;
  if (anchor) {
    points.push({
      date: anchor.countedOn,
      onHand: Number(qty).toFixed(2),
      projected: false,
      marker: anchor.countedOn === today ? "today" : "count",
    });
  }

  for (let day = since; day <= end; day = addDays(day, 1)) {
    const added = day <= today ? boughtAfter.get(day) || 0 : 0;
    if (added) qty = round4(qty + added);
    qty = round4(qty - burn * dayWeight(day, weight));
    const point = {
      date: day,
      onHand: roundHalfUp(qty, 2).toFixed(2),
      projected: day > today,
    };
    if (added) point.marker = "purchase";
    else if (day === today) point.marker = "today";
    else if (day === expectedDate) point.marker = "expected";
    points.push(point);
  }
  return points;
}

export function monthFigures(purchases, month) {
  const rows = purchases.filter((row) => !row.deletedAt && row.purchasedOn.startsWith(month));
  const packsAdded = rows.reduce((sum, row) => sum + row.packs, 0);
  const spend = addMoney(rows.map((row) => money(row.packs, row.pricePerPack)));
  return {
    packsAdded,
    spend,
    latestPricePerPack: latestPrice(rows),
  };
}
