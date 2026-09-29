"""Checks cover different receipt conventions, not vendor coordinates/templates."""
from decimal import Decimal
import pytest
from pantry.receipt_checks import amount, inspect_receipt


def line(**values):
    return {"printed": "Test item", "packs": "2", "unitPrice": "30", "lineTotal": "60", **values}


def inspect(*lines, **values):
    return inspect_receipt({"lines": list(lines), **values})


@pytest.mark.parametrize(("printed", "expected"), [
    ("₹1,23,456.78", Decimal("123456.78")), ("INR 1,234.50", Decimal("1234.5")),
    ("Rs. 12.00", Decimal("12")), (0, Decimal(0)), ("12,50", None),
    ("1e3", None), ("NaN", None), (True, None), ("2 kg", None), ("5%", None),
    ("-10", None), ("1,234,567.89", Decimal("1234567.89")), ("", None),
])
def test_money_is_strict_and_supports_indian_grouping(printed, expected):
    assert amount(printed) == expected


@pytest.mark.parametrize("printed", ["2 x", "2x", "x 2", "2 nos", "2 packs"])
def test_count_expression_is_whole_packs(printed):
    result, issues = inspect(line(packs=printed, unitPrice="30", lineTotal="60"))
    assert not issues
    assert result["lines"][0]["packs"] == 2 and result["lines"][0]["pricePerPack"] == "30.00"


def test_mixed_quantity_expression_is_not_split_into_a_guess():
    result, issues = inspect(line(packs="2 x 30", unitPrice="30", lineTotal="60"))
    assert issues and result["lines"][0]["packs"] == ""


def test_one_unused_row_is_singular():
    result, _ = inspect(line(printed="Unused", packs="", lineTotal="0"), line())
    assert "1 unused row " in result["note"]


def test_mrp_confused_with_quantity_is_cleared_without_solving_for_quantity():
    result, issues = inspect(line(packs="34", unitPrice="32.94", lineTotal="2766.96"))
    assert result["lines"][0]["packs"] == ""
    assert result["lines"][0]["pricePerPack"] == ""
    assert "do not agree" in result["lines"][0]["note"]
    assert issues


def test_wrong_quantity_header_is_rejected_even_when_arithmetic_matches():
    result, issues = inspect(line(quantitySource="MRP"))
    assert result["lines"][0]["packs"] == "" and issues


def test_unused_rows_are_removed_but_free_items_and_uncertain_rows_remain():
    result, _ = inspect(
        line(printed="Unused", packs="", lineTotal="0.00"),
        line(printed="Unused zero", packs="0", lineTotal="0"),
        line(printed="Free", packs="2", unitPrice="0", lineTotal="0"),
        line(printed="Unclear quantity", packs="?", lineTotal="0"),
        line(printed="Unclear amount", packs="", lineTotal=""),
        line(printed="Discounted free", packs="2", unitPrice="10", discount="20", lineTotal="0"),
    )
    assert [item["printed"] for item in result["lines"]] == ["Free", "Unclear quantity", "Unclear amount", "Discounted free"]
    assert result["lines"][0]["packs"] == 2 and result["lines"][0]["pricePerPack"] == "0.00"
    assert result["lines"][-1]["pricePerPack"] == "0.00"
    assert "2 unused rows" in result["note"]


@pytest.mark.parametrize("unit", ["100", "118"])
def test_net_and_tax_inclusive_rates_both_produce_paid_price(unit):
    result, issues = inspect(line(unitPrice=unit, baseAmount="200", lineTotal="236"))
    assert not issues
    assert result["lines"][0]["packs"] == 2
    assert result["lines"][0]["pricePerPack"] == "118.00"


def test_unreadable_adjustment_does_not_hide_a_shortfall():
    result, issues = inspect(line(), receiptTotal="100", adjustments=[{"label": "Tax", "amount": "5%"}])
    assert issues and "do not match" in result["note"]
    assert "Some line amounts are missing" not in result["note"]
    assert result["lines"][0]["packs"] == 2 and result["lines"][0]["pricePerPack"] == "30.00"
    assert "not a money amount" in result["note"]
    weak, weak_issues = inspect(line(unitPrice=""), receiptTotal="100", adjustments=[{"label": "Tax", "amount": "5%"}])
    assert weak_issues and weak["lines"][0]["packs"] == weak["lines"][0]["pricePerPack"] == ""
    matched, matched_issues = inspect(line(), receiptTotal="60", adjustments=[{"label": "Tax", "amount": "5%"}])
    assert matched_issues and "not a money amount" in matched["note"] and "do not match" not in matched["note"]
    assert matched["lines"][0]["packs"] == 2


def test_line_discount_and_receipt_adjustments_are_not_mistaken_for_missing_rows():
    result, issues = inspect(line(unitPrice="50", discount="10", baseAmount="90", lineTotal="94.50"),
                             receiptTotal="99.00", adjustments=[{"label": "Delivery", "amount": "5"}, {"label": "Discount", "amount": "-0.50"}])
    assert not issues and result["lines"][0]["pricePerPack"] == "47.25"
    assert "not allocated" in result["note"]


def test_a_checked_row_survives_when_another_quantity_cannot_be_checked():
    sound = line(printed="Sound", packs="2", unitPrice="30", lineTotal="60")
    weak = line(printed="Weak", packs="2", unitPrice="", lineTotal="40")
    result, issues = inspect(sound, weak, receiptTotal="150")
    assert issues
    assert result["lines"][0]["packs"] == 2 and result["lines"][0]["pricePerPack"] == "30.00"
    assert result["lines"][1]["packs"] == result["lines"][1]["pricePerPack"] == ""


def test_preliminary_row_cap_is_disclosed_without_dropping_the_checked_rows():
    rows = [line(printed=f"Item {index}", packs="1", unitPrice="1", lineTotal="1") for index in range(201)]
    result, issues = inspect(*rows)
    assert len(result["lines"]) == 200 and not issues
    assert "200" in result["note"]


def test_receipt_total_detects_missing_purchases():
    result, issues = inspect(line(), receiptTotal="100")
    assert result["lines"][0]["packs"] == 2  # a missing item does not invalidate a sound row
    assert "do not match" in result["note"] and issues


def test_simple_receipt_without_headers_or_totals_stays_reviewable():
    result, issues = inspect(line(lineTotal=""))
    item = result["lines"][0]
    assert item["packs"] == 2 and item["pricePerPack"] == "30.00"
    assert "No final line amount" in item["note"]
    assert not issues


def test_receipt_with_quantity_and_amount_but_no_rate_derives_price_not_quantity():
    result, issues = inspect(line(unitPrice="", lineTotal="75"))
    assert not issues and result["lines"][0]["pricePerPack"] == "37.50"
    assert "Check the quantity" in result["lines"][0]["note"]


def test_zero_amount_without_rate_is_reviewed_not_assumed_free():
    result, issues = inspect(line(packs="23", unitPrice="", lineTotal="0"))
    assert issues and len(result["lines"]) == 1
    assert result["lines"][0]["packs"] == result["lines"][0]["pricePerPack"] == ""
    assert "whether it was purchased" in result["lines"][0]["note"]


@pytest.mark.parametrize("present", [True, False])
def test_unverified_quantity_is_cleared_when_bill_also_has_a_discrepancy(present):
    item = line(unitPrice="")
    if not present:
        item.pop("unitPrice")
    result, issues = inspect(item, receiptTotal="100")
    assert issues and result["lines"][0]["packs"] == result["lines"][0]["pricePerPack"] == ""
    assert "quantity could not be checked" in result["lines"][0]["note"]


def test_already_discounted_rate_is_not_discounted_twice():
    result, issues = inspect(line(unitPrice="45", discount="10", baseAmount="90", lineTotal="94.50"))
    assert not issues and result["lines"][0]["packs"] == 2 and result["lines"][0]["pricePerPack"] == "47.25"


@pytest.mark.parametrize("quantity", ["", "?", "1.5", "1 kg", "500 ml", "₹2", "Rs. 2", 0, True, -2, "1000001"])
def test_missing_or_unsupported_quantity_is_never_guessed(quantity):
    result, issues = inspect(line(packs=quantity))
    assert result["lines"][0]["packs"] == ""
    assert result["lines"][0]["pricePerPack"] == "" and issues


@pytest.mark.parametrize("source", ["Quantity (kg)", "ml", "litres"])
def test_weight_or_volume_quantity_headers_require_manual_pack_conversion(source):
    result, issues = inspect(line(quantitySource=source))
    assert issues and result["lines"][0]["packs"] == ""
    assert result["lines"][0]["pricePerPack"] == "" and "weight or volume" in result["lines"][0]["note"]


def test_rounding_is_bounded_and_disclosed():
    result, issues = inspect(line(packs="3", unitPrice="33.33", lineTotal="100"))
    assert not issues and result["lines"][0]["pricePerPack"] == "33.33"
    result, issues = inspect(line(packs="7", unitPrice="14.29", lineTotal="100"))
    assert not issues and "rounded" in result["lines"][0]["note"]
    _, issues = inspect(line(packs="3", unitPrice="33.33", lineTotal="101"))
    assert issues


def test_reported_dairy_receipt_has_seven_purchases_and_reconciles():
    # Transcribed monetary evidence only; no supplier/customer identifiers.
    rows = [
        line(printed="Full cream 500 ml", packs="84", unitPrice="32.94", baseAmount="2766.96", lineTotal="2766.96"),
        line(printed="Full cream 2 L", packs="", unitPrice="128.96", lineTotal="0.00"),
        line(printed="Full cream 1 L", packs="24", unitPrice="65.88", baseAmount="1581.12", lineTotal="1581.12"),
        line(printed="Toned 500 ml", packs="12", unitPrice="27", baseAmount="324", lineTotal="324"),
        line(printed="Toned 1 L", packs="12", unitPrice="53.98", baseAmount="647.76", lineTotal="647.76"),
        line(printed="Cow milk 500 ml", packs="24", unitPrice="27.73", baseAmount="665.52", lineTotal="665.52"),
        line(printed="Dahi 400 g", packs="15", unitPrice="31.89", baseAmount="455.57", lineTotal="478.35"),
        line(printed="Paneer 200 g", packs="7", unitPrice="76.62", baseAmount="510.80", lineTotal="536.34"),
    ]
    result, issues = inspect(*rows, receiptTotal="7000.05")
    assert not issues
    assert [int(item["packs"]) for item in result["lines"]] == [84, 24, 12, 12, 24, 15, 7]
    assert sum(Decimal(item["pricePerPack"]) * int(item["packs"]) for item in result["lines"]) == Decimal("7000.05")


def test_inspection_does_not_mutate_model_evidence():
    original = line(packs="34", unitPrice="32.94", lineTotal="2766.96")
    inspect(original)
    assert original["packs"] == "34" and "pricePerPack" not in original
