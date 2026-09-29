"""Pantry math. All dates are calendar dates in Asia/Kolkata."""
import calendar
import math
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from .compat import fixed, js_round, text

INDIA = ZoneInfo("Asia/Kolkata")
NOT_ENOUGH = "The forecast will be calculated once this product has at least two calendar months of purchases."


def today_in_india(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(INDIA).date().isoformat()


def format_when(iso, now=None):
    value = now if now is not None else iso
    dt = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    dt = dt.astimezone(INDIA)
    return f"{dt.day} {('Sept' if dt.month == 9 else dt.strftime('%b'))} {dt.year}, {dt.hour % 12 or 12}:{dt.minute:02d} {'am' if dt.hour < 12 else 'pm'}"


def add_days(iso, days):
    return (date.fromisoformat(iso) + timedelta(days=days)).isoformat()


def weekday(iso):
    return (date.fromisoformat(iso).weekday() + 1) % 7


def day_weight(iso, weekend_weight):
    return weekend_weight if weekday(iso) in (0, 6) else 1


def round4(n):
    return js_round(n * 10000) / 10000


def round_half_up(value, decimals):
    factor = 10 ** decimals
    n = value * factor
    if not math.isfinite(n):
        return value
    base = math.floor(abs(n))
    fraction = abs(n) - base
    rounded = base + 1 if fraction > .5 or abs(fraction - .5) < 1e-8 else base
    return (-1 if n < 0 else 1) * rounded / factor


def each_date(start, end):
    if not start or not end or end < start:
        return []
    return [add_days(start, i) for i in range((date.fromisoformat(end) - date.fromisoformat(start)).days + 1)]


def effective_days(start, end, weekend_weight):
    total = 0
    for day in each_date(start, end):
        total = round4(total + day_weight(day, weekend_weight))
    return total


def month_bounds(month):
    year, mon = map(int, month.split("-"))
    return {"start": month + "-01", "end": f"{month}-{calendar.monthrange(year, mon)[1]}"}


def shift_month(month, delta):
    year, mon = map(int, month.split("-"))
    year, mon = divmod(year * 12 + mon - 1 + delta, 12)
    return f"{year:04d}-{mon + 1:02d}"


def lookback_months(anchor_month, count):
    return [shift_month(anchor_month, -i) for i in reversed(range(count))]


def money(packs, price):
    return fixed(packs * js_round(float(price) * 100) / 100)


def add_money(values):
    return fixed(sum(js_round(float(v) * 100) for v in values) / 100)


def shelf_state(purchases, counts, today):
    active = [r for r in purchases if not r.get("deletedAt") and r["purchasedOn"] <= today]
    active_counts = [r for r in counts if not r.get("deletedAt") and r["countedOn"] <= today]
    anchor = max(active_counts, key=lambda r: r["countedOn"], default=None)
    added = [r for r in active if r["purchasedOn"] > anchor["countedOn"]] if anchor else active
    return active, anchor, (anchor["packs"] if anchor else 0) + sum(r["packs"] for r in added)


def packs_by_date(rows):
    bought = {}
    for row in rows:
        bought[row["purchasedOn"]] = bought.get(row["purchasedOn"], 0) + row["packs"]
    return bought


def walk_on_hand(packs, start, end, purchases, burn, weekend_weight):
    bought = packs_by_date(purchases)
    qty = packs
    for day in each_date(start, end):
        qty = round4(qty + bought.get(day, 0))
        qty = round4(qty - burn * day_weight(day, weekend_weight))
    return qty


def project_run_out(*, today, onHand, burn, reorderLevel, weekendWeight, closedWeekdays=0):
    shown = float(onHand)
    if not burn or float(burn) <= 0 or shown <= reorderLevel:
        return {"expectedDate": today, "coverEffectiveDays": "0.0"}
    need = (shown - reorderLevel) / float(burn)
    cover = round_half_up(need, 1)
    walked = 0
    expected = add_days(today, 1)
    closed_left = closedWeekdays
    for _ in range(4000):
        weekend = weekday(expected) in (0, 6)
        weight = weekendWeight if weekend else 1
        if not weekend and closed_left > 0:
            weight = 0
            closed_left -= 1
        walked = round4(walked + weight)
        if walked + 1e-9 >= need:
            break
        expected = add_days(expected, 1)
    return {"expectedDate": expected, "coverEffectiveDays": fixed(cover, 1)}


def compute_product(*, product, purchases, counts, settings, today):
    active, anchor, shelf = shelf_state(purchases, counts, today)
    consumption = [r for r in active if r["purchasedOn"] <= anchor["countedOn"]] if anchor else active
    recorded = []
    for month in lookback_months(today[:7], settings["lookbackMonths"]):
        bounds = month_bounds(month)
        end = min(bounds["end"], today)
        rows = [r for r in consumption if bounds["start"] <= r["purchasedOn"] <= end]
        if rows:
            recorded.append({"month": month, "packs": sum(r["packs"] for r in rows), "effectiveDays": effective_days(bounds["start"], end, settings["weekendWeight"])})
    base = {"reorderLevel": product["reorderLevel"], "warningEffectiveDays": product["warningEffectiveDays"]}
    empty = {**base, "onHand": fixed(shelf), "burnRatePerEffectiveDay": None, "expectedDate": None, "coverEffectiveDays": None, "status": "not_enough_history", "message": NOT_ENOUGH, "trace": None}
    if len(recorded) < 2:
        return empty
    packs = sum(m["packs"] for m in recorded)
    days = round4(sum(m["effectiveDays"] for m in recorded))
    burn = round_half_up(packs / days, 2) if days else None
    trace = {"months": [m["month"] for m in recorded], "packs": packs, "effectiveDays": text(days)}
    if not burn:
        return {**empty, "trace": trace}
    later = [r for r in active if r["purchasedOn"] > anchor["countedOn"]] if anchor else []
    on_hand = walk_on_hand(anchor["packs"], add_days(anchor["countedOn"], 1), today, later, burn, settings["weekendWeight"]) if anchor else round4(shelf - burn * effective_days(today, today, settings["weekendWeight"]))
    shown = round_half_up(on_hand, 2)
    projected = project_run_out(today=today, onHand=shown, burn=burn, reorderLevel=product["reorderLevel"], weekendWeight=settings["weekendWeight"])
    expected = projected["expectedDate"]
    due = shown <= product["reorderLevel"] or (expected != today and effective_days(add_days(today, 1), expected, settings["weekendWeight"]) <= product["warningEffectiveDays"])
    return {**base, "onHand": fixed(shown), "burnRatePerEffectiveDay": fixed(burn), "expectedDate": today if shown <= product["reorderLevel"] else expected, "coverEffectiveDays": "0.0" if shown <= product["reorderLevel"] else projected["coverEffectiveDays"], "status": "due" if due else "on_track", "message": None, "trace": trace}


def next_month_frame(settings, today):
    month = shift_month(today[:7], 1)
    bounds = month_bounds(month)
    return {"month": month, "effectiveDays": text(round4(effective_days(bounds["start"], bounds["end"], settings["weekendWeight"])))}


def month_history(purchases, settings, today):
    history = []
    for month in lookback_months(today[:7], settings["lookbackMonths"]):
        bounds = month_bounds(month)
        end = min(bounds["end"], today)
        rows = [r for r in purchases if not r.get("deletedAt") and bounds["start"] <= r["purchasedOn"] <= end]
        packs = sum(r["packs"] for r in rows)
        days = round4(effective_days(bounds["start"], end, settings["weekendWeight"]))
        rate = round_half_up(packs / days, 2) if rows and days > 0 else None
        history.append({"month": month, "packs": packs, "spend": add_money([money(r["packs"], r["pricePerPack"]) for r in rows]), "effectiveDays": text(days), "rate": fixed(rate) if rate is not None else None, "recorded": bool(rows)})
    return history


def weighted_average(rows):
    packs = sum(float(r["packs"]) for r in rows)
    paise = sum(float(r["packs"]) * js_round(float(r["pricePerPack"]) * 100) for r in rows)
    return fixed(round_half_up(paise / packs, 0) / 100) if packs else None


def scale_money(packs, price_per_pack):
    return fixed(round_half_up(float(packs) * js_round(float(price_per_pack) * 100), 0) / 100)


def project_month(*, purchases, math, settings, today, basisPacks, basisSpend):
    frame = next_month_frame(settings, today)
    result = {**frame, "packs": None, "spend": None, "averagePricePerPack": None, "basisMonth": today[:7], "basisPacks": basisPacks, "basisSpend": basisSpend}
    if not math["burnRatePerEffectiveDay"] or not math["trace"]:
        return result
    months = set(math["trace"]["months"])
    rows = [r for r in purchases if not r.get("deletedAt") and r["purchasedOn"] <= today and r["purchasedOn"][:7] in months]
    average = weighted_average(rows)
    packs = round_half_up(float(math["burnRatePerEffectiveDay"]) * float(frame["effectiveDays"]), 2)
    return {**result, "packs": fixed(packs), "averagePricePerPack": average, "spend": scale_money(packs, average) if average is not None else None}


def stock_series(*, purchases, counts, settings, today, burnRate, expectedDate, onHand=None):
    if burnRate is None or float(burnRate) == 0:
        return []
    burn, weight = float(burnRate), settings["weekendWeight"]
    active, anchor, _ = shelf_state(purchases, counts, today)
    active_counts = [r for r in counts if not r.get("deletedAt") and r["countedOn"] <= today]
    anchor_date = anchor["countedOn"] if anchor else None
    since = add_days(anchor_date, 1) if anchor_date else today
    end = max(add_days(expectedDate if expectedDate and expectedDate > today else today, 7), add_days(since, 14))
    end = max(min(end, add_days(today, 45)), since)
    count_packs = {r["countedOn"]: r["packs"] for r in active_counts}
    bought_on = packs_by_date([r for r in active if r["purchasedOn"] not in count_packs and (not anchor_date or r["purchasedOn"] < anchor_date)])
    bought_after = packs_by_date([r for r in active if anchor_date and r["purchasedOn"] > anchor_date])
    points = []
    if anchor_date and bought_on:
        window_start = lookback_months(today[:7], settings["lookbackMonths"])[0] + "-01"
        start = max(add_days(min(bought_on), -1), window_start)
        opening = max((r for r in active_counts if r["countedOn"] <= start and r["packs"] > 0), key=lambda r: r["countedOn"], default=None)
        qty = opening["packs"] if opening else 0
        for day in each_date(start, add_days(anchor_date, -1)):
            bought = bought_on.get(day, 0)
            if day in count_packs:
                qty = count_packs[day]
            elif bought:
                qty = round4(qty + bought)
            baseline = day == start and not bought and day not in count_packs
            if not baseline and day not in count_packs:
                qty = round4(qty - burn * day_weight(day, weight))
            point = {"date": day, "onHand": fixed(round_half_up(qty, 2)), "projected": False}
            if bought:
                point["marker"] = "purchase"
            elif day in count_packs:
                point["marker"] = "count"
            points.append(point)
    qty = anchor["packs"] if anchor else 0
    if anchor:
        points.append({"date": anchor_date, "onHand": fixed(qty), "projected": False, "marker": "today" if anchor_date == today else "count"})
    for day in each_date(since, end):
        added = bought_after.get(day, 0) if day <= today else 0
        if added:
            qty = round4(qty + added)
        qty = round4(qty - burn * day_weight(day, weight))
        point = {"date": day, "onHand": fixed(round_half_up(qty, 2)), "projected": day > today}
        if added:
            point["marker"] = "purchase"
        elif day == today:
            point["marker"] = "today"
        elif day == expectedDate:
            point["marker"] = "expected"
        points.append(point)
    return points


def month_figures(purchases, month):
    rows = [r for r in purchases if not r.get("deletedAt") and r["purchasedOn"].startswith(month)]
    ordered = sorted(rows, key=lambda r: (r["purchasedOn"], r.get("createdAt", "")), reverse=True)
    return {"packsAdded": sum(r["packs"] for r in rows), "spend": add_money([money(r["packs"], r["pricePerPack"]) for r in rows]), "latestPricePerPack": ordered[0]["pricePerPack"] if ordered else None}
