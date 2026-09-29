import { useEffect, useRef, useState } from "react";

export function ProductMenu({ products, value, onChange, label = "Product" }) {
  const root = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.productId === value);
  const needle = query.trim().toLowerCase();
  const choices = products.filter((product) => !needle || product.name.toLowerCase().includes(needle));

  useEffect(() => {
    function close(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="product-pick" ref={root}>
      <button
        className="product-button"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
      >
        {selected?.name || "Choose a product"}
      </button>
      {open ? (
        <div className="product-menu" role="listbox" aria-label={label}>
          <input
            className="product-search"
            type="text"
            value={query}
            placeholder="Search products"
            aria-label="Search products"
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          {choices.map((product) => (
            <button
              key={product.productId}
              type="button"
              role="option"
              aria-selected={product.productId === value}
              onClick={() => {
                onChange(product.productId);
                setOpen(false);
              }}
            >
              {product.name}
            </button>
          ))}
          {!choices.length ? <p>No product matches that search.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
