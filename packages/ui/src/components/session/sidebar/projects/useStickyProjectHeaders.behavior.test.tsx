import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  private readonly callback: IntersectionCallback;

  constructor(callback: IntersectionCallback) {
    this.callback = callback;
    TestIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  emit(element: Element, isIntersecting: boolean, top: number): void {
    if (this.disconnected || !this.observed.has(element)) return;
    const bounds = new DOMRect(0, top, 1, 1);
    const entry: IntersectionObserverEntry = {
      boundingClientRect: bounds,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: bounds,
      isIntersecting,
      rootBounds: new DOMRect(0, 100, 1, 1),
      target: element,
      time: 0,
    };
    this.callback([entry]);
  }
}

class TestMutationObserver {
  static instances: TestMutationObserver[] = [];
  observedRoot: Node | null = null;
  disconnected = false;
  private readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    TestMutationObserver.instances.push(this);
  }

  observe(root: Node): void {
    this.observedRoot = root;
  }

  disconnect(): void {
    this.disconnected = true;
    this.observedRoot = null;
  }

  trigger(): void {
    if (!this.disconnected) this.callback();
  }
}

const browser = new Window({ url: 'http://localhost' });
const globalDescriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  location: browser.location,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Text: browser.Text,
  DOMRect: browser.DOMRect,
  IntersectionObserver: TestIntersectionObserver,
  MutationObserver: TestMutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { createRoot } = await import('react-dom/client');
const { useStickyProjectHeaders, useStickySentinelObserver } = await import('./useStickyProjectHeaders');

type ObserverHarnessProps = {
  rootRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
};

const ActivityObserverHarness: React.FC<ObserverHarnessProps> = ({ rootRef, enabled }) => {
  const resolveSentinels = React.useCallback((): ReadonlyMap<string, HTMLElement | null> => {
    const activeNowSentinel = rootRef.current?.querySelector<HTMLElement>('[data-sidebar-activity-start="active-now"]');
    return activeNowSentinel
      ? new Map([['active-now', activeNowSentinel]])
      : new Map<string, HTMLElement | null>();
  }, [rootRef]);
  const stuckHeaders = useStickySentinelObserver({
    enabled,
    rootRef,
    resolveSentinels,
  });
  return <output data-sticky-state={[...stuckHeaders].join(',')} />;
};

type AttachedRootObserverHarnessProps = {
  rootRef: React.MutableRefObject<HTMLElement | null>;
  enabled: boolean;
};

const AttachedRootObserverHarness: React.FC<AttachedRootObserverHarnessProps> = ({ rootRef, enabled }) => {
  const resolveSentinels = React.useCallback((): ReadonlyMap<string, HTMLElement | null> => {
    const activeNowSentinel = rootRef.current?.querySelector<HTMLElement>('[data-sidebar-activity-start="active-now"]');
    return activeNowSentinel
      ? new Map([['active-now', activeNowSentinel]])
      : new Map<string, HTMLElement | null>();
  }, [rootRef]);
  const stuckHeaders = useStickySentinelObserver({
    enabled,
    rootRef,
    resolveSentinels,
  });
  return (
    <>
      <div ref={(element) => { rootRef.current = element; }}>
        <div data-sidebar-activity-start="active-now" />
      </div>
      <output data-sticky-state={[...stuckHeaders].join(',')} />
    </>
  );
};

type ProjectObserverHarnessProps = ObserverHarnessProps & {
  targetsRef: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  isDesktopShellRuntime: boolean;
};

const ProjectObserverHarness: React.FC<ProjectObserverHarnessProps> = ({
  rootRef,
  targetsRef,
  enabled,
  isDesktopShellRuntime,
}) => {
  const stuckHeaders = useStickyProjectHeaders({
    enabled,
    isDesktopShellRuntime,
    projectHeaderSentinelRefs: targetsRef,
    scrollContainerRef: rootRef,
  });
  return <output data-sticky-state={[...stuckHeaders].join(',')} />;
};

type Fixture = {
  host: HTMLElement;
  scrollRoot: HTMLElement;
  root: Root;
  rootRef: React.RefObject<HTMLElement | null>;
  targetsRef: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
};

const makeFixture = (): Fixture => {
  const host = document.createElement('div');
  const scrollRoot = document.createElement('div');
  host.append(scrollRoot);
  document.body.append(host);
  const rootRef = { current: scrollRoot };
  const targetsRef = { current: new Map<string, HTMLDivElement | null>() };
  return {
    host,
    scrollRoot,
    root: createRoot(host),
    rootRef,
    targetsRef,
  };
};

const makeSentinel = (): HTMLDivElement => document.createElement('div');

const stickyState = (host: HTMLElement): string => host.querySelector('output')?.dataset.stickyState ?? '';

const latestIntersectionObserver = (): TestIntersectionObserver => {
  const observer = TestIntersectionObserver.instances.at(-1);
  if (!observer) throw new Error('IntersectionObserver was not created');
  return observer;
};

const latestMutationObserver = (): TestMutationObserver => {
  const observer = TestMutationObserver.instances.at(-1);
  if (!observer) throw new Error('MutationObserver was not created');
  return observer;
};

const unmountFixture = async (fixture: Fixture): Promise<void> => {
  await act(async () => fixture.root.unmount());
  fixture.host.remove();
};

beforeEach(() => {
  TestIntersectionObserver.instances.length = 0;
  TestMutationObserver.instances.length = 0;
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of globalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('sticky sentinel observer lifecycle', () => {
  test('attaches a project sentinel that mounts after an initially empty window', async () => {
    const fixture = makeFixture();
    try {
      await act(async () => fixture.root.render(
        <ProjectObserverHarness
          rootRef={fixture.rootRef}
          targetsRef={fixture.targetsRef}
          enabled
          isDesktopShellRuntime
        />,
      ));

      const intersectionObserver = latestIntersectionObserver();
      expect(intersectionObserver.observed.size).toBe(0);

      const sentinel = makeSentinel();
      fixture.targetsRef.current.set('project-a', sentinel);
      fixture.scrollRoot.append(sentinel);
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(sentinel)).toBe(true);
      await act(async () => intersectionObserver.emit(sentinel, false, 50));
      expect(stickyState(fixture.host)).toBe('project-a');
    } finally {
      await unmountFixture(fixture);
    }
  });

  test('reads a scroll root ref attached during commit', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const rootRef: React.MutableRefObject<HTMLElement | null> = { current: null };
    document.body.append(host);
    try {
      await act(async () => root.render(
        <AttachedRootObserverHarness
          rootRef={rootRef}
          enabled
        />,
      ));

      const intersectionObserver = latestIntersectionObserver();
      const scrollRoot = rootRef.current;
      if (!scrollRoot) throw new Error('Scroll root was not attached');
      const sentinel = scrollRoot.querySelector<HTMLElement>('[data-sidebar-activity-start="active-now"]');
      if (!sentinel) throw new Error('Activity sentinel was not rendered');
      expect(intersectionObserver.observed.has(sentinel)).toBe(true);
      await act(async () => intersectionObserver.emit(sentinel, false, 50));
      expect(stickyState(host)).toBe('active-now');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  test('observes active-now after it mounts behind a long prefix', async () => {
    const fixture = makeFixture();
    try {
      for (let index = 0; index < 40; index += 1) fixture.scrollRoot.append(document.createElement('div'));
      await act(async () => fixture.root.render(
        <ActivityObserverHarness
          rootRef={fixture.rootRef}
          enabled
        />,
      ));

      const intersectionObserver = latestIntersectionObserver();
      expect(intersectionObserver.observed.size).toBe(0);

      const activeNowSentinel = makeSentinel();
      activeNowSentinel.setAttribute('data-sidebar-activity-start', 'active-now');
      fixture.scrollRoot.append(activeNowSentinel);
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(activeNowSentinel)).toBe(true);
      await act(async () => intersectionObserver.emit(activeNowSentinel, false, 50));
      expect(stickyState(fixture.host)).toBe('active-now');
    } finally {
      await unmountFixture(fixture);
    }
  });

  test('retains a stuck project while virtualization evicts and replaces other sentinels', async () => {
    const fixture = makeFixture();
    const projectA = makeSentinel();
    const projectB = makeSentinel();
    fixture.targetsRef.current.set('project-a', projectA);
    fixture.targetsRef.current.set('project-b', projectB);
    fixture.scrollRoot.append(projectA, projectB);
    try {
      await act(async () => fixture.root.render(
        <ProjectObserverHarness
          rootRef={fixture.rootRef}
          targetsRef={fixture.targetsRef}
          enabled
          isDesktopShellRuntime
        />,
      ));
      const intersectionObserver = latestIntersectionObserver();
      expect(intersectionObserver.observed.size).toBe(2);

      await act(async () => intersectionObserver.emit(projectA, false, 50));
      expect(stickyState(fixture.host)).toBe('project-a');

      fixture.targetsRef.current.delete('project-a');
      projectA.remove();
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(projectA)).toBe(false);
      expect(intersectionObserver.observed.has(projectB)).toBe(true);
      expect(stickyState(fixture.host)).toBe('project-a');

      const replacementB = makeSentinel();
      fixture.targetsRef.current.set('project-b', replacementB);
      projectB.remove();
      fixture.scrollRoot.append(replacementB);
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(projectB)).toBe(false);
      expect(intersectionObserver.observed.has(replacementB)).toBe(true);
      expect(stickyState(fixture.host)).toBe('project-a');

      const replacementA = makeSentinel();
      fixture.targetsRef.current.set('project-a', replacementA);
      fixture.scrollRoot.append(replacementA);
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(replacementA)).toBe(true);
      expect(stickyState(fixture.host)).toBe('');
    } finally {
      await unmountFixture(fixture);
    }
  });

  test('retains an activity header after virtualization evicts it behind a long prefix', async () => {
    const fixture = makeFixture();
    for (let index = 0; index < 40; index += 1) fixture.scrollRoot.append(document.createElement('div'));
    try {
      await act(async () => fixture.root.render(
        <ActivityObserverHarness
          rootRef={fixture.rootRef}
          enabled
        />,
      ));

      const intersectionObserver = latestIntersectionObserver();
      const activeNowSentinel = makeSentinel();
      activeNowSentinel.setAttribute('data-sidebar-activity-start', 'active-now');
      fixture.scrollRoot.append(activeNowSentinel);
      await act(async () => latestMutationObserver().trigger());
      await act(async () => intersectionObserver.emit(activeNowSentinel, false, 50));
      expect(stickyState(fixture.host)).toBe('active-now');

      activeNowSentinel.remove();
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(activeNowSentinel)).toBe(false);
      expect(stickyState(fixture.host)).toBe('active-now');
    } finally {
      await unmountFixture(fixture);
    }
  });

  test('rebinds a replaced sentinel without retaining the old target', async () => {
    const fixture = makeFixture();
    const oldSentinel = makeSentinel();
    fixture.targetsRef.current.set('project-a', oldSentinel);
    fixture.scrollRoot.append(oldSentinel);
    try {
      await act(async () => fixture.root.render(
        <ProjectObserverHarness
          rootRef={fixture.rootRef}
          targetsRef={fixture.targetsRef}
          enabled
          isDesktopShellRuntime
        />,
      ));
      const intersectionObserver = latestIntersectionObserver();
      expect(intersectionObserver.observed.has(oldSentinel)).toBe(true);
      await act(async () => intersectionObserver.emit(oldSentinel, false, 50));
      expect(stickyState(fixture.host)).toBe('project-a');

      const replacement = makeSentinel();
      oldSentinel.remove();
      fixture.targetsRef.current.set('project-a', replacement);
      fixture.scrollRoot.append(replacement);
      await act(async () => latestMutationObserver().trigger());

      expect(intersectionObserver.observed.has(oldSentinel)).toBe(false);
      expect(intersectionObserver.observed.has(replacement)).toBe(true);
      expect(stickyState(fixture.host)).toBe('');
      await act(async () => intersectionObserver.emit(replacement, false, 50));
      expect(stickyState(fixture.host)).toBe('project-a');
    } finally {
      await unmountFixture(fixture);
    }
  });

  test('clears sticky state and disconnects on disable', async () => {
    const fixture = makeFixture();
    const sentinel = makeSentinel();
    fixture.targetsRef.current.set('project-a', sentinel);
    fixture.scrollRoot.append(sentinel);
    try {
      await act(async () => fixture.root.render(
        <ProjectObserverHarness
          rootRef={fixture.rootRef}
          targetsRef={fixture.targetsRef}
          enabled
          isDesktopShellRuntime
        />,
      ));
      const intersectionObserver = latestIntersectionObserver();
      const mutationObserver = latestMutationObserver();
      await act(async () => intersectionObserver.emit(sentinel, false, 50));
      expect(stickyState(fixture.host)).toBe('project-a');

      await act(async () => fixture.root.render(
        <ProjectObserverHarness
          rootRef={fixture.rootRef}
          targetsRef={fixture.targetsRef}
          enabled={false}
          isDesktopShellRuntime
        />,
      ));

      expect(stickyState(fixture.host)).toBe('');
      expect(intersectionObserver.disconnected).toBe(true);
      expect(mutationObserver.disconnected).toBe(true);
    } finally {
      await unmountFixture(fixture);
    }
  });

  test('disconnects observers when the hook unmounts', async () => {
    const fixture = makeFixture();
    const sentinel = makeSentinel();
    fixture.targetsRef.current.set('project-a', sentinel);
    fixture.scrollRoot.append(sentinel);
    try {
      await act(async () => fixture.root.render(
        <ProjectObserverHarness
          rootRef={fixture.rootRef}
          targetsRef={fixture.targetsRef}
          enabled
          isDesktopShellRuntime
        />,
      ));
      const intersectionObserver = latestIntersectionObserver();
      const mutationObserver = latestMutationObserver();

      await act(async () => fixture.root.unmount());

      expect(intersectionObserver.disconnected).toBe(true);
      expect(mutationObserver.disconnected).toBe(true);
    } finally {
      fixture.host.remove();
    }
  });
});
