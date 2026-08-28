import React from 'react';

/**
 * Native-feeling edge swipes on the mobile chat: start a horizontal swipe from
 * the very left/right screen edge and drag toward the centre.
 *
 * - Left edge → centre  = open the sessions drawer
 * - Right edge → centre = open the most recent overflow surface
 *
 * Only passive touch listeners are used, so this never prevents native
 * scrolling. A gesture that starts inside a horizontally scrollable ancestor
 * stays with that container while it has room to scroll in the swipe direction.
 */

const EDGE_ZONE = 32; // px from a side where the swipe must begin
// Android reserves the physical screen edge for system navigation. Accept a
// wider start area so both OpenChamber drawers can be invoked beyond the
// system Back gesture region without changing the browser/iOS gesture.
const ANDROID_EDGE_ZONE = 80;
const MIN_DISTANCE = 64; // px of horizontal travel required to commit
const MAX_OFF_AXIS_RATIO = 0.7; // |dy| must stay below |dx| * this (keep it horizontal)
const SCROLL_BOUNDARY_EPSILON = 1;

export type SwipePoint = { x: number; y: number };
type HorizontalFingerDirection = 'left' | 'right';

export const isValidHorizontalSwipe = (start: SwipePoint, end: SwipePoint): boolean => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return Math.abs(dx) >= MIN_DISTANCE && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS_RATIO;
};

const isHorizontalScrollContainer = (element: HTMLElement): boolean => {
  const style = window.getComputedStyle(element);
  const overflowX = style.overflowX || style.overflow;
  return (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay')
    && element.scrollWidth > element.clientWidth;
};

const isTargetWithinBoundary = (target: EventTarget | null, boundary: HTMLElement): target is Node => (
  target instanceof Node && boundary.contains(target)
);

const getHorizontalScrollAncestors = (target: EventTarget | null, boundary: HTMLElement): HTMLElement[] => {
  if (!isTargetWithinBoundary(target, boundary)) return [];
  const ancestors: HTMLElement[] = [];
  let node: Element | null = target instanceof Element ? target : target.parentElement;
  while (node) {
    if (node instanceof HTMLElement && isHorizontalScrollContainer(node)) ancestors.push(node);
    if (node === boundary) break;
    node = node.parentElement;
  }
  return ancestors;
};

export const hasHorizontalScrollRoom = (
  target: EventTarget | null,
  boundary: HTMLElement,
  fingerDirection: HorizontalFingerDirection,
): boolean => {
  const ancestors = getHorizontalScrollAncestors(target, boundary);
  return ancestors.some((ancestor) => fingerDirection === 'right'
    ? ancestor.scrollLeft > SCROLL_BOUNDARY_EPSILON
    : ancestor.scrollLeft + ancestor.clientWidth < ancestor.scrollWidth - SCROLL_BOUNDARY_EPSILON);
};

const WORKSPACE_DISMISS_IGNORED_TARGET_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[data-terminal-owner]',
].join(',');

const isWorkspaceDismissIgnoredTarget = (target: EventTarget | null): boolean => (
  target instanceof Element && Boolean(target.closest(WORKSPACE_DISMISS_IGNORED_TARGET_SELECTOR))
);

export const shouldDismissWorkspaceDrawer = (
  open: boolean,
  variant: 'drawer' | 'panel',
  start: SwipePoint | null,
  end: SwipePoint | null,
  target: EventTarget | null,
  boundary: HTMLElement | null,
): boolean => {
  if (!open || variant !== 'drawer' || !start || !end || !boundary) return false;
  if (!isTargetWithinBoundary(target, boundary)) return false;
  if (!isValidHorizontalSwipe(start, end) || end.x <= start.x) return false;
  if (window.getSelection()?.isCollapsed === false) return false;
  if (isWorkspaceDismissIgnoredTarget(target)) return false;
  return !hasHorizontalScrollRoom(target, boundary, 'right');
};

export interface EdgeSwipeOptions {
  /** Swipe that started at the left edge and travelled right. */
  onLeftEdgeSwipe?: () => void;
  /** Swipe that started at the right edge and travelled left. */
  onRightEdgeSwipe?: () => void;
}

export const useEdgeSwipe = (
  ref: React.RefObject<HTMLElement | null>,
  options: EdgeSwipeOptions,
): void => {
  // Keep callbacks in a ref so changing identities don't re-attach the listeners.
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;

    let tracking = false;
    let fromLeftEdge = false;
    let startX = 0;
    let startY = 0;
    let startTarget: EventTarget | null = null;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        startTarget = null;
        return;
      }
      const touch = event.touches[0];
      const width = element.clientWidth;
      const nearLeft = touch.clientX <= edgeZone;
      const nearRight = touch.clientX >= width - edgeZone;
      tracking = nearLeft || nearRight;
      fromLeftEdge = nearLeft;
      startX = touch.clientX;
      startY = touch.clientY;
      startTarget = tracking ? event.target : null;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touchTarget = startTarget;
      startTarget = null;
      if (event.touches.length !== 0 || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0];

      const dx = touch.clientX - startX;
      if (!isValidHorizontalSwipe({ x: startX, y: startY }, { x: touch.clientX, y: touch.clientY })) return;
      // Must travel toward the centre: left edge → rightward, right edge → leftward.
      if (fromLeftEdge && dx <= 0) return;
      if (!fromLeftEdge && dx >= 0) return;
      const fingerDirection: HorizontalFingerDirection = dx > 0 ? 'right' : 'left';
      // Let a markdown table/code block consume an inward swipe while it can
      // still scroll in that direction. At the boundary, the drawer gesture
      // remains available as the fallback navigation action.
      if (hasHorizontalScrollRoom(touchTarget, element, fingerDirection)) return;

      if (fromLeftEdge) optionsRef.current.onLeftEdgeSwipe?.();
      else optionsRef.current.onRightEdgeSwipe?.();
    };

    const onTouchCancel = () => {
      tracking = false;
      startTarget = null;
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [ref]);
};
