import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { hasHorizontalScrollRoom, isValidHorizontalSwipe, useEdgeSwipe } from './useEdgeSwipe';

type TouchPoint = { clientX: number; clientY: number };
type GlobalOverride = Window | Window['document'] | Window['Element'] | Window['HTMLElement'] | Window['Node'] | Window['Event'] | boolean;

const dispatchTouch = (
  target: HTMLElement,
  type: 'touchstart' | 'touchend' | 'touchcancel',
  touches: TouchPoint[],
  changedTouches: TouchPoint[] = touches,
) => {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, {
    touches: { configurable: true, value: touches },
    changedTouches: { configurable: true, value: changedTouches },
  });
  target.dispatchEvent(event);
};

describe('useEdgeSwipe', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let main: HTMLElement;
  let target: HTMLElement;
  let root: Root;
  let descriptors: Map<string, PropertyDescriptor | undefined>;

  const setGlobal = (name: string, value: GlobalOverride) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const mount = async () => {
    let leftSwipes = 0;
    let rightSwipes = 0;
    const mainRef: React.RefObject<HTMLElement | null> = { current: main };
    const Harness = () => {
      useEdgeSwipe(mainRef, {
        onLeftEdgeSwipe: () => { leftSwipes += 1; },
        onRightEdgeSwipe: () => { rightSwipes += 1; },
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    return {
      get leftSwipes() { return leftSwipes; },
      get rightSwipes() { return rightSwipes; },
    };
  };

  const swipe = (start: TouchPoint, end: TouchPoint) => {
    act(() => {
      dispatchTouch(target, 'touchstart', [start]);
      dispatchTouch(target, 'touchend', [], [end]);
    });
  };

  beforeEach(() => {
    descriptors = new Map();
    windowInstance = new Window();
    setGlobal('window', windowInstance);
    setGlobal('document', windowInstance.document);
    setGlobal('Element', windowInstance.Element);
    setGlobal('HTMLElement', windowInstance.HTMLElement);
    setGlobal('Node', windowInstance.Node);
    setGlobal('Event', windowInstance.Event);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(windowInstance, 'Capacitor', {
      configurable: true,
      value: { getPlatform: () => 'android' },
    });

    host = document.createElement('div');
    main = document.createElement('main');
    target = document.createElement('span');
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: 360 });
    main.append(target);
    document.body.append(main, host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('opens from an Android edge when the target is not horizontally scrollable', async () => {
    const calls = await mount();

    swipe({ clientX: 72, clientY: 120 }, { clientX: 150, clientY: 124 });

    expect(calls.leftSwipes).toBe(1);
    expect(calls.rightSwipes).toBe(0);
  });

  test('defers a left-edge rightward swipe while a markdown code body can scroll left', async () => {
    const scroller = document.createElement('div');
    const code = document.createElement('code');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 80 },
    });
    scroller.append(code);
    main.replaceChildren(scroller);
    target = code;
    const calls = await mount();

    swipe({ clientX: 72, clientY: 120 }, { clientX: 150, clientY: 124 });

    expect(calls.leftSwipes).toBe(0);
    expect(calls.rightSwipes).toBe(0);
  });

  test('defers when a markdown text node can scroll left', () => {
    const scroller = document.createElement('div');
    const code = document.createElement('code');
    const text = document.createTextNode('markdown');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 80 },
    });
    code.append(text);
    scroller.append(code);
    main.replaceChildren(scroller);

    expect(hasHorizontalScrollRoom(text, main, 'right')).toBe(true);
  });

  test('opens at the left scroll boundary even when the target is a markdown code body', async () => {
    const scroller = document.createElement('div');
    const code = document.createElement('code');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    scroller.append(code);
    main.replaceChildren(scroller);
    target = code;
    const calls = await mount();

    swipe({ clientX: 72, clientY: 120 }, { clientX: 150, clientY: 124 });

    expect(calls.leftSwipes).toBe(1);
    expect(calls.rightSwipes).toBe(0);
  });

  test('defers a right-edge leftward swipe while a markdown table can scroll right', async () => {
    const scroller = document.createElement('div');
    const cell = document.createElement('td');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 80 },
    });
    scroller.append(cell);
    main.replaceChildren(scroller);
    target = cell;
    const calls = await mount();

    swipe({ clientX: 288, clientY: 120 }, { clientX: 190, clientY: 124 });

    expect(calls.leftSwipes).toBe(0);
    expect(calls.rightSwipes).toBe(0);
  });

  test('opens at the right scroll boundary even when the target is a markdown table cell', async () => {
    const scroller = document.createElement('div');
    const cell = document.createElement('td');
    scroller.style.overflowX = 'auto';
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 240 },
    });
    scroller.append(cell);
    main.replaceChildren(scroller);
    target = cell;
    const calls = await mount();

    swipe({ clientX: 288, clientY: 120 }, { clientX: 190, clientY: 124 });

    expect(calls.leftSwipes).toBe(0);
    expect(calls.rightSwipes).toBe(1);
  });

  test('does not inspect ancestors outside the gesture boundary', () => {
    const externalScroller = document.createElement('div');
    externalScroller.style.overflowX = 'auto';
    Object.defineProperties(externalScroller, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 80 },
    });
    document.body.append(externalScroller);

    expect(hasHorizontalScrollRoom(externalScroller, main, 'right')).toBe(false);
    expect(hasHorizontalScrollRoom(externalScroller, main, 'left')).toBe(false);
  });

  test('does not transition for non-edge, vertical, short, multitouch, or cancelled paths', async () => {
    const calls = await mount();

    swipe({ clientX: 140, clientY: 120 }, { clientX: 240, clientY: 120 });
    swipe({ clientX: 72, clientY: 120 }, { clientX: 140, clientY: 180 });
    swipe({ clientX: 72, clientY: 120 }, { clientX: 120, clientY: 124 });
    act(() => {
      dispatchTouch(target, 'touchstart', [
        { clientX: 72, clientY: 120 },
        { clientX: 74, clientY: 122 },
      ]);
      dispatchTouch(target, 'touchend', [], [{ clientX: 150, clientY: 124 }]);
      dispatchTouch(target, 'touchstart', [{ clientX: 72, clientY: 120 }]);
      dispatchTouch(target, 'touchend', [{ clientX: 74, clientY: 122 }], [{ clientX: 150, clientY: 124 }]);
      dispatchTouch(target, 'touchstart', [{ clientX: 72, clientY: 120 }]);
      dispatchTouch(target, 'touchcancel', [], []);
      dispatchTouch(target, 'touchend', [], [{ clientX: 150, clientY: 124 }]);
    });

    expect(calls.leftSwipes).toBe(0);
    expect(calls.rightSwipes).toBe(0);
  });
});

describe('isValidHorizontalSwipe', () => {
  test('keeps the existing distance and off-axis thresholds', () => {
    expect(isValidHorizontalSwipe({ x: 0, y: 0 }, { x: 64, y: 44.9 })).toBe(false);
    expect(isValidHorizontalSwipe({ x: 0, y: 0 }, { x: 64, y: 44.8 })).toBe(true);
    expect(isValidHorizontalSwipe({ x: 0, y: 0 }, { x: 64, y: 44.7 })).toBe(true);
    expect(isValidHorizontalSwipe({ x: 0, y: 0 }, { x: 63, y: 0 })).toBe(false);
  });
});
