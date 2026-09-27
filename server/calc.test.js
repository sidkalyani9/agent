import assert from "node:assert/strict";
import test from "node:test";
import {
  computeProduct,
  effectiveDays,
  monthBounds,
  monthFigures,
  projectMonth,
  roundHalfUp,
  scaleMoney,
  stockSeries,
} from "./calc.js";

test("twenty packs over 22 weekdays and 8 weekend days burn at 0.85", () => {
  const july = monthBounds("2026-07");
  const days = eachCount(july.start, july.end);
  assert.equal(days.weekdays, 23);
  assert.equal(roundHalfUp(20 / 23.6, 2), 0.85);
  assert.equal(roundHalfUp(6 / 0.85, 1), 7.1);
});

test("effective days use the company weekend weight", () => {
  assert.equal(effectiveDays("2026-09-21", "2026-09-27", 0.2), 5.4);
});

test("a product with one purchase month stays on not enough history", () => {
  const row = computeProduct({
    product: { reorderLevel: 0, warningEffectiveDays: 5 },
    purchases: [purchase("2026-09-04", 6, "60.00")],
    counts: [count("2026-09-01", 0)],
    settings: { weekendWeight: 0.2, lookbackMonths: 3 },
    today: "2026-09-25",
  });
  assert.equal(row.status, "not_enough_history");
  assert.equal(row.burnRatePerEffectiveDay, null);
  assert.match(row.message, /two calendar months/);
});

test("two months open the burn rate and a count ignores a same-day purchase", () => {
  const row = computeProduct({
    product: { reorderLevel: 0, warningEffectiveDays: 5 },
    purchases: [
      purchase("2026-07-15", 20, "180.00"),
      purchase("2026-08-12", 20, "200.00"),
      purchase("2026-09-20", 4, "210.00"),
    ],
    counts: [count("2026-07-01", 0), count("2026-09-20", 6)],
    settings: { weekendWeight: 0.2, lookbackMonths: 3 },
    today: "2026-09-25",
  });
  assert.equal(row.trace.packs, 44);
  assert.ok(row.burnRatePerEffectiveDay);
  assert.equal(Number(row.onHand) < 6, true);
  const withSameDay = computeProduct({
    product: { reorderLevel: 0, warningEffectiveDays: 5 },
    purchases: [purchase("2026-09-20", 4, "210.00")],
    counts: [count("2026-09-20", 6)],
    settings: { weekendWeight: 0.2, lookbackMonths: 3 },
    today: "2026-09-20",
  });
  assert.equal(withSameDay.onHand, "6.00");
});

test("the runway lands on today's on-hand and weekends fall more slowly", () => {
  const input = {
    product: { reorderLevel: 0, warningEffectiveDays: 5 },
    purchases: [
      purchase("2026-07-15", 20, "180.00"),
      purchase("2026-08-12", 20, "200.00"),
      purchase("2026-09-08", 10, "205.00"),
    ],
    counts: [count("2026-07-01", 0), count("2026-09-20", 6)],
    settings: { weekendWeight: 0.2, lookbackMonths: 3 },
    today: "2026-09-25",
  };
  const row = computeProduct(input);
  const series = stockSeries({
    ...input,
    burnRate: row.burnRatePerEffectiveDay,
    expectedDate: row.expectedDate,
    onHand: row.onHand,
  });
  const todayPoint = series.find((point) => point.date === "2026-09-25");
  const saturday = series.find((point) => point.date === "2026-09-26");
  const sunday = series.find((point) => point.date === "2026-09-27");
  const monday = series.find((point) => point.date === "2026-09-28");
  assert.equal(todayPoint.onHand, row.onHand);
  assert.equal(todayPoint.projected, false);
  assert.equal(saturday.projected, true);
  const weekendDrop = Number(todayPoint.onHand) - Number(saturday.onHand);
  const weekdayDrop = Number(sunday.onHand) - Number(monday.onHand);
  assert.ok(weekdayDrop > weekendDrop * 3);
  const beforeBuy = series.find((point) => point.date === "2026-08-11");
  const buy = series.find((point) => point.date === "2026-08-12");
  assert.equal(buy.marker, "purchase");
  assert.ok(Number(buy.onHand) > Number(beforeBuy.onHand));
  const forecast = projectMonth({
    purchases: input.purchases,
    math: row,
    settings: input.settings,
    today: input.today,
    basisPacks: 10,
    basisSpend: "2050.00",
  });
  assert.equal(forecast.month, "2026-10");
  assert.equal(
    forecast.packs,
    roundHalfUp(Number(row.burnRatePerEffectiveDay) * Number(forecast.effectiveDays), 2).toFixed(2),
  );
  assert.equal(forecast.spend, scaleMoney(forecast.packs, forecast.averagePricePerPack));
});

test("a purchase today is added in full and the chart spikes on that day", () => {
  const settings = { weekendWeight: 0.2, lookbackMonths: 3 };
  const product = { reorderLevel: 0, warningEffectiveDays: 5 };
  const counts = [count("2026-07-01", 0), count("2026-09-18", 4)];
  const earlier = [
    purchase("2026-07-21", 18, "20.00"),
    purchase("2026-08-19", 16, "22.00"),
    purchase("2026-09-11", 8, "22.00"),
  ];
  const before = computeProduct({ product, purchases: earlier, counts, settings, today: "2026-09-25" });
  const bought = [...earlier, purchase("2026-09-25", 20, "20.00")];
  const after = computeProduct({ product, purchases: bought, counts, settings, today: "2026-09-25" });
  assert.equal(after.onHand, (Number(before.onHand) + 20).toFixed(2));
  assert.equal(after.burnRatePerEffectiveDay, before.burnRatePerEffectiveDay);
  const series = stockSeries({
    purchases: bought,
    counts,
    settings,
    today: "2026-09-25",
    burnRate: after.burnRatePerEffectiveDay,
    expectedDate: after.expectedDate,
    onHand: after.onHand,
  });
  const yesterday = series.find((point) => point.date === "2026-09-24");
  const todayPoint = series.find((point) => point.date === "2026-09-25");
  const countPoint = series.find((point) => point.date === "2026-09-18");
  assert.equal(todayPoint.marker, "purchase");
  assert.equal(todayPoint.onHand, after.onHand);
  assert.ok(Number(todayPoint.onHand) > Number(yesterday.onHand) + 15);
  assert.equal(countPoint.onHand, "4.00");
});

test("a soft-deleted purchase drops out of the month spend", () => {
  const figures = monthFigures(
    [
      purchase("2026-09-04", 6, "60.00"),
      { ...purchase("2026-09-05", 2, "60.00"), deletedAt: "2026-09-06T00:00:00Z" },
    ],
    "2026-09",
  );
  assert.equal(figures.packsAdded, 6);
  assert.equal(figures.spend, "360.00");
});

function purchase(purchasedOn, packs, pricePerPack) {
  return { purchasedOn, packs, pricePerPack, createdAt: `${purchasedOn}T00:00:00Z`, deletedAt: null };
}

function count(countedOn, packs) {
  return { countedOn, packs, deletedAt: null };
}

function eachCount(start, end) {
  let cursor = start;
  let weekdays = 0;
  let weekend = 0;
  while (cursor <= end) {
    const [y, m, d] = cursor.split("-").map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (day === 0 || day === 6) weekend += 1;
    else weekdays += 1;
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    cursor = dt.toISOString().slice(0, 10);
  }
  return { weekdays, weekend };
}
