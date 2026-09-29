"""Conservative checks of transcribed receipt evidence, independent of layout.

Arithmetic can disprove an extraction; it cannot prove that a printed number
was read correctly. Never solve for a missing quantity or force a bill to balance.
"""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re

CENT = Decimal("0.01")


def amount(value, *, signed=False):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    value = str(value).strip()
    if len(value) > 40:
        return None
    value = re.sub(r"(?i)\b(?:inr|rs)\.?", "", value.replace("₹", "")).strip()
    # Support Indian/Western grouping, but do not reinterpret decimal commas,
    # units, percentages, exponents, or OCR substitutions as money.
    if not re.fullmatch(r"[+-]?(?:\d+|\d{1,3}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", value):
        return None
    try:
        number = Decimal(value.replace(",", ""))
    except InvalidOperation:
        return None
    return number if number.is_finite() and abs(number) <= Decimal("1000000000000") and (signed or number >= 0) else None


def money(value):
    return str(value.quantize(CENT, rounding=ROUND_HALF_UP))


_PACK_WORD = r"x|qty|quantity|nos|no|pcs|pc|units?|packs?"
_PACK_EXPRESSION = re.compile(rf"(?:(?:{_PACK_WORD})\s*)?(\d{{1,7}})(?:\s*(?:{_PACK_WORD}))?", re.I)
_MEASURED_QUANTITY = re.compile(r"\b(?:kg|gm|g|grams?|kilograms?|ml|millilit(?:er|re)s?|lit(?:er|re)s?|ltr|l)\b", re.I)


def pack_count(value):
    """Whole packs, including a count written as '2 x' or '2 nos'.

    A weight, volume, price or mixed expression such as '2 x 30' is not a
    pack count. The number is not chosen from among several numbers.
    """
    if isinstance(value, bool) or value is None:
        return None
    if not isinstance(value, str):
        return amount(value)
    text = value.strip()
    if re.search(r"[₹%]", text) or re.search(r"(?i)\brs\.?\b", text) or _MEASURED_QUANTITY.search(text):
        return None
    if not re.search(r"[A-Za-z]", text):
        return amount(text)
    match = _PACK_EXPRESSION.fullmatch(text)
    return amount(match.group(1)) if match else None


def inspect_receipt(payload):
    """Return a copy with safe proposals, review notes and bounded retry reasons.

Old draft/model fields remain readable. New extraction separates the printed
unit rate from the paid price that this application derives when possible.
"""
    if not isinstance(payload, dict):
        return payload, ["No receipt object was returned."]
    result = dict(payload)
    lines = []
    issues = []
    omitted = 0
    totals = []
    units = []
    rates = 0
    raw_lines = payload.get("lines") if isinstance(payload.get("lines"), list) else []
    row_cap = len(raw_lines) > 200
    for index, raw in enumerate(raw_lines[:200]):
        if not isinstance(raw, dict) or not raw.get("printed"):
            continue
        line = dict(raw)
        raw_quantity = raw.get("packs")
        quantity = pack_count(raw_quantity)
        unit = amount(raw.get("unitPrice", raw.get("pricePerPack")))
        total = amount(raw.get("lineTotal"))
        base = amount(raw.get("baseAmount"))
        discount = amount(raw.get("discount"))
        notes = []
        # An empty quantity with a zero amount is an unused catalogue row.
        # Positive quantities at zero cost can be real free/discounted items.
        empty_quantity = raw.get("packs") in (None, "") or quantity == 0
        if empty_quantity and total == 0:
            omitted += 1
            continue
        totals.append(total)
        units.append(unit)
        rates += unit is not None
        whole = quantity is not None and 0 < quantity <= 1_000_000 and quantity == quantity.to_integral_value()
        if whole:
            line["packs"] = int(quantity)
        else:
            line["packs"] = ""
            notes.append("Check the quantity on the receipt and enter whole packs.")
            issues.append(f"Line {index + 1}: quantity is missing, zero, fractional or unreadable. Read it directly; do not calculate it from prices.")
        source = str(raw.get("quantitySource") or "")[:120]
        wrong_column = bool(re.fullmatch(r"\s*(?:mrp|m\.?r\.?p\.?|rate|landing\s+rate|unit\s+price|price|amount|sl\.?\s*no\.?)\s*", source, re.I))
        if wrong_column:
            line["packs"] = ""
            notes.append("The quantity was read from a price or serial-number column. Enter packs from the receipt.")
            issues.append(f"Line {index + 1}: quantity came from {source}, not a quantity field.")
        if re.search(r"\b(?:kg|gm|g|grams?|kilograms?|ml|millilit(?:er|re)s?|lit(?:er|re)s?|ltr|l)\b", source, re.I):
            wrong_column = True
            line["packs"] = ""
            notes.append("The quantity is shown as weight or volume. Enter the number of purchased packs.")
            issues.append(f"Line {index + 1}: quantity is measured in weight or volume. Do not convert it to packs without explicit evidence.")
        conflict = False
        # Rates can be net or tax inclusive. Match either printed amount, with
        # a half-paisa per-unit allowance for printed rate rounding.
        if whole and unit is not None and (total is not None or base is not None):
            expected = quantity * unit
            tolerance = quantity * Decimal("0.005") + CENT
            candidates = [value + reduction for value in (total, base) if value is not None for reduction in (0, discount or 0)]
            conflict = not any(abs(expected - value) <= tolerance for value in candidates)
            if conflict:
                line["packs"] = ""
                notes.append("Quantity, unit price and line amount do not agree. Check packs and price on the receipt.")
                issues.append(f"Line {index + 1}: quantity × printed unit rate is {money(expected)}, but the printed line amounts differ. Recheck columns, discounts and taxes.")
        unconfirmed_free = whole and total == 0 and unit is None
        if unconfirmed_free:
            line["packs"] = ""
            notes.append("This zero-amount row has no readable unit rate. Check whether it was purchased or discard it.")
            issues.append(f"Line {index + 1}: positive quantity with zero amount but no unit rate. Check for an unused row or an explicitly free item.")
        if whole and not wrong_column and not conflict and not unconfirmed_free and total is not None:
            line["pricePerPack"] = money(total / quantity)
            if abs(Decimal(line["pricePerPack"]) * quantity - total) > CENT:
                notes.append("Price per pack is rounded to two decimals; the purchase amount may differ slightly from the receipt.")
        elif conflict or wrong_column or not whole or unconfirmed_free:
            # Deriving a unit price from an untrusted quantity hides the error.
            line["pricePerPack"] = ""
        else:
            line["pricePerPack"] = money(unit) if unit is not None else ""
        if total is None:
            notes.append("No final line amount could be read. Check quantity and price against the receipt.")
        elif unit is None and whole and not unconfirmed_free and not wrong_column:
            notes.append("No unit rate could be read. Check the quantity; price was calculated from the line amount.")
        line["lineTotal"] = money(total) if total is not None else ""
        line["note"] = " ".join(notes) or None
        lines.append(line)
    result["lines"] = lines
    receipt_total = amount(payload.get("receiptTotal"))
    result["receiptTotal"] = money(receipt_total) if receipt_total is not None else ""
    notes = []
    if row_cap:
        notes.append("Only the first 200 transcribed rows were checked.")
    if omitted:
        noun = "row" if omitted == 1 else "rows"
        notes.append(f"Left out {omitted} unused {noun} with no quantity and a zero amount.")
    adjustments = payload.get("adjustments")
    adjustment_values = [amount(item.get("amount"), signed=True) if isinstance(item, dict) else None for item in adjustments] if isinstance(adjustments, list) else []
    balanced = False
    if receipt_total is not None:
        notes.append(f"Receipt total: ₹{money(receipt_total)}.")
        lines_ready = bool(totals) and all(value is not None for value in totals)
        adjustments_ready = all(value is not None for value in adjustment_values)
        tolerance = max(CENT * len(totals), Decimal("0.02")) if totals else Decimal("0.02")
        # A percentage or other non-money adjustment is not converted and cannot
        # stand in for a missing line. The bill stays unchecked.
        if lines_ready and adjustments_ready:
            difference = sum(totals) + sum(adjustment_values) - receipt_total
            balanced = abs(difference) <= tolerance
        short = False
        if lines_ready and not adjustments_ready:
            readable = [value for value in adjustment_values if value is not None]
            short = abs(sum(totals) + sum(readable) - receipt_total) > tolerance
        if lines_ready and (not adjustments_ready or not balanced):
            if adjustments_ready or short:
                notes.append("The extracted line amounts do not match the receipt total. Check for missing items, taxes, discounts or charges before adding purchases.")
                issues.append("Line amounts plus printed receipt adjustments do not match the receipt total. Re-read every purchased line and the total; do not invent amounts to balance it.")
            if not adjustments_ready:
                notes.append("A printed adjustment is not a money amount, so the receipt total could not be checked.")
                issues.append("A printed adjustment is not a money amount. Re-read every purchased line and the total; do not invent an amount to balance the receipt.")
            # Missing rates can be legitimate. Together with a known bill
            # discrepancy, however, those quantities have no corroboration.
            # Keep the items for review without proposing unverified stock.
            for line, unit in zip(lines, units):
                if line.get("packs") and unit is None:
                    line["packs"] = line["pricePerPack"] = ""
                    line["note"] = "The receipt total does not match and this quantity could not be checked. Enter packs and price from the receipt."
        elif not lines_ready:
            notes.append("Some line amounts are missing, so the receipt total could not be checked.")
    if any(value for value in adjustment_values):
        notes.append("The receipt has separate taxes, discounts or charges. These are not allocated to the prices below; review prices before adding purchases.")
    if not lines:
        issues.append("No purchased lines were read. Check the entire receipt.")
    result["note"] = " ".join(notes) or None
    result["_checks"] = {"amounts": sum(value is not None for value in totals), "rates": rates, "balanced": balanced}
    return result, issues
