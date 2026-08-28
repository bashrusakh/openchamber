import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { shouldDismissWorkspaceDrawer } from './useEdgeSwipe';

type SwipePoint = { x: number; y: number };
type GlobalOverride = Window | Window['document'] | Window['Element'] | Window['HTMLElement'] | Window['Node'] | boolean;

const start: SwipePoint = { x: 220, y: 100 };
const end: SwipePoint = { x: 300, y: 104 };

describe('shouldDismissWorkspaceDrawer', () => {
  let descriptors: Map<string, PropertyDescriptor | undefined>;
  let boundary: HTMLElement;
  let target: HTMLElement;

  const setGlobal = (name: string, value: GlobalOverride) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const setScrollableTarget = (scrollLeft: number) => {
    const scroller = document.createElement('div');
    target = document.createElement('span');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: scrollLeft },
    });
    scroller.append(target);
    boundary.replaceChildren(scroller);
    return scroller;
  };

  beforeEach(() => {
    const windowInstance = new Window();
    descriptors = new Map();
    setGlobal('window', windowInstance);
    setGlobal('document', windowInstance.document);
    setGlobal('Element', windowInstance.Element);
    setGlobal('HTMLElement', windowInstance.HTMLElement);
    setGlobal('Node', windowInstance.Node);
    boundary = document.createElement('section');
    target = document.createElement('div');
    boundary.append(target);
    document.body.append(boundary);
  });

  afterEach(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('dismisses an open full-screen drawer on a valid reverse swipe', () => {
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, target, boundary)).toBe(true);
  });

  test('defers a reverse swipe from a horizontally scrollable child with room', () => {
    setScrollableTarget(80);

    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, target, boundary)).toBe(false);
  });

  test('dismisses at the child scroll boundary', () => {
    setScrollableTarget(0);

    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, target, boundary)).toBe(true);
  });

  test('defers when any nested horizontal ancestor has room', () => {
    const outer = setScrollableTarget(0);
    const inner = document.createElement('div');
    const nestedTarget = document.createElement('span');
    inner.style.overflowX = 'auto';
    Object.defineProperties(inner, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 80 },
    });
    inner.append(nestedTarget);
    outer.replaceChildren(inner);
    target = nestedTarget;

    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, target, boundary)).toBe(false);
  });

  test('keeps vertical, forward, and insufficient swipes in the drawer', () => {
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, { x: 300, y: 180 }, target, boundary)).toBe(false);
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', { x: 300, y: 100 }, { x: 220, y: 104 }, target, boundary)).toBe(false);
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, { x: 250, y: 104 }, target, boundary)).toBe(false);
  });

  test('does not dismiss for multitouch or cancelled gestures', () => {
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', null, end, target, boundary)).toBe(false);
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, null, target, boundary)).toBe(false);
  });

  test('does not dismiss from interactive or editable targets', () => {
    const button = document.createElement('button');
    const input = document.createElement('input');
    const editable = document.createElement('div');
    const terminal = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    terminal.setAttribute('data-terminal-owner', 'main');

    for (const interactiveTarget of [button, input, editable, terminal]) {
      boundary.replaceChildren(interactiveTarget);
      target = interactiveTarget;
      expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, target, boundary)).toBe(false);
    }
  });

  test('does not dismiss while a non-collapsed text selection is active', () => {
    target.textContent = 'drawer text';
    const selection = window.getSelection();
    if (!selection) throw new Error('Expected a document selection in the test window');
    const range = document.createRange();

    try {
      selection.removeAllRanges();
      range.selectNodeContents(target);
      selection.addRange(range);
      expect(selection.isCollapsed).toBe(false);
      expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, target, boundary)).toBe(false);
    } finally {
      selection.removeAllRanges();
    }
  });

  test('does not dismiss a closed drawer, tablet panel, or target outside the boundary', () => {
    const externalTarget = document.createElement('div');
    document.body.append(externalTarget);
    expect(shouldDismissWorkspaceDrawer(false, 'drawer', start, end, target, boundary)).toBe(false);
    expect(shouldDismissWorkspaceDrawer(true, 'panel', start, end, target, boundary)).toBe(false);
    expect(shouldDismissWorkspaceDrawer(true, 'drawer', start, end, externalTarget, boundary)).toBe(false);
  });
});
