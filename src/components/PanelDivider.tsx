import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface PanelDividerProps {
  label: string;
  controls: string;
  /** The right panel grows when its divider moves to the left. */
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onResize: (width: number) => void;
  onReset: () => void;
}

export function PanelDivider({ label, controls, side, value, min, max, disabled, onResize, onReset }: PanelDividerProps) {
  const drag = useRef<{ id: number; x: number; width: number; target: HTMLDivElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const direction = side === "left" ? 1 : -1;
  const resize = (width: number): void => onResize(Math.min(max, Math.max(min, Math.round(width))));

  const endDrag = useCallback((): void => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragging(false);
    if (current.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.classList.add("panel-resizing");
    window.addEventListener("blur", endDrag);
    return () => {
      root.classList.remove("panel-resizing");
      window.removeEventListener("blur", endDrag);
      // Unmounting during a drag must also release capture and the global cursor.
      const current = drag.current;
      drag.current = null;
      if (current?.target.hasPointerCapture(current.id)) current.target.releasePointerCapture(current.id);
    };
  }, [dragging, endDrag]);

  useEffect(() => { if (disabled) endDrag(); }, [disabled, endDrag]);

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id === e.pointerId) endDrag();
  };

  return (
    <div
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      title={`${label}: drag or use Left/Right arrows to resize (Shift for larger steps). Home/End set limits. Double-click or Enter resets.`}
      className="panel-divider app-no-drag"
      data-dragging={dragging ? "" : undefined}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0 || !e.isPrimary || drag.current) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, width: value, target: e.currentTarget };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const current = drag.current;
        if (!current || current.id !== e.pointerId) return;
        if (e.buttons === 0) { endDrag(); return; }
        resize(current.width + (e.clientX - current.x) * direction);
      }}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={endPointer}
      onDoubleClick={() => { if (!disabled) onReset(); }}
      onKeyDown={(e) => {
        if (disabled || e.altKey || e.ctrlKey || e.metaKey) return;
        const step = e.shiftKey ? 40 : 8;
        switch (e.key) {
          case "ArrowLeft": resize(value - step * direction); break;
          case "ArrowRight": resize(value + step * direction); break;
          case "Home": resize(min); break;
          case "End": resize(max); break;
          case "Enter": endDrag(); onReset(); break;
          case "Escape": {
            if (!drag.current) return;
            const start = drag.current.width;
            endDrag();
            resize(start);
            break;
          }
          default: return;
        }
        // These arrows belong to the divider, not the app's seek/skip shortcuts.
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  );
}
