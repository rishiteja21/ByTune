import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { useUI, type MenuItem } from "../stores/ui";

/** One interactive row — shared by the main menu and every submenu. */
function MenuRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const Icon = item.icon;
  return (
    <button
      disabled={item.disabled}
      onClick={(e) => {
        e.stopPropagation();
        item.action?.();
        onClose();
      }}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-left transition-colors disabled:opacity-40 ${
        item.danger
          ? "text-red-400 hover:bg-red-500/10"
          : "text-ink hover:bg-ink-hi/[0.08] hover:text-ink-hi"
      }`}
    >
      {Icon && <Icon className={`w-4 h-4 shrink-0 ${item.iconClassName ?? "opacity-80"}`} />}
      <span className="truncate">{item.label}</span>
    </button>
  );
}

/**
 * A submenu, rendered through a portal beside its parent row.
 *
 * The portal matters: the main menu scrolls (`overflow-y-auto`), and any
 * child flyout would be clipped to that scroll box. Anchored to the row's
 * viewport rect, flipped to the left when there's no room on the right,
 * clamped vertically — measured after mount, before paint.
 */
function Submenu({
  anchor,
  items,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor: DOMRect;
  items: MenuItem[];
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.right + 4;
    if (left + w > window.innerWidth - 8) left = anchor.left - w - 4;
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - h - 8));
    setPos({ left: Math.max(8, left), top });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      data-menu-portal=""
      className="fixed z-[101] min-w-[220px] max-w-[300px] max-h-[340px] overflow-y-auto rounded-2xl glass-strong p-1.5 shadow-float animate-pop-in"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {items.map((item, i) => (
        <Fragment key={`${item.label}-${i}`}>
          {item.separatorBefore && <div className="my-1.5 h-px bg-ink-hi/[0.07]" />}
          <MenuRow item={item} onClose={onClose} />
        </Fragment>
      ))}
    </div>,
    document.body
  );
}

export function ContextMenu() {
  const menu = useUI((s) => s.contextMenu);
  const close = useUI((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  /** the open submenu: which item, and the row rect it flies out from */
  const [sub, setSub] = useState<{ index: number; anchor: DOMRect } | null>(null);
  /** grace timer so the cursor can travel from the row into the flyout */
  const subCloseTimer = useRef<number | null>(null);

  const cancelSubClose = (): void => {
    if (subCloseTimer.current !== null) {
      window.clearTimeout(subCloseTimer.current);
      subCloseTimer.current = null;
    }
  };
  const scheduleSubClose = (): void => {
    cancelSubClose();
    subCloseTimer.current = window.setTimeout(() => setSub(null), 150);
  };

  // Measured in a layout effect so the very first paint is already at the
  // clamped position — a passive effect here let the menu flash at (0,0)
  // for a frame before jumping into place. (Submenu below does the same.)
  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 230;
    const h = el?.offsetHeight ?? 320;
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)),
      // `above` menus hang from their bottom edge: y is the anchor's top, the
      // panel ends a beat above it — the playbar buttons open this way.
      y: menu.above
        ? Math.max(8, menu.y - h - 6)
        : Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)),
    });
  }, [menu]);

  // A freshly opened menu always starts with every submenu folded.
  useEffect(() => {
    cancelSubClose();
    setSub(null);
    return cancelSubClose;
  }, [menu]);

  // Close on any press outside the menu. pointerdown, not click: the click
  // that opened the menu is still bubbling towards window when the menu
  // mounts, so a click listener here would be hit by that very event and
  // dismiss the menu before it ever painted. A press always starts after the
  // opener finished, so the next press outside — and only that — closes.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-menu-portal]")) return;
      close();
    };
    const onScroll = (e: Event): void => {
      // Scrolling the menu's own list (or its submenu portal) must keep the
      // menu up — only scroll behind the menu dismisses it.
      const t = e.target;
      if (t instanceof Node && ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-menu-portal]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // First Escape folds the submenu, the second dismisses the menu.
        if (sub !== null) {
          setSub(null);
          return;
        }
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, close, sub]);

  if (!menu) return null;

  return (
    <div
      ref={ref}
      className="fixed z-[100] min-w-[230px] max-w-[300px] max-h-[70vh] overflow-y-auto rounded-2xl glass-strong p-1.5 animate-pop-in"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => {
        // Leaving the menu with a flyout open closes it after a short grace
        // period — enough for the cursor to cross into the flyout itself.
        if (sub !== null) scheduleSubClose();
      }}
    >
      {menu.items.map((item, i) => {
        const Icon = item.icon;
        if (item.header) {
          return (
            <Fragment key={`${item.label}-${i}`}>
              {item.separatorBefore && <div className="my-1.5 h-px bg-ink-hi/[0.07]" />}
              <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                {item.label}
              </div>
            </Fragment>
          );
        }
        const hasSub = !!item.children && item.children.length > 0;
        const subOpen = hasSub && sub?.index === i;
        return (
          <Fragment key={`${item.label}-${i}`}>
            {/* The separator rides BEFORE its item - it must not swallow it. */}
            {item.separatorBefore && <div className="my-1.5 h-px bg-ink-hi/[0.07]" />}
            <div
              className="relative"
              onMouseEnter={(e) => {
                cancelSubClose();
                if (!hasSub) {
                  setSub(null);
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                setSub(sub?.index === i ? sub : { index: i, anchor: rect });
              }}
            >
              <button
                disabled={item.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasSub) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setSub(subOpen ? null : { index: i, anchor: rect });
                    return;
                  }
                  item.action?.();
                  close();
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] text-left transition-colors disabled:opacity-40 ${
                  subOpen
                    ? "bg-ink-hi/[0.08] text-ink-hi"
                    : item.danger
                      ? "text-red-400 hover:bg-red-500/10"
                      : "text-ink hover:bg-ink-hi/[0.08] hover:text-ink-hi"
                }`}
              >
                {Icon && <Icon className={`w-4 h-4 shrink-0 ${item.iconClassName ?? "opacity-80"}`} />}
                <span className="truncate">{item.label}</span>
                {hasSub && <ChevronRight className="ml-auto w-3.5 h-3.5 shrink-0 opacity-60" />}
              </button>
              {subOpen && sub && (
                <Submenu
                  anchor={sub.anchor}
                  items={item.children!}
                  onClose={close}
                  onMouseEnter={cancelSubClose}
                  onMouseLeave={scheduleSubClose}
                />
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
