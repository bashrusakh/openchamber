import React from 'react';

type Args = {
  enabled?: boolean;
  isDesktopShellRuntime: boolean;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  refreshKey?: number | string;
};

type StickySentinelResolver = () => ReadonlyMap<string, HTMLElement | null>;

type StickySentinelObserverArgs = {
  enabled: boolean;
  rootRef: React.RefObject<HTMLElement | null>;
  resolveSentinels: StickySentinelResolver;
  refreshKey?: number | string;
};

const clearStickyHeaders = (setStuckHeaders: React.Dispatch<React.SetStateAction<Set<string>>>): void => {
  setStuckHeaders((previous) => (previous.size === 0 ? previous : new Set()));
};

/**
 * Observe temporary virtualized sentinels from the stable scrolling element.
 * The root owns the observer lifecycle; sentinels may appear, disappear, or
 * be replaced as virtualization changes the mounted window.
 */
export const useStickySentinelObserver = (args: StickySentinelObserverArgs): Set<string> => {
  const {
    enabled,
    rootRef,
    resolveSentinels,
    refreshKey = 0,
  } = args;
  const [stuckHeaders, setStuckHeaders] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!enabled) {
      clearStickyHeaders(setStuckHeaders);
      return;
    }

    const root = rootRef.current;
    if (!root) {
      clearStickyHeaders(setStuckHeaders);
      return;
    }

    let disposed = false;
    let observedSentinels = new Map<Element, string>();
    const intersectionObserver = globalThis.IntersectionObserver
      ? new IntersectionObserver((entries) => {
        if (disposed) return;
        setStuckHeaders((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const key = observedSentinels.get(entry.target);
            if (!key) continue;

            const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
            const isAboveScroller = !entry.isIntersecting && entry.boundingClientRect.top < rootTop;
            if (next.has(key) === isAboveScroller) continue;

            changed = true;
            if (isAboveScroller) next.add(key);
            else next.delete(key);
          }
          return changed ? next : previous;
        });
      }, { root, threshold: 0 })
      : null;

    const syncObservedSentinels = (): void => {
      if (disposed) return;

      const currentSentinels = new Map<Element, string>();
      const currentKeys = new Set<string>();
      for (const [key, element] of resolveSentinels()) {
        if (element && root.contains(element)) {
          currentSentinels.set(element, key);
          currentKeys.add(key);
        }
      }

      for (const [element, key] of observedSentinels) {
        if (currentSentinels.get(element) !== key) intersectionObserver?.unobserve(element);
      }
      for (const [element, key] of currentSentinels) {
        if (observedSentinels.get(element) !== key) intersectionObserver?.observe(element);
      }

      const replacedKeys = new Set<string>();
      const initiallyStuckKeys = new Set<string>();
      let rootTop: number | null = null;
      for (const [element, key] of currentSentinels) {
        if (observedSentinels.get(element) === key) continue;
        replacedKeys.add(key);
        rootTop ??= root.getBoundingClientRect().top;
        if (element.getBoundingClientRect().top < rootTop) initiallyStuckKeys.add(key);
      }
      observedSentinels = currentSentinels;
      setStuckHeaders((previous) => {
        let changed = false;
        const next = new Set(previous);
        for (const key of previous) {
          if (currentKeys.has(key) && !replacedKeys.has(key)) continue;
          next.delete(key);
          changed = true;
        }
        for (const key of initiallyStuckKeys) {
          if (next.has(key)) continue;
          next.add(key);
          changed = true;
        }
        return changed ? next : previous;
      });
    };

    syncObservedSentinels();
    const mutationObserver = globalThis.MutationObserver
      ? new MutationObserver(syncObservedSentinels)
      : null;
    mutationObserver?.observe(root, {
      attributes: true,
      attributeFilter: ['data-project-id', 'data-sidebar-activity-start'],
      childList: true,
      subtree: true,
    });

    return () => {
      disposed = true;
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
    };
  }, [enabled, refreshKey, resolveSentinels, rootRef]);

  return stuckHeaders;
};

export const useStickyProjectHeaders = (args: Args): Set<string> => {
  const {
    enabled = true,
    isDesktopShellRuntime,
    projectHeaderSentinelRefs,
    scrollContainerRef,
    refreshKey = 0,
  } = args;
  const resolveProjectSentinels = React.useCallback(
    (): ReadonlyMap<string, HTMLElement | null> => projectHeaderSentinelRefs.current,
    [projectHeaderSentinelRefs],
  );

  return useStickySentinelObserver({
    enabled: enabled && isDesktopShellRuntime,
    rootRef: scrollContainerRef,
    resolveSentinels: resolveProjectSentinels,
    refreshKey,
  });
};
