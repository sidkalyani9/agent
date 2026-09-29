import { useRef, useState } from "react";
import { api } from "../api.js";

export function ProductEditor({ product, onSaved, onToast }) {
  const details = useRef(null);
  const [name, setName] = useState(product.name);
  const [reorder, setReorder] = useState(product.reorderLevel);
  const [warning, setWarning] = useState(product.warningEffectiveDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await api(`/api/products/${product.productId}`, { method: "PATCH", body: {
        name, reorderLevel: Number(reorder), warningEffectiveDays: Number(warning),
      } });
      await onSaved();
      if (details.current) details.current.open = false;
      onToast?.("Product saved.");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <details className="product-editor" ref={details}>
    <summary>Edit {product.name}</summary>
    <form className="fields" onSubmit={save}>
      <label className="field wide">Product name
        <input value={name} onChange={e => setName(e.target.value)} required maxLength={120} />
      </label>
      <label className="field">Reorder level (packs)
        <input type="number" min="0" max="1000000" step="1" value={reorder} onChange={e => setReorder(e.target.value)} required />
      </label>
      <label className="field">Warning window (effective days)
        <input type="number" min="1" max="366" step="1" value={warning} onChange={e => setWarning(e.target.value)} required />
      </label>
      {error ? <p className="error field wide" role="alert">{error}</p> : null}
      <div className="field wide"><button className="solid" disabled={busy}>{busy ? "Saving…" : "Save product"}</button></div>
    </form>
  </details>;
}
