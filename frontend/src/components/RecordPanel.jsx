import { useEffect, useRef, useState } from "react";
import { api, rupee } from "../api.js";
import { IconFile } from "../icons.jsx";
import { ProductMenu } from "./ProductMenu.jsx";
import { SettingsPanel } from "./SettingsPanel.jsx";

const empty = { kind: "purchase", name: "", productId: "", date: "", packs: "", price: "" };

export function RecordPanel({ pantry, officeId, officeName, superAdmin, onSubmit, onSaved, onToast, busy, loading }) {
  const purchaseFileRef = useRef(null);
  const receiptFileRef = useRef(null);
  const readingRef = useRef(null);
  const patchChain = useRef(Promise.resolve());
  const patchTimer = useRef(null);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const [form, setForm] = useState({ ...empty, date: pantry?.today || todayIso() });
  const [receipt, setReceipt] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [heldPurchase, setHeldPurchase] = useState(null);
  const [upload, setUpload] = useState(null);
  const [uploadPreview, setUploadPreview] = useState("");
  const [readError, setReadError] = useState("");
  const [readBusy, setReadBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(null);
  const canWrite = Boolean(pantry?.canWrite);

  useEffect(() => {
    readingRef.current = reading;
  }, [reading]);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => () => {
    if (uploadPreview) URL.revokeObjectURL(uploadPreview);
  }, [uploadPreview]);

  useEffect(() => {
    if (!officeId || !canWrite) return undefined;
    let cancel = false;
    api(`/api/offices/${officeId}/receipt-readings/open`)
      .then((data) => {
        if (!cancel && data.reading) setReading(data.reading);
      })
      .catch((err) => {
        if (!cancel) setReadError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [officeId, canWrite]);

  useEffect(() => {
    if (!officeId || reading?.status !== "reading") return undefined;
    let cancel = false;
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > 240000) {
        const message = "This is taking too long. Try the receipt again.";
        if (!cancel) {
          setReadError(message);
          setReading((current) => (current ? { ...current, status: "failed", error: message } : current));
        }
        return;
      }
      try {
        const data = await api(`/api/offices/${officeId}/receipt-readings/${reading.readingId}`);
        if (cancel) return;
        setReading(data);
        if (data.status === "failed") setReadError(data.error || "The receipt could not be read.");
        if (data.status === "ready") setReadError("");
      } catch (err) {
        if (!cancel) setReadError(err.message);
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      cancel = true;
      clearInterval(timer);
    };
  }, [officeId, reading?.readingId, reading?.status]);

  useEffect(() => () => {
    clearTimeout(patchTimer.current);
    const pending = readingRef.current;
    if (!dirtyRef.current || !officeId || pending?.status !== "ready") return;
    dirtyRef.current = false;
    const body = patchBody(pending);
    patchChain.current = patchChain.current.catch(() => {}).then(() => api(`/api/offices/${officeId}/receipt-readings/${pending.readingId}`, {
      method: "PATCH",
      body,
    })).catch(() => {});
  }, [officeId]);

  function enqueuePatch(next, rev) {
    const body = patchBody(next);
    patchChain.current = patchChain.current.catch(() => {}).then(async () => {
      const saved = await api(`/api/offices/${officeId}/receipt-readings/${next.readingId}`, { method: "PATCH", body });
      if (rev === revision.current) {
        readingRef.current = saved;
        if (mounted.current) setReading(saved);
      }
      return saved;
    });
    return patchChain.current;
  }

  function remember(next, immediate) {
    revision.current += 1;
    const rev = revision.current;
    readingRef.current = next;
    setReading(next);
    if (next?.status !== "ready") return;
    dirtyRef.current = true;
    clearTimeout(patchTimer.current);
    const send = () => {
      if (rev !== revision.current) return;
      dirtyRef.current = false;
      enqueuePatch(next, rev).catch((err) => {
        if (rev === revision.current && mounted.current) setReadError(err.message);
      });
    };
    if (immediate) send();
    else patchTimer.current = setTimeout(send, 400);
  }

  function changeLine(id, patch, immediate) {
    const current = readingRef.current;
    if (!current?.result) return;
    remember({
      ...current,
      result: {
        ...current.result,
        lines: current.result.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      },
    }, immediate);
  }

  function changeDate(date) {
    const current = readingRef.current;
    if (!current?.result) return;
    remember({ ...current, result: { ...current.result, date } }, false);
  }

  async function submit(event) {
    event.preventDefault();
    if (heldPurchase && form.kind === "purchase" && samePurchase(form, heldPurchase) && receipt) {
      const ok = await onSubmit({ ...form, kind: "attach", purchaseId: heldPurchase.purchaseId }, receipt);
      if (ok === true) {
        clearPurchaseFile();
        setHeldPurchase(null);
        setForm({ ...empty, date: pantry?.today || todayIso(), kind: form.kind });
      }
      return;
    }
    if (heldPurchase && !samePurchase(form, heldPurchase)) setHeldPurchase(null);
    const result = await onSubmit(form, form.kind === "purchase" ? receipt : null);
    if (result === true) {
      clearPurchaseFile();
      setHeldPurchase(null);
      setForm({ ...empty, date: pantry?.today || todayIso(), kind: form.kind });
      setFileError("");
    } else if (result?.purchaseId) {
      setHeldPurchase({ purchaseId: result.purchaseId, productId: form.productId, date: form.date, packs: form.packs, price: form.price });
    }
  }

  function clearPurchaseFile() {
    setReceipt(null);
    setFileError("");
    if (purchaseFileRef.current) purchaseFileRef.current.value = "";
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  }

  function clearUpload() {
    setUpload(null);
    if (receiptFileRef.current) receiptFileRef.current.value = "";
    setUploadPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  }

  function takeFile(file, target) {
    const purchaseTarget = target === "purchase";
    const setError = purchaseTarget ? setFileError : setReadError;
    const setPayload = purchaseTarget ? setReceipt : setUpload;
    const setUrl = purchaseTarget ? setPreviewUrl : setUploadPreview;
    const ref = purchaseTarget ? purchaseFileRef : receiptFileRef;
    setError("");
    if (!file) {
      setPayload(null);
      if (ref.current) ref.current.value = "";
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return "";
      });
      return;
    }
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setError("A receipt is a PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("A receipt is at most 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read.");
    reader.onload = () => {
      setPayload({
        fileName: file.name,
        contentType: file.type,
        dataBase64: String(reader.result).split(",")[1],
      });
      setUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
    };
    reader.readAsDataURL(file);
  }

  async function readReceipt() {
    if (!upload || readBusy) return;
    setReadBusy(true);
    setReadError("");
    try {
      const data = await api(`/api/offices/${officeId}/receipt-readings`, { method: "POST", body: { receipt: upload } });
      const next = { readingId: data.readingId, status: "reading", error: null, fileName: upload.fileName, result: null };
      readingRef.current = next;
      setReading(next);
    } catch (err) {
      setReadError(err.message);
    } finally {
      setReadBusy(false);
    }
  }

  async function clearReading() {
    const current = readingRef.current;
    if (!current || saving) return;
    setReadError("");
    try {
      await api(`/api/offices/${officeId}/receipt-readings/${current.readingId}/dismiss`, { method: "POST", body: {} });
      clearTimeout(patchTimer.current);
      dirtyRef.current = false;
      revision.current += 1;
      readingRef.current = null;
      setReading(null);
      clearUpload();
    } catch (err) {
      setReadError(err.message);
    }
  }

  async function addPurchases() {
    const current = readingRef.current;
    if (!current?.result || saving) return;
    clearTimeout(patchTimer.current);
    setSaving(true);
    setReadError("");
    try {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        await enqueuePatch(current, revision.current);
      } else {
        await patchChain.current;
      }
    } catch (err) {
      setReadError(err.message);
      setSaving(false);
      return;
    }
    const latest = readingRef.current;
    const lines = (latest?.result?.lines || []).filter((line) => !line.discarded);
    if (!lines.length) {
      setReadError("Choose at least one line to add.");
      setSaving(false);
      return;
    }
    if (lines.some((line) => !line.productId)) {
      setReadError("Choose a product for each remaining line, or discard it.");
      setSaving(false);
      return;
    }
    if (!latest.result.date || lines.some((line) => line.packs === "" || line.packs == null || line.pricePerPack === "" || line.pricePerPack == null)) {
      setReadError("Enter a date, packs, and a price for each remaining line, or discard it.");
      setSaving(false);
      return;
    }
    try {
      const saved = await api(`/api/offices/${officeId}/receipt-readings/${latest.readingId}/save`, {
        method: "POST",
        body: {
          date: latest.result.date,
          lines: lines.map((line) => ({
            id: line.id,
            productId: line.productId,
            packs: line.packs,
            pricePerPack: line.pricePerPack,
          })),
        },
      });
      onToast?.("Purchases added.");
      const receiptError = saved.purchases?.find((purchase) => purchase.receiptError)?.receiptError;
      readingRef.current = null;
      setReading(null);
      clearUpload();
      if (receiptError) setReadError(receiptError);
      await onSaved?.();
    } catch (err) {
      setReadError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !pantry) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <p className="lede">Loading {officeName || "the office"}.</p>
      </section>
    );
  }

  if (!canWrite) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <p className="lede">This sign-in can view {officeName || "the office"}. It cannot change the pantry.</p>
      </section>
    );
  }

  const products = (pantry.products || []).filter((product) => !product.deletedAt);
  const kinds = [
    ["receipt", "Receipt"],
    ["purchase", "Purchase"],
    ["product", "Product"],
    superAdmin ? ["settings", "Settings"] : null,
  ].filter(Boolean);
  const lede = form.kind === "receipt"
    ? "One receipt can add several purchases. Nothing is saved until you approve it."
    : form.kind === "product"
      ? `Adds a product at ${officeName || "this office"}.`
      : form.kind === "settings"
        ? "Weekend weight and lookback apply to every office."
        : `${officeName}. A purchase saves with or without a receipt.`;
  const visibleLines = (reading?.result?.lines || []).filter((line) => !line.discarded);
  const alert = readError || (reading?.status === "failed" ? reading.error : "");
  const showUpload = !reading || reading.status === "failed";

  return (
    <section className="card record-card">
      <div className="card-head">
        <div>
          <h2>Record</h2>
          <p className="lede-small">{lede}</p>
        </div>
      </div>
      <div className="choices" role="group" aria-label="What to record">
        {kinds.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="choice"
            aria-pressed={form.kind === kind}
            onClick={() => setForm({ ...form, kind })}
          >
            {label}
          </button>
        ))}
      </div>
      {reading && form.kind !== "receipt" ? <p className="note">A receipt is waiting on the Receipt tab.</p> : null}

      {form.kind === "receipt" ? (
        <div className="receipt-review">
          {reading?.status === "reading" ? (
            <p className="receipt-wait" role="status" aria-live="polite">Reading the receipt…</p>
          ) : null}
          {reading?.status === "ready" && reading.result ? (
            <div className="fields">
              {reading.fileName ? <p className="note">{reading.fileName}</p> : null}
              {reading.result.note ? <p className="note">{reading.result.note}</p> : null}
              {reading.result.note ? <p className="note">Editing packs or price does not redo this check.</p> : null}
              <label className="field">Date
                <input type="date" max={pantry.today} value={reading.result.date || ""} onChange={(event) => changeDate(event.target.value)} />
              </label>
              <div className="field wide receipt-lines">
                {visibleLines.length ? visibleLines.map((line) => (
                  <article key={line.id} className={`receipt-line${line.productId ? "" : " unmatched"}`}>
                    <div className="receipt-line-head">
                      <strong>{line.printed}</strong>
                      <button className="texty" type="button" onClick={() => changeLine(line.id, { discarded: true }, true)}>Discard</button>
                    </div>
                    {line.lineTotal ? <p className="note">Printed line amount: {rupee(line.lineTotal)}</p> : null}
                    {line.note ? <p className="note" role="status">{line.note}</p> : null}
                    {line.productId ? null : <p className="note">Not one of this office's products. Add it on the Product tab, then choose it here.</p>}
                    <div className="field">
                      <span>Product</span>
                      <ProductMenu
                        products={products}
                        value={line.productId}
                        label={`Product for ${line.printed}`}
                        onChange={(productId) => {
                          const product = products.find((item) => item.productId === productId);
                          changeLine(line.id, {
                            productId: productId || "",
                            productName: product?.name || "",
                            matched: Boolean(productId),
                          }, true);
                        }}
                      />
                    </div>
                    <div className="fields">
                      <label className="field">Packs
                        <input inputMode="numeric" value={line.packs} onChange={(event) => changeLine(line.id, { packs: event.target.value }, false)} />
                      </label>
                      <label className="field">Price per pack (INR)
                        <input inputMode="decimal" value={line.pricePerPack} onChange={(event) => changeLine(line.id, { pricePerPack: event.target.value }, false)} />
                      </label>
                    </div>
                  </article>
                )) : <p className="note">No lines left on this receipt.</p>}
              </div>
              <div className="field wide receipt-actions">
                <button className="solid" type="button" onClick={addPurchases} disabled={saving}>{saving ? "Saving…" : "Add these purchases"}</button>
                <button className="ghost" type="button" onClick={clearReading}>Clear this receipt</button>
              </div>
            </div>
          ) : null}
          {showUpload ? (
            <div className="field wide">
              <span>Receipt</span>
              <label
                className="drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  takeFile(event.dataTransfer.files?.[0], "receipt");
                }}
              >
                <input
                  ref={receiptFileRef}
                  className="sr-only"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(event) => takeFile(event.target.files?.[0], "receipt")}
                />
                <IconFile />
                <span>{upload ? upload.fileName : "Drop a PDF, JPEG, or PNG, or browse"}</span>
                <small>Up to 10 MB. One receipt can contain several purchases.</small>
              </label>
              {uploadPreview && upload?.contentType?.startsWith("image/") ? <img className="receipt-preview" src={uploadPreview} alt="Receipt preview" /> : null}
              {uploadPreview && upload?.contentType === "application/pdf" ? <iframe className="receipt-frame" title={upload.fileName} src={uploadPreview} /> : null}
              {upload ? <button className="texty" type="button" onClick={clearUpload}>Remove receipt</button> : null}
              {upload ? <button className="solid" type="button" onClick={readReceipt} disabled={readBusy}>{readBusy ? "Sending…" : "Read receipt"}</button> : null}
            </div>
          ) : null}
          {reading?.status === "reading" || reading?.status === "failed" ? (
            <button className="ghost" type="button" onClick={clearReading}>Clear this receipt</button>
          ) : null}
          {alert ? <p className="error" role="alert">{alert}</p> : null}
        </div>
      ) : null}

      {form.kind === "purchase" || form.kind === "product" ? (
        <form className="record-form" onSubmit={submit}>
          <div className="fields">
            {form.kind === "purchase" ? (
              <div className="field wide">
                <span>Receipt, optional</span>
                <label
                  className="drop"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    takeFile(event.dataTransfer.files?.[0], "purchase");
                  }}
                >
                  <input
                    ref={purchaseFileRef}
                    className="sr-only"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    onChange={(event) => takeFile(event.target.files?.[0], "purchase")}
                  />
                  <IconFile />
                  <span>{receipt ? receipt.fileName : "Drop a PDF, JPEG, or PNG, or browse"}</span>
                  <small>Up to 10 MB. The purchase still saves if you skip this.</small>
                </label>
                {previewUrl && receipt?.contentType?.startsWith("image/") ? <img className="receipt-preview" src={previewUrl} alt="Receipt preview" /> : null}
                {previewUrl && receipt?.contentType === "application/pdf" ? <iframe className="receipt-frame" title={receipt.fileName} src={previewUrl} /> : null}
                {receipt ? <button className="texty" type="button" onClick={clearPurchaseFile}>Remove receipt</button> : null}
                {heldPurchase ? <p className="note">The purchase is saved. Try the receipt again, or attach it from Purchases and receipts.</p> : null}
                {fileError ? <p className="error" role="alert">{fileError}</p> : null}
              </div>
            ) : null}
            {form.kind === "product" ? (
              <label className="field wide">Name
                <input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field wide">Product
                <select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} required>
                  <option value="">Choose a product</option>
                  {products.map((product) => (
                    <option key={product.productId} value={product.productId}>{product.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field">Date
                <input type="date" max={pantry.today} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field">Packs
                <input inputMode="numeric" value={form.packs} onChange={(event) => setForm({ ...form, packs: event.target.value })} required />
              </label>
            ) : null}
            {form.kind === "purchase" ? (
              <label className="field wide">Price per pack (INR)
                <input inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} required />
              </label>
            ) : null}
            <div className="field wide">
              <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : heldPurchase ? "Try the receipt again" : "Save"}</button>
            </div>
          </div>
        </form>
      ) : null}

      {form.kind === "settings" ? (
        <SettingsPanel embedded settings={pantry.settings} onSaved={onSaved} onToast={onToast} />
      ) : null}
    </section>
  );
}

function patchBody(next) {
  return {
    date: next.result?.date || "",
    lines: (next.result?.lines || []).map((line) => ({
      id: line.id,
      productId: line.productId || "",
      packs: line.packs ?? "",
      pricePerPack: line.pricePerPack ?? "",
      discarded: Boolean(line.discarded),
    })),
  };
}

function samePurchase(form, held) {
  return form.productId === held.productId && form.date === held.date && String(form.packs) === String(held.packs) && String(form.price) === String(held.price);
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
