import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
export default function BottomSheet({
  title,
  onClose,
  children,
  initial = "half",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  initial?: "collapsed" | "half" | "expanded";
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const dragged = useRef(false);
  const [size, setSize] = useState(initial);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) {
        const focusable = Array.from(
          el.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,select,a[href],[tabindex="0"]',
          ),
        );
        const first = focusable[0],
          last = focusable.at(-1);
        if (
          e.shiftKey &&
          (document.activeElement === first || document.activeElement === el)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [onClose]);
  const levels = ["collapsed", "half", "expanded"] as const;
  return createPortal(
    <div className="sheet-overlay">
      <button
        className="sheet-backdrop"
        tabIndex={-1}
        aria-label={t("close")}
        onClick={onClose}
      />
      <div
        ref={ref}
        className={`bottom-sheet sheet-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <button
          className="sheet-handle"
          aria-label={t(size === "expanded" ? "collapse" : "expand")}
          onClick={() => {
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            setSize(size === "expanded" ? "half" : "expanded");
          }}
          onPointerDown={(e) => {
            dragged.current = false;
            start.current = e.clientY;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerUp={(e) => {
            if (start.current === null) return;
            const delta = e.clientY - start.current;
            start.current = null;
            if (Math.abs(delta) > 35) {
              dragged.current = true;
              const next = Math.max(
                0,
                Math.min(2, levels.indexOf(size) + (delta < 0 ? 1 : -1)),
              );
              setSize(levels[next]);
            }
          }}
        >
          <span />
        </button>
        <div className="sheet-title">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t("close")}
          >
            <X size={21} />
          </button>
        </div>
        <div className="sheet-content">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
