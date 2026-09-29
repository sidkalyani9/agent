import { useEffect, useRef, useState } from "react";
import { IconFile } from "../icons.jsx";

const empty = { kind: "purchase", name: "", productId: "", date: "", packs: "", price: "" };

export function RecordPanel({ pantry, officeName, onSubmit, busy, loading }) {
  const fileRef = useRef(null);
  const [form, setForm] = useState({ ...empty, date: pantry?.today || todayIso() });
  const [receipt, setReceipt] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [heldPurchase, setHeldPurchase] = useState(null);
  const canWrite = Boolean(pantry?.canWrite);

  const kinds = [
    canWrite ? ["purchase", "Purchase"] : null,
    canWrite ? ["count", "Count"] : null,
    canWrite ? ["product", "Product"] : null,
  ].filter(Boolean);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function submit(event) {
    event.preventDefault();
    if (heldPurchase && form.kind === "purchase" && samePurchase(form, heldPurchase) && receipt) {
      const ok = await onSubmit({ ...form, kind: "attach", purchaseId: heldPurchase.purchaseId }, receipt);
      if (ok === true) {
        clearReceipt();
        setHeldPurchase(null);
        setForm({ ...empty, date: pantry?.today || todayIso(), kind: form.kind });
      }
      return;
    }
    if (heldPurchase && !samePurchase(form, heldPurchase)) setHeldPurchase(null);
    const result = await onSubmit(form, receipt);
    if (result === true) {
      clearReceipt();
      setHeldPurchase(null);
      setForm({ ...empty, date: pantry?.today || todayIso(), kind: form.kind });
      setFileError("");
    } else if (result?.purchaseId) {
      setHeldPurchase({ purchaseId: result.purchaseId, productId: form.productId, date: form.date, packs: form.packs, price: form.price });
    }
  }

  function clearReceipt() {
    setReceipt(null);
    setFileError("");
    if (fileRef.current) fileRef.current.value = "";
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return "";
    });
  }

  function takeFile(file) {
    setFileError("");
    if (!file) return clearReceipt();
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setFileError("A receipt is a PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setFileError("A receipt is at most 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setFileError("That file could not be read.");
    reader.onload = () => {
      setReceipt({
        fileName: file.name,
        contentType: file.type,
        dataBase64: String(reader.result).split(",")[1],
      });
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(file);
      });
    };
    reader.readAsDataURL(file);
  }

  if (loading || !pantry) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <p className="lede">Loading {officeName || "the office"}.</p>
      </section>
    );
  }

  if (!kinds.length) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <p className="lede">This sign-in can view {officeName || "the office"}. It cannot change the pantry.</p>
      </section>
    );
  }

  const selected = (pantry.products || []).find((product) => product.productId === form.productId);
  const replacing = form.kind === "count" && form.date && selected?.countDates?.includes(form.date);
  const lede = form.kind === "count"
    ? "Sets the packs on the shelf for the date you choose."
    : form.kind === "product"
      ? `Adds a product at ${officeName || "this office"}.`
      : `${officeName}. A purchase saves with or without a receipt.`;

  return (
    <section className="card record-card">
      <div className="card-head">
        <div>
          <h2>Record</h2>
          <p className="lede-small">{lede}</p>
        </div>
      </div>
      <form className="record-form" onSubmit={submit}>
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
        <div className="fields">
          {form.kind === "product" ? (
            <label className="field wide">Name
              <input value={form.name} maxLength={120} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "count" ? (
            <label className="field wide">Product
              <select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} required>
                <option value="">Choose a product</option>
                {(pantry.products || []).filter((product) => !product.deletedAt).map((product) => (
                  <option key={product.productId} value={product.productId}>{product.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "count" ? (
            <label className="field">Date
              <input type="date" max={pantry.today} value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "count" ? (
            <label className="field">Packs
              <input inputMode="numeric" value={form.packs} onChange={(event) => setForm({ ...form, packs: event.target.value })} required />
            </label>
          ) : null}
          {form.kind === "purchase" ? (
            <label className="field wide">Price per pack (INR)
              <input inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} required />
            </label>
          ) : null}
          {replacing ? <p className="note">This replaces the count already saved for this date.</p> : null}
          {form.kind === "purchase" ? (
            <div className="field wide">
              <span>Receipt, optional</span>
              <label
                className="drop"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  takeFile(event.dataTransfer.files?.[0]);
                }}
              >
                <input
                  ref={fileRef}
                  className="sr-only"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(event) => takeFile(event.target.files?.[0])}
                />
                <IconFile />
                <span>{receipt ? receipt.fileName : "Drop a PDF, JPEG, or PNG, or browse"}</span>
                <small>Up to 10 MB. The purchase still saves if you skip this.</small>
              </label>
              {previewUrl && receipt?.contentType?.startsWith("image/") ? <img className="receipt-preview" src={previewUrl} alt="Receipt preview" /> : null}
              {previewUrl && receipt?.contentType === "application/pdf" ? <iframe className="receipt-frame" title={receipt.fileName} src={previewUrl} /> : null}
              {receipt ? <button className="texty" type="button" onClick={clearReceipt}>Remove receipt</button> : null}
              {heldPurchase ? <p className="note">The purchase is saved. Try the receipt again, or attach it from Purchases and receipts.</p> : null}
              {fileError ? <p className="error" role="alert">{fileError}</p> : null}
            </div>
          ) : null}
          <div className="field wide">
            <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : heldPurchase ? "Try the receipt again" : "Save"}</button>
          </div>
        </div>
      </form>
    </section>
  );
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
