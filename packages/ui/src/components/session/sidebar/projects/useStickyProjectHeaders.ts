import React from 'react';

type Args = {
  enabled?: boolean;
  isDesktopShellRuntime: boolean;
  projectSections: readonly unknown[];
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  refreshKey?: number;
};

export const useStickyProjectHeaders = (args: Args): Set<string> => {
  const {
    enabled = true,
    isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
    refreshKey = 0,
  } = args;
  const [stuckProjectHeaders, setStuckProjectHeaders] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!enabled || !isDesktopShellRuntime) {
      setStuckProjectHeaders((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    setStuckProjectHeaders((prev) => (prev.size === 0 ? prev : new Set()));
    const firstSentinel = Array.from(projectHeaderSentinelRefs.current.values()).find((el) => el !== null);
    const root = firstSentinel?.closest<HTMLElement>('.oc-sidebar-scroller') ?? null;
    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setStuckProjectHeaders((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            // SAFETY: Every observed target comes from projectHeaderSentinelRefs,
            // whose values are HTML project-header sentinel elements.
            const projectId = (entry.target as HTMLElement).dataset.projectId;
            if (!projectId) continue;

            const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
            const isAboveScroller = !entry.isIntersecting && entry.boundingClientRect.top < rootTop;
            if (next.has(projectId) === isAboveScroller) continue;

            changed = true;
            if (isAboveScroller) next.add(projectId);
            else next.delete(projectId);
          }
          return changed ? next : prev;
        });
      },
      { root, threshold: 0 },
    );
    const observeCurrentSentinels = (): void => {
      projectHeaderSentinelRefs.current.forEach((el) => {
        if (el) observer.observe(el);
      });
    };
    observeCurrentSentinels();

    const mutationObserver = globalThis.MutationObserver
      ? new MutationObserver(observeCurrentSentinels)
      : null;
    mutationObserver?.observe(root, { childList: true, subtree: true });

    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [enabled, isDesktopShellRuntime, projectHeaderSentinelRefs, projectSections, refreshKey]);

  return stuckProjectHeaders;
};
