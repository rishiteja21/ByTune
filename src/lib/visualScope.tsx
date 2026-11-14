import { createContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { createVisualActivity } from "./visualActivityCore";

type VisualActivity = ReturnType<typeof createVisualActivity>;

/** View eligibility is independent of native window activity. */
export const VisualScopeContext = createContext<VisualActivity | null>(null);
export const homeVisualActivity = createVisualActivity(true);

/** Keep the shell's layout and playback infrastructure mounted. Only explicitly
 * owned decorative work observes this scope. Updates do not render the tree. */
export function VisualScope({ activity, children }: { activity: VisualActivity; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const update = (): void => {
      if (root.current) root.current.dataset.visualCovered = String(!activity.getSnapshot());
    };
    const off = activity.subscribe(update);
    update();
    return off;
  }, [activity]);
  return (
    <VisualScopeContext.Provider value={activity}>
      <div ref={root} className="contents" data-visual-scope="home">{children}</div>
    </VisualScopeContext.Provider>
  );
}
