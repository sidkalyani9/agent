# Receipt extraction and review

The Record → Receipt tab uses the configured model to transcribe a receipt, then checks the printed evidence before proposing purchases. It does not use a supplier template, fixed column positions, product-specific quantity rules, or a second OCR service.

## Handoff status — stopped at the user's request

Implementation and testing stopped on 30 September 2026 because the user wanted to conserve their remaining usage. This document records the finished work and unfinished concerns so the next session can continue without repeating the investigation.

**The safeguards are implemented and the automated tests pass. Reliable automatic extraction of the supplied invoice is NOT established.** Live results remain inconsistent. The final live run returned 19 review rows with every quantity and price blanked by the checks, rather than the seven correctly populated purchases needed. This is a safer failure, but it is not a completed accuracy fix.

No model/provider change, dependency addition to the app, database migration, commit, or deployment was performed. Existing saved purchases were not changed. Existing receipt drafts are not automatically re-read: clear the old draft and upload again to exercise the new extraction.

### Completed work

| File | Completed changes |
| --- | --- |
| `backend/pantry/receipt_read.py` | Preserve image pixels irrespective of DPI metadata; improve bounded PDF/JPEG rendering; supplement native PDFs with text; request separate printed evidence; one checked reread with overlapping full-width views; larger output budget; reject truncated responses and HTTP-200 provider error objects; expose review notes and printed amounts; preserve existing draft/edit/save flow. |
| `backend/pantry/receipt_checks.py` | New layout-independent decimal checks, unused-row filtering, paid unit-price calculation, rounding notes, quantity-source/weight/volume checks, total reconciliation, and blanking of contradictory or unsupported proposals. No quantity is solved from prices. |
| `frontend/src/components/RecordPanel.jsx` | Show printed line amounts using the existing INR formatter and show per-line review notes. |
| `backend/tests/test_receipt_checks.py` | Generic arithmetic/evidence cases plus an anonymized transcription of the reported invoice. |
| `backend/tests/test_receipt_read.py` | Image/PDF handling, reread quality/failure cases, provider failures, truncation, draft persistence, manual correction and saving. |
| `frontend/tests/e2e.mjs` | Check amount/note rendering and actual receipt-control/note bounds at 390px, in addition to the existing workflows. |
| `AGENTS.md` | Link this document and describe the evidence-checking boundary. |

The original 768 × 1024 uploaded image was previously rendered at 576 × 768 because image DPI was mistaken for pixel size. That specific preprocessing defect is fixed without using invoice-specific coordinates.

### Verification completed

- Latest full backend suite: **280 passed**, including real isolated PostgreSQL and packaged runtime tests. It finished in 13.24 seconds. Five PyMuPDF/SWIG deprecation warnings remain; there were no test failures or skipped tests in this run.
- Frontend production build passed with Node 24.21.0.
- Browser suite passed, including receipt review, product selection, other record/stock workflows, access/auth flows, and 390px layout. Its final run includes the new element-bounds assertion. The last subsequent edits were backend checks/tests, covered by the full 280-test run.
- Opened the actual development UI at `http://127.0.0.1:5173/` using an isolated disposable API via Playwright request routing; real pantry data was not modified. Exercised receipt review at desktop/390px and navigation back to Stock.
- The last whitespace check passed. The two commands outstanding when the user requested stopping had already completed; only their outputs were collected during handoff. No additional live calls or tests were started after that request.
- Default shell Node was version 23; verification used the temporary npm-cached Node 24 binary at `/Users/siddharthkalyani/.npm/_npx/387698761821791d/node_modules/node/bin`. Prefer any available Node 24 installation when resuming; this cache path is not a project dependency.

Unit tests using transcribed values or mocked model responses prove the handling of those values. They do **not** prove OCR accuracy on an actual scanned image.

### Live observations, including failures

| Case | Observed result |
| --- | --- |
| Supplied invoice, earlier run | Six purchased rows had correct quantities `84, 24, 12, 12, 24, 15`. The paneer row was missing, and reconciliation correctly flagged the discrepancy. |
| Synthetic simple slip, no table headers | Correct quantities `2, 3, 1`, prices `30.00, 45.00, 42.00`, and total `237.00`. It used quantity/rate expressions as some item descriptions; the `printed` field instructions were subsequently clarified, but that exact case was not rerun afterwards. |
| Synthetic scanned PDF with amount-first/reordered columns | Live request failed at the provider. No conclusion about extraction accuracy can be drawn from this attempt. Scanned-PDF rendering and API flow passed automated tests. |
| Provider capacity | Some requests returned HTTP 200 with an error object stating Nvidia's worker request limit was exhausted (`16/16`). This previously looked like an empty model message; it now becomes a proper receipt-read failure. Other requests succeeded, so availability was intermittent. |
| Supplied invoice, final run on the latest code | Two model calls, 78.1 seconds, 19 retained review rows, all quantities/prices blank. Rates were unreadable/missing in the response, zero-amount rows had proposed positive quantities, and receipt adjustments/total did not reconcile. The safeguards correctly prevented those proposals being populated as purchases, but the reread did not produce a usable automatic result. |
| Date interpretation | The final run returned `2025-02-09` for the printed `2/9/2025`; the intended Indian interpretation is `2025-09-02`. Earlier output read it correctly. This remains unresolved. |

For future comparison, the supplied invoice's seven purchased rows are:

| Item | Packs | Paid price per pack | Printed final amount |
| --- | ---: | ---: | ---: |
| Full cream milk 500 ml | 84 | 32.94 | 2766.96 |
| Full cream milk 1 L | 24 | 65.88 | 1581.12 |
| Toned milk 500 ml | 12 | 27.00 | 324.00 |
| Toned milk 1 L | 12 | 53.98 | 647.76 |
| Cow milk 500 ml | 24 | 27.73 | 665.52 |
| Dahi 400 g pouch | 15 | 31.89 | 478.35 |
| Paneer 200 g | 7 | 76.62 | 536.34 |

The total is **INR 7000.05**. Use these as a regression example only, never as production extraction rules.

### Follow-up on 30 September 2026 — stopped on purpose

The follow-up kept the same model. It did not add a supplier template, a column coordinate, or another OCR service. The required tool fields were reduced to the printed date, description, quantity, selling rate and line amount. A count written as `2 x` or `2 nos` is accepted. A weight, a volume, or a mixed expression such as `2 x 30` is still not guessed. Ambiguous numeric dates are read as day/month/year and the review says so. A reread may correct lines, but a different receipt total does not replace the first total. A failed or expired reread returns the first checked draft. More than 200 transcribed rows, a missing date, and a PDF text failure are disclosed or ignored rather than failing a readable image.

Stopping rule used for live calls: at most one confirmation round after a generic code defect, on a fixed set (clean till slip, amount-before-quantity table, line discount plus footer tax, and the supplied invoice). Stop if a clean slip still yields no usable lines, if two or more receipts stay under half their purchased lines, if the provider blocks the evidence, or if the next idea would encode one bill. That rule fired after the confirmation round. Do not keep tuning this model against the dairy invoice.

| Case | Result |
| --- | --- |
| Clean slip, `2 x rate` | First call copied `2 x` and the checks blanked it. After the count-expression fix, one call returned packs `2, 3, 1`, prices `30.00, 45.00, 42.00`, and total `237.00`. The model omitted the date. |
| Amount, then quantity, then rate | Packs `4` and `2`, prices `20.00` and `15.00`, total `110.00`, date `2026-03-18`. The zero-amount spare row was left out. |
| Line discount and footer tax | Packs `2` and `1`, paid prices `25.00` and `35.00`, total `90.00`. The tax lines were disclosed and not allocated. The model omitted the date. The first provider call failed and the retry succeeded. |
| Supplied invoice | The provider failed twice with no body, then a later pair of calls succeeded. The kept draft had the correct total `7000.05`, omitted 14 zero-amount catalogue rows, and populated five purchased rows: full cream 1 L `24`, toned 500 ml `12`, toned 1 L `12`, cow 500 ml `24`, dahi 400 g `15`, with the paid prices in the regression table above. Full cream 500 ml kept the printed amount `2766.96` but the quantity `1` contradicted it, so packs and price were blanked. Paneer's amount was attached to a mislabeled row and blanked. One extra internally consistent row remained, and the total check flagged it. |
| Reread of that invoice | The second call did read full cream 500 ml as `84` at `32.94`, and it copied `2/9/2025`, which the date rule stored as `2025-09-02`. It also changed the dahi line amount from `478.35` to `11.39` and dropped the paneer amount. That reread was rejected. The safer first draft was kept, including its missing date. This is the intended tradeoff: a reread does not win by discarding monetary evidence. |

Five populated purchased rows, with two amounts held for manual quantity entry, is a better draft than the earlier all-blank result. It is not reliable automatic entry. The model still misses dates, mislabels a row, and can return a second reading that repairs one line while damaging another. Further prompt edits would be fitting this invoice. Human review stays required. A stronger model can use the same tool shape later.

Backend suite after these changes, including the later review fixes for date labels, year-first month names, non-money adjustments and manufactured reread balances: **320 passed** in 14.35 seconds, including PostgreSQL and packaged runtime tests. The same five PyMuPDF warnings remain. After the mobile column fix, `npm run test:browser` passed on Node 24.21.0, including receipt review and the 390px bounds check. That run served `frontend/dist`, which includes the wrap rule and the sentence that editing packs or price does not redo the check. No further live model round was run. No commit or deployment was made. Clear an old receipt draft and upload again to exercise the new extraction.

What remains, and why it was not changed:

- Low-resolution, skewed, handwritten and multi-page receipts were not added to the live set. The four cases above were enough to hit the stop rule.
- Percentage discounts are still not converted into money. An unreadable adjustment now leaves the total unchecked instead of hiding a shortfall. There is no allocation workflow.
- The original reading note remains after a person edits packs or price. The screen says the check is not redone. A missing purchased row is still added from Purchase. No side-by-side image or add-line control was added.
- A misread first total is kept when a reread proposes another total, even if the first total was wrong. A reread also cannot add an adjustment or replace a line amount to clear that warning. Replacing the first total is indistinguishable from hiding a missing row.
- Product lookup can still add latency inside the same 210-second deadline. No separate retry budget was added.

### Local artifacts and unrelated workspace state

- Original user-supplied image: `/Users/siddharthkalyani/Downloads/1.png`. It was not copied into version control.
- Temporary live evidence, if still present: `/tmp/pantry-receipt-model.json`, `/tmp/pantry-receipt-reread.json`, `/tmp/pantry-receipt-details-model.json`, `/tmp/pantry-receipt-live-cases.json`, `/tmp/pantry-final-receipt-model-1.json`, `/tmp/pantry-final-receipt-model-2.json`, `/tmp/pantry-final-receipt-eval.json`, `/tmp/pantry-resume-eval.json`, and `/tmp/pantry-resume-eval-2.json`. The final pair contains raw model messages; the evaluation files contain checked drafts. These may contain receipt content; do not commit them. Some earlier files contain failed or empty responses. The resume pair is the follow-up above: round 1, then the confirmation round after the count-expression fix.
- Temporary screenshots: `/tmp/pantry-receipt-5173-desktop.png`, `/tmp/pantry-receipt-5173-mobile.png`, `/tmp/pantry-receipt-mobile-width-check.png`, and browser-suite `pantry-receipt-*-review.png` files in the system temporary directory. These use disposable fixture accounts.
- `git status` shows deletion of `documents/PYTHON_MIGRATION.md`. This was not part of the receipt work. The deletion is already staged. Do not restore the file, and do not include that deletion in a receipt commit, without checking the user's intent. `AGENTS.md` still references that document.
- The finished follow-up is the worktree compared with `HEAD` (`git diff HEAD`). The index is an earlier snapshot: it does not contain the count-expression parser, the printed-date rules, the pinned reread total, or the mobile `minmax(0, 1fr)` rule. `frontend/src/styles.css` is unstaged only. `frontend/dist/` is gitignored; browser checks serve that build, so a CSS or script change needs `npm run build` before `npm run test:browser`. Nothing in this follow-up was committed.

## Input

- PDF, PNG and JPEG follow the existing upload and access rules. Only the first four PDF pages are read; the review shows a note when pages are omitted.
- Images retain their native pixel dimensions up to a 2,400-pixel long edge. DPI metadata must not accidentally shrink a photo. PDF pages are rendered at up to 300 DPI with the same size limit.
- Rendering stays in memory using the existing PyMuPDF dependency. Each JPEG is capped at 2 MB, with compression and downscaling when necessary.
- Native PDF text supplements the images, bounded to 24,000 characters. If text extraction fails after the page image exists, the image reading continues without that text. Scanned PDFs and photos work through the image path; embedded text is not required or treated as authoritative column ordering.

## Extraction and checks

The tool asks for the printed date, the product description, the purchased quantity, the selling rate and the final line amount. A quantity heading, a pre-tax amount and a monetary row discount are optional evidence, copied only when those labels are printed. Blank evidence stays blank. MRP, product size, tax percentages and serial numbers are not quantities. Unmatched purchased products remain available for review.

The printed date is copied as text and interpreted in code. A leading Date, Dated, Invoice Date, or Bill Date label is removed first, longest label first. A numeric date with no month name uses day/month/year when both orders are possible, and the review says so. A month name, a day greater than 12, a year-first number, or a year followed by a month name is not swapped. An ISO date with no printed source is kept as returned. Two-digit years are not guessed. A date after today in India is left blank.

The server uses decimal arithmetic and these conservative rules:

- Omit a row only when its quantity is blank or explicitly zero and its printed final amount is zero. Keep positive-quantity free items and uncertain rows.
- Never derive a missing quantity from an amount and price. The pantry requires positive whole packs. A count written as `2 x`, `2 nos` or `2 packs` is that count. A weight, a volume, or a mixed expression such as `2 x 30` is not split into a guess. Fractional quantities need manual interpretation.
- When no usable purchase date was read, the review says so. It does not invent one.
- When quantity, rate and amounts are available, check multiplication against the printed net or final amount. Allow explicitly printed line discounts and a half-paisa per unit plus one paisa for rate rounding. Rates may already include tax or discount.
- Clear contradictory quantity and price proposals. When the quantity has no contradiction and a final line amount is available, derive paid price per pack from that amount. This is not proof that OCR read the quantity correctly; missing supporting rate evidence is disclosed.
- Keep zero-amount rows with positive quantities but no readable rate for manual review, with quantity and price blank. They are not automatically assumed to be free purchases. Also clear uncorroborated quantities when the bill total itself does not reconcile.
- Check the sum of printed line amounts and separate bill adjustments against the receipt total when enough evidence exists. A discrepancy triggers review for missing lines, taxes, discounts or charges. Do not invent a balancing amount or allocate bill-level adjustments across products.
- If checks find contradictions or missing quantities, make at most one independent reread using overlapping, full-width detail views of each page. The reread is not given the arithmetic target. Overlap is labelled so rows are not counted twice. A reread cannot simply remove monetary evidence. If it proposes a different receipt total, the first total is kept and corrected lines can still be used. Its adjustments are replaced with the first reading's adjustments before that check. A reread that turns an unbalanced bill into a balanced one is kept only when every non-zero line amount from the first reading is still present. Adding a line is allowed. Dropping a zero-amount unused row is allowed when the remaining receipt reconciles. Fewer lines are accepted only when the remaining receipt reconciles without issues.
- The model output budget is 7,000 tokens. Truncated responses are rejected. The full extraction has a 210-second deadline within the review screen's existing polling window. If that deadline, or the reread itself, fails after a first checked result exists, that result is returned. A timeout before any reading still fails the job.
- More than 200 transcribed rows are cut off before the 40-line review cap, and the review says the first 200 were checked.
- Provider error objects are failures even if the gateway wraps them in HTTP 200. An upstream capacity error must not turn into an empty successful receipt.

No receipt arithmetic replaces stock or spend calculations. The existing purchase contract still stores whole packs and price per pack rounded to two decimals. If that cannot reproduce the printed amount exactly, the review notes the rounding limitation. Separate bill taxes, discounts and charges require review of prices before saving.

## Review and compatibility

The draft shows each printed line amount and any quantity/price concern. People can correct values, assign products, discard lines and approve purchases through the existing flow. Editing packs or price clears that line's extraction note and does not redo the receipt check; the screen says so when a reading note is present. A total discrepancy is advisory because a person can legitimately choose only some purchases from a receipt. A blank quantity or price cannot be saved through the existing validation. Bill-level taxes, discounts and charges stay disclosed and are not allocated across products. A percentage-only discount is not turned into money. An adjustment that is not a money amount leaves the total unchecked, including when the line amounts already equal the total, and an unchecked quantity on that bill is left blank. A tax summary repeated both inside line totals and as an adjustment stays a discrepancy rather than being removed automatically.

Existing stored drafts remain readable. There is no database migration or model/provider change. Authorization, ownership, receipt storage, stock calculations, and purchase confirmation remain in the existing services.

Arithmetic checks establish consistency of extracted evidence, not OCR accuracy. A model can still misread several mutually consistent numbers, miss an item when no usable total exists, or misclassify products. Human review remains required. No accuracy claim across suppliers or scan qualities follows from one successful receipt.

## Validation

`backend/tests/test_receipt_checks.py` covers MRP/quantity confusion, unused rows, free items, net and tax-inclusive rates, line and bill discounts, an adjustment that is not money, missing totals/rates/quantities, rounding, a sound row kept beside an uncorroborated row, the 200-row disclosure, and the reported seven-item receipt's transcribed amounts without customer/supplier identifiers.

`backend/tests/test_receipt_read.py` covers original image dimensions at different DPI values, noisy scans and byte limits, native/scanned PDFs, a PDF text failure, multipage limits, overlapping detail labels, bounded rereads, a corrected line kept while the first total stays, failed or regressing rereads, a reread that manufactures a balance, a reread timeout, incomplete provider output, printed dates including a Dated label and a year-first month name, and review/edit/save behavior. Browser checks cover printed amounts, long filenames and review notes at desktop and 390px widths.

## Research informing the implementation

- [PyMuPDF image rendering and clipping](https://pymupdf.readthedocs.io/en/latest/recipes-images.html): page coordinates, resolution control, and partial-page rendering. These support preserving pixels and providing full-width detail views.
- [Microsoft's invoice field schema](https://github.com/Azure-Samples/document-intelligence-code-samples/blob/main/schema/2024-07-31-preview/invoice.md): separate quantity, unit price, line amount, and invoice totals. The implementation adopts the separation of evidence, without adding Azure Document Intelligence.
- [Document Intelligence accuracy and confidence guidance](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/accuracy-confidence?view=doc-intel-4.0.0): evaluate extraction against representative documents and retain review for uncertain fields. Model confidence is not used as a substitute for checking printed amounts.
- [Python Decimal](https://docs.python.org/3.12/library/decimal.html): decimal arithmetic and explicit rounding for monetary comparisons.
