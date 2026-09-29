import { useEffect, useRef } from "react";

function focusable(root) {
  return [...root.querySelectorAll("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")]
    .filter((node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true");
}

export function useFocusTrap(active, onEscape) {
  const ref = useRef(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current;
    if (!root) return undefined;
    const previous = document.activeElement;
    const items = focusable(root);
    (items[0] instanceof HTMLElement ? items[0] : root).focus();

    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable(root);
      if (!nodes.length) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, [active]);

  return ref;
}
