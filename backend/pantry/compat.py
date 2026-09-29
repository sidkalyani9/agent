"""Wire-format helpers for the existing JavaScript API's numeric contracts."""
import json
import math
from decimal import Decimal, ROUND_HALF_UP


def loads(value):
    # JSON.parse rejects these non-JSON constants; Python accepts them by default.
    def reject_constant(value):
        raise ValueError(f"Invalid JSON constant: {value}")
    return json.loads(value, parse_constant=reject_constant)


def js_length(value):
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def text(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return str(int(value)) if value == int(value) else str(value)
    if isinstance(value, list):
        return ",".join("" if v is None else text(v) for v in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def number(value):
    if value is None:
        return 0.0
    if isinstance(value, (list, dict)):
        value = text(value)
    try:
        if isinstance(value, str):
            value = value.strip()
            if not value:
                return 0.0
            if value.lower().startswith(("0x", "0b", "0o")):
                return float(int(value, 0))
        return float(value)
    except (ValueError, TypeError, OverflowError):
        return float("nan")


def fixed(value, digits=2):
    value = float(value)
    if value == 0:
        value = 0.0
    return format(Decimal.from_float(value).quantize(Decimal(10) ** -digits, rounding=ROUND_HALF_UP), f".{digits}f")


def js_round(value):
    return math.floor(value + 0.5)


def dumps(value):
    # Node JSON.stringify emits integral numbers without a decimal point.
    def normalize(v):
        if isinstance(v, float):
            return None if not math.isfinite(v) else int(v) if v.is_integer() else v
        if isinstance(v, dict):
            return {k: normalize(x) for k, x in v.items()}
        if isinstance(v, list):
            return [normalize(x) for x in v]
        return v
    return json.dumps(normalize(value), separators=(",", ":"), ensure_ascii=False)
