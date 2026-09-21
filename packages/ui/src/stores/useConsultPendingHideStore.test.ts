import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getPendingHiddenSessionIds,
  useConsultPendingHideStore,
} from './useConsultPendingHideStore';

const reset = () => {
  useConsultPendingHideStore.setState({ ids: new Set() });
};

describe('useConsultPendingHideStore', () => {
  beforeEach(reset);

  test('starts empty', () => {
    expect(useConsultPendingHideStore.getState().ids.size).toBe(0);
    expect(getPendingHiddenSessionIds().size).toBe(0);
  });

  test('registers a fork id and reports it pending-hidden', () => {
    useConsultPendingHideStore.getState().register('fork-1');

    expect(useConsultPendingHideStore.getState().isPendingHidden('fork-1')).toBe(true);
    expect(getPendingHiddenSessionIds().has('fork-1')).toBe(true);
    expect(useConsultPendingHideStore.getState().isPendingHidden('other')).toBe(false);
  });

  test('register is idempotent and ignores blank ids', () => {
    useConsultPendingHideStore.getState().register('fork-1');
    const before = useConsultPendingHideStore.getState().ids;

    useConsultPendingHideStore.getState().register('fork-1');
    useConsultPendingHideStore.getState().register('');
    useConsultPendingHideStore.getState().register('');

    expect(useConsultPendingHideStore.getState().ids).toBe(before);
  });

  test('release removes only a registered id and keeps the reference otherwise', () => {
    useConsultPendingHideStore.getState().register('fork-1');
    useConsultPendingHideStore.getState().register('fork-2');
    const before = useConsultPendingHideStore.getState().ids;

    useConsultPendingHideStore.getState().release('missing');
    expect(useConsultPendingHideStore.getState().ids).toBe(before);

    useConsultPendingHideStore.getState().release('fork-1');
    expect(useConsultPendingHideStore.getState().ids.has('fork-1')).toBe(false);
    expect(useConsultPendingHideStore.getState().ids.has('fork-2')).toBe(true);
  });

  test('releasing every id leaves an empty set', () => {
    useConsultPendingHideStore.getState().register('fork-1');
    useConsultPendingHideStore.getState().release('fork-1');

    expect(useConsultPendingHideStore.getState().ids.size).toBe(0);
    expect(useConsultPendingHideStore.getState().isPendingHidden('fork-1')).toBe(false);
  });

  test('resetForRuntimeSwitch drops every entry and is a no-op when already empty', () => {
    useConsultPendingHideStore.getState().register('fork-1');
    useConsultPendingHideStore.getState().resetForRuntimeSwitch();
    expect(useConsultPendingHideStore.getState().ids.size).toBe(0);

    const empty = useConsultPendingHideStore.getState().ids;
    useConsultPendingHideStore.getState().resetForRuntimeSwitch();
    expect(useConsultPendingHideStore.getState().ids).toBe(empty);
  });
});
