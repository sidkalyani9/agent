import { useState } from "react";
import { IconFile } from "../icons.jsx";

const empty = { kind: "purchase", name: "", productId: "", date: "", packs: "", price: "" };

export function RecordPanel({ pantry, superAdmin, officeName, onSubmit, busy }) {
  const [form, setForm] = useState({ ...empty, date: todayIso() });
  const [receipt, setReceipt] = useState(null);
  const [fileError, setFileError] = useState("");
  const canWrite = Boolean(pantry?.canWrite);

  const kinds = [
    canWrite ? ["purchase", "Purchase"] : null,
    canWrite ? ["count", "Count"] : null,
    canWrite ? ["product", "Product"] : null,
    superAdmin ? ["settings", "Settings"] : null,
  ].filter(Boolean);

  async function submit(event) {
    event.preventDefault();
    const ok = await onSubmit(form, receipt);
    if (ok) {
      setForm({ ...empty, date: todayIso(), kind: form.kind });
      setReceipt(null);
      setFileError("");
    }
  }

  function takeFile(file) {
    setFileError("");
    if (!file) return setReceipt(null);
    if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setFileError("A receipt is a PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setFileError("A receipt is at most 10 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setReceipt({
        fileName: file.name,
        contentType: file.type,
        dataBase64: String(reader.result).split(",")[1],
      });
    };
    reader.readAsDataURL(file);
  }

  if (!kinds.length) {
    return (
      <section className="card record-card">
        <h2>Record</h2>
        <p className="lede">This sign-in can view {officeName || "the office"}. It cannot change the pantry.</p>
      </section>
    );
  }

  return (
    <section className="card record-card">
      <div className="card-head">
        <div>
          <h2>Record</h2>
          <p className="lede-small">{officeName}. A purchase saves with or without a receipt.</p>
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
              onClick={() => setForm({
                ...form,
                kind,
                price: kind === "settings" ? String(pantry?.settings?.weekendWeight ?? 0.2) : form.price,
                packs: kind === "settings" ? String(pantry?.settings?.lookbackMonths ?? 3) : form.packs,
              })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="fields">
          {form.kind === "product" || form.kind === "office" ? (
            <label className="field wide">Name
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "count" ? (
            <label className="field wide">Product
              <select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })} required>
                <option value="">Choose a product</option>
                {(pantry?.products || []).filter((product) => !product.deletedAt).map((product) => (
                  <option key={product.productId} value={product.productId}>{product.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "count" ? (
            <label className="field">Date
              <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} required />
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "count" || form.kind === "settings" ? (
            <label className="field">{form.kind === "settings" ? "Lookback months" : "Packs"}
              <input inputMode="numeric" value={form.packs} onChange={(event) => setForm({ ...form, packs: event.target.value })} required={form.kind !== "settings"} />
            </label>
          ) : null}
          {form.kind === "purchase" || form.kind === "settings" ? (
            <label className={`field${form.kind === "purchase" ? " wide" : ""}`}>{form.kind === "settings" ? "Weekend weight" : "Price per pack (INR)"}
              <input inputMode="decimal" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} required={form.kind !== "settings"} />
            </label>
          ) : null}
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
                  className="sr-only"
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(event) => takeFile(event.target.files?.[0])}
                />
                <IconFile />
                <span>{receipt ? receipt.fileName : "Drop a PDF, JPEG, or PNG, or browse"}</span>
                <small>Up to 10 MB. The purchase still saves if you skip this.</small>
              </label>
              {receipt ? (
                <button className="texty" type="button" onClick={() => setReceipt(null)}>Remove receipt</button>
              ) : null}
              {fileError ? <p className="error">{fileError}</p> : null}
            </div>
          ) : null}
          <div className="field wide">
            <button className="solid" type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </form>
    </section>
  );
}

function todayIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
