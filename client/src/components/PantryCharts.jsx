import { useState } from "react";
import { indiaDate, monthLabel, rupee } from "../api.js";

const VB_W = 680;
const VB_H = 280;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 18;
const PAD_B = 36;

export function PantryCharts({ pantry, range, onRange }) {
  const products = (pantry?.products || []).filter((product) => !product.deletedAt);
  const [selectedId, setSelectedId] = useState("");
  if (!products.length) return null;
  const selected = products.find((product) => product.productId === selectedId) || preferred(products);
  const history = (selected.history || []).filter((month) => monthOverlaps(month.month, range));

  return (
    <section className="charts">
      <article className="card">
        <div className="card-head filter-head">
          <h2>Stock on hand</h2>
          <DateRange range={range} onRange={onRange} />
        </div>
        <div className="choices product-choices" role="group" aria-label="Product">
            {products.map((product) => (
              <button
                key={product.productId}
                type="button"
                className="choice"
                aria-pressed={product.productId === selected.productId}
                onClick={() => setSelectedId(product.productId)}
              >
                {product.name}
              </button>
            ))}
        </div>
        <div className="runway">
          <RunwayCopy product={selected} />
          <Runway product={selected} today={pantry.today} range={range} />
        </div>
      </article>

      <div className="chart-split">
        <article className="card">
          <h2>Packs behind the burn</h2>
          <MonthColumns history={history.length ? history : selected.history} today={pantry.today} />
        </article>
        <article className="card">
          <div className="card-head">
            <h2>{monthLabel(pantry.forecast.month)}</h2>
            <div className="legend">
              <span><i className="swatch actual" /> This month</span>
              <span><i className="swatch forecast" /> Forecast</span>
            </div>
          </div>
          <ForecastRows products={products} />
        </article>
      </div>
    </section>
  );
}

export function OfficeCompare({ summary }) {
  const max = Math.max(
    1,
    ...summary.offices.flatMap((office) => [Number(office.spend), Number(office.forecastSpend || 0)]),
  );
  return (
    <section className="card charts">
      <div className="card-head">
        <h2>Spend and next month</h2>
        <div className="legend">
          <span><i className="swatch actual" /> {monthLabel(summary.month)}</span>
          <span><i className="swatch forecast" /> {monthLabel(summary.forecastMonth)}</span>
        </div>
      </div>
      <div className="hbars">
        {summary.offices.map((office) => (
          <div className="hbar" key={office.officeId}>
            <span className="hbar-name">{office.name}</span>
            <div className="hbar-track">
              <i className="hbar-actual" style={{ width: `${(Number(office.spend) / max) * 100}%` }} />
              {office.forecastSpend != null ? (
                <i className="hbar-forecast" style={{ width: `${(Number(office.forecastSpend) / max) * 100}%` }} />
              ) : (
                <span className="hbar-wait">Two months needed</span>
              )}
            </div>
            <span className="hbar-value">
              {rupee(office.spend)}
              <small>{office.forecastSpend == null ? "No forecast" : rupee(office.forecastSpend)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunwayCopy({ product }) {
  if (!product.burnRatePerEffectiveDay) {
    return (
      <div className="runway-copy">
        <p className="runway-kicker">{product.name}</p>
        <p className="chart-empty">{product.message}</p>
      </div>
    );
  }
  return (
    <div className="runway-copy">
      <p className="runway-kicker">{product.name}</p>
      <p className="runway-stat">{product.burnRatePerEffectiveDay}</p>
      <p>packs per effective day</p>
      <dl>
        <div><dt>On hand</dt><dd>{product.onHand}</dd></div>
        <div><dt>Cover</dt><dd>{product.coverEffectiveDays} effective days</dd></div>
        <div><dt>Expected</dt><dd>{indiaDate(product.expectedDate)}</dd></div>
      </dl>
    </div>
  );
}

function Runway({ product, today, range }) {
  const points = (product.series || []).filter((point) => inRange(point.date, range));
  const [hover, setHover] = useState(null);
  if (points.length < 2) {
    return <p className="chart-empty">The line appears once two calendar months of purchases are on record.</p>;
  }

  const reorder = Number(product.reorderLevel);
  const values = points.map((point) => Number(point.onHand));
  let min = Math.min(...values, reorder, 0);
  let max = Math.max(...values, reorder, 1);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.1;
  min -= pad;
  max += pad;
  const innerW = VB_W - PAD_L - PAD_R;
  const innerH = VB_H - PAD_T - PAD_B;
  const x = (index) => PAD_L + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const y = (value) => PAD_T + (1 - (value - min) / (max - min)) * innerH;
  const indexed = points.map((point, index) => ({ ...point, index }));
  const todayHit = indexed.findIndex((point) => point.date === today);
  const past = todayHit < 0 ? indexed.filter((point) => !point.projected) : indexed.slice(0, todayHit + 1);
  const future = todayHit < 0 ? indexed.filter((point) => point.projected) : indexed.slice(todayHit);
  const yTicks = ticks(min, max);

  function nearest(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const vx = ((event.clientX - rect.left) / rect.width) * VB_W;
    let best = indexed[0];
    let bestDist = Infinity;
    for (const point of indexed) {
      const dist = Math.abs(x(point.index) - vx);
      if (dist < bestDist) {
        best = point;
        bestDist = dist;
      }
    }
    setHover(best);
  }

  const summary = `${product.name} on hand from ${axisDate(points[0].date)} to ${axisDate(points[points.length - 1].date)}. Today is ${product.onHand} packs.`;

  const tipLeft = hover ? x(hover.index) / VB_W : 0;

  return (
    <div className="chart-frame">
      <div className="chart-plot">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        role="img"
        aria-label={summary}
        onMouseMove={nearest}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={PAD_L} x2={VB_W - PAD_R} y1={y(tick)} y2={y(tick)} />
            <text className="chart-label" x={PAD_L - 8} y={y(tick) + 4} textAnchor="end">{formatTick(tick)}</text>
          </g>
        ))}
        <line className="chart-reorder" x1={PAD_L} x2={VB_W - PAD_R} y1={y(reorder)} y2={y(reorder)} />
        <path className="chart-area-past" d={areaPath(past, x, y)} />
        <path className="chart-area-future" d={areaPath(future, x, y)} />
        <path className="chart-past" d={linePath(past, x, y)} />
        <path className="chart-future" d={linePath(future, x, y)} />
        {todayHit >= 0 ? <line className="chart-today" x1={x(todayHit)} x2={x(todayHit)} y1={PAD_T} y2={VB_H - PAD_B} /> : null}
        {indexed.filter((point) => point.marker === "purchase").map((point) => (
          <circle key={point.date} className="chart-buy" cx={x(point.index)} cy={y(Number(point.onHand))} r="4.5" />
        ))}
        {indexed.filter((point) => point.marker === "expected").map((point) => (
          <circle key={point.date} className="chart-expected" cx={x(point.index)} cy={y(Number(point.onHand))} r="4" />
        ))}
        {todayHit >= 0 ? <circle className="chart-now" cx={x(todayHit)} cy={y(Number(indexed[todayHit].onHand))} r="4" /> : null}
        {hover ? (
          <circle className="chart-hover" cx={x(hover.index)} cy={y(Number(hover.onHand))} r="5" />
        ) : null}
        {xLabels(indexed, x, today).map((label) => (
          <text key={label.date} className="chart-label" x={label.x} y={VB_H - 12} textAnchor="middle">{label.text}</text>
        ))}
      </svg>
      {hover ? (
        <div
          className="chart-tip"
          style={{
            left: `${tipLeft * 100}%`,
            top: `${(y(Number(hover.onHand)) / VB_H) * 100}%`,
            transform: tipLeft > 0.78
              ? "translate(-100%, calc(-100% - 10px))"
              : tipLeft < 0.18
                ? "translate(0, calc(-100% - 10px))"
                : "translate(-50%, calc(-100% - 10px))",
          }}
        >
          <strong>{axisDate(hover.date)}</strong>
          <span>{hover.onHand} packs</span>
          <span>{hover.marker === "purchase" ? "Purchase" : hover.projected ? "If no further purchase" : "On hand"}</span>
        </div>
      ) : null}
      </div>
      <div className="legend">
        <span><i className="swatch actual" /> On hand</span>
        <span><i className="swatch buy" /> Purchase</span>
        <span><i className="swatch forecast" /> If no further purchase</span>
        <span><i className="swatch reorder" /> Reorder</span>
      </div>
      <table className="sr-only">
        <caption>{summary}</caption>
        <tbody>
          {indexed.filter((point) => point.marker || point.index % 7 === 0).map((point) => (
            <tr key={point.date}>
              <th scope="row">{indiaDate(point.date)}</th>
              <td>{point.onHand} packs, {point.projected ? "projected" : "recorded"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthColumns({ history, today }) {
  const width = 360;
  const height = 220;
  const padB = 52;
  const padT = 22;
  const innerH = height - padB - padT;
  const gap = 16;
  const barW = (width - 16 - gap * (history.length - 1)) / Math.max(history.length, 1);
  const max = Math.max(1, ...history.map((month) => month.packs));
  const label = history.map((month) => `${shortMonth(month.month)} ${month.packs} packs`).join(", ");
  return (
    <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Packs bought: ${label}`}>
      {history.map((month, index) => {
        const barH = Math.max((month.packs / max) * innerH, month.packs ? 4 : 2);
        const x = 8 + index * (barW + gap);
        const y = padT + innerH - barH;
        const partial = month.month === today.slice(0, 7);
        return (
          <g key={month.month}>
            <rect className={month.recorded ? "bar-ink" : "bar-empty"} x={x} y={y} width={barW} height={barH} rx="2" />
            <text className="chart-label ink" x={x + barW / 2} y={y - 6} textAnchor="middle">{month.packs}</text>
            <text className="chart-label" x={x + barW / 2} y={height - 28} textAnchor="middle">
              {partial ? `${shortMonth(month.month)} to date` : shortMonth(month.month)}
            </text>
            <text className="chart-label" x={x + barW / 2} y={height - 12} textAnchor="middle">
              {month.rate ? `${month.rate} / day` : "No purchase"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ForecastRows({ products }) {
  const max = Math.max(
    1,
    ...products.flatMap((product) => [Number(product.forecast.basisSpend), Number(product.forecast.spend || 0)]),
  );
  return (
    <div className="hbars">
      {products.map((product) => {
        const actual = Number(product.forecast.basisSpend);
        const next = product.forecast.spend == null ? null : Number(product.forecast.spend);
        return (
          <div className="hbar" key={product.productId}>
            <span className="hbar-name">{product.name}</span>
            <div className="hbar-track" aria-hidden="true">
              <i className="hbar-actual" style={{ width: `${(actual / max) * 100}%` }} />
              {next == null ? <span className="hbar-wait">Two months needed</span> : <i className="hbar-forecast" style={{ width: `${(next / max) * 100}%` }} />}
            </div>
            <span className="hbar-value">
              {rupee(product.forecast.basisSpend)}
              <small>{next == null ? "No forecast" : rupee(product.forecast.spend)}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DateRange({ range, onRange, label = "Dates" }) {
  if (!range) return null;
  return (
    <fieldset className="dates">
      <legend className="sr-only">{label}</legend>
      <label>From
        <input type="date" value={range.from} max={range.to || undefined} onChange={(event) => onRange({ ...range, from: event.target.value })} />
      </label>
      <label>To
        <input type="date" value={range.to} min={range.from || undefined} onChange={(event) => onRange({ ...range, to: event.target.value })} />
      </label>
    </fieldset>
  );
}

function inRange(date, range) {
  if (!range?.from || !range?.to) return true;
  return date >= range.from && date <= range.to;
}

function monthOverlaps(month, range) {
  if (!range?.from || !range?.to) return true;
  const start = `${month}-01`;
  const [year, mon] = month.split("-").map(Number);
  const end = new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
  return end >= range.from && start <= range.to;
}

function preferred(products) {
  return products.find((product) => product.status === "due")
    || products.find((product) => product.burnRatePerEffectiveDay)
    || products[0];
}

function shortMonth(month) {
  const [year, mon] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, mon - 1, 1)));
}

function axisDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

function formatTick(value) {
  const abs = Math.abs(value);
  if (abs >= 10) return String(Math.round(value));
  return (Math.round(value * 10) / 10).toFixed(1);
}

function ticks(min, max) {
  const span = max - min || 1;
  const rough = span / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / pow;
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  const step = nice * pow;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let value = start; value <= max + step * 0.01; value += step) out.push(Number(value.toFixed(4)));
  return out;
}

function linePath(segment, x, y) {
  if (!segment.length) return "";
  return segment
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.index).toFixed(1)} ${y(Number(point.onHand)).toFixed(1)}`)
    .join(" ");
}

function areaPath(segment, x, y) {
  if (segment.length < 2) return "";
  const first = segment[0];
  const last = segment[segment.length - 1];
  return `${linePath(segment, x, y)} L${x(last.index).toFixed(1)} ${y(0).toFixed(1)} L${x(first.index).toFixed(1)} ${y(0).toFixed(1)} Z`;
}

function xLabels(points, x, today) {
  const candidates = [];
  const push = (point, priority) => {
    if (!point) return;
    candidates.push({ date: point.date, x: x(point.index), text: axisDate(point.date), priority });
  };
  push(points[0], 2);
  push(points.find((point) => point.date === today), 0);
  push(points.find((point) => point.marker === "expected"), 1);
  push(points[points.length - 1], 3);
  const placed = [];
  for (const label of candidates.sort((a, b) => a.priority - b.priority)) {
    if (placed.some((item) => Math.abs(item.x - label.x) < 56 || item.date === label.date)) continue;
    placed.push(label);
  }
  return placed;
}
