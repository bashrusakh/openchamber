import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { isDesktopShell, requestFileAccess } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { isWindowsArm64 } from '@/lib/platform';
import { toast } from '@/components/ui';

type IdleInstanceTimeoutOption = { value: string; ms: number; labelKey: I18nKey };

/** The window the server applies when `idleInstanceTimeoutMs` is absent. */
const IDLE_INSTANCE_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;

/** `0` disables release and is a real choice, not the absent-key default. */
const IDLE_INSTANCE_TIMEOUT_OPTIONS: IdleInstanceTimeoutOption[] = [
  { value: '0', ms: 0, labelKey: 'settings.openchamber.opencodeCli.option.idleInstanceTimeout.never' },
  { value: '900000', ms: 15 * 60 * 1000, labelKey: 'settings.openchamber.opencodeCli.option.idleInstanceTimeout.15m' },
  { value: String(IDLE_INSTANCE_TIMEOUT_DEFAULT_MS), ms: IDLE_INSTANCE_TIMEOUT_DEFAULT_MS, labelKey: 'settings.openchamber.opencodeCli.option.idleInstanceTimeout.30m' },
  { value: '3600000', ms: 60 * 60 * 1000, labelKey: 'settings.openchamber.opencodeCli.option.idleInstanceTimeout.1h' },
  { value: '14400000', ms: 4 * 60 * 60 * 1000, labelKey: 'settings.openchamber.opencodeCli.option.idleInstanceTimeout.4h' },
];

/** A stored value the options do not cover reads as the default window. */
const idleInstanceTimeoutOptionValue = (timeoutMs: number): string =>
  IDLE_INSTANCE_TIMEOUT_OPTIONS.find((option) => option.ms === timeoutMs)?.value
  ?? String(IDLE_INSTANCE_TIMEOUT_DEFAULT_MS);

export const OpenCodeCliSettings: React.FC = () => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');
  const [idleInstanceTimeoutMs, setIdleInstanceTimeoutMs] = React.useState(IDLE_INSTANCE_TIMEOUT_DEFAULT_MS);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const showOpenCodeUpdateNotifications = useUIStore((state) => state.showOpenCodeUpdateNotifications);
  const setShowOpenCodeUpdateNotifications = useUIStore((state) => state.setShowOpenCodeUpdateNotifications);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadDesktopSettings();
        if (cancelled || !data) {
          return;
        }
        setValue(data.opencodeBinary ?? '');
        setIdleInstanceTimeoutMs(data.idleInstanceTimeoutMs ?? IDLE_INSTANCE_TIMEOUT_DEFAULT_MS);
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBrowse = React.useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!isDesktopShell()) {
      return;
    }

    try {
      const selected = await requestFileAccess();
      if (selected.success && selected.path && selected.path.trim().length > 0) {
        setValue(selected.path.trim());
      }
    } catch {
      // ignore
    }
  }, []);

  const handleSaveAndReload = React.useCallback(async () => {
    setIsSaving(true);
    try {
      // Strip a wrapping quote pair (Windows "Copy as path" pastes) — literal
      // quotes are never part of a real path.
      const trimmed = value.trim();
      const unquoted = trimmed.length >= 2
        && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
          || (trimmed.startsWith("'") && trimmed.endsWith("'")))
        ? trimmed.slice(1, -1).trim()
        : trimmed;
      await updateDesktopSettings({ opencodeBinary: unquoted });
      recordDeferredOpenCodeRestart('cli', { id: 'opencode-binary' });
      toast.success(t('settings.view.pendingRestart.saved'));
    } finally {
      setIsSaving(false);
    }
  }, [t, value]);

  const handleShowUpdateNotificationsChange = React.useCallback((enabled: boolean) => {
    setShowOpenCodeUpdateNotifications(enabled);
    void updateDesktopSettings({ showOpenCodeUpdateNotifications: enabled });
  }, [setShowOpenCodeUpdateNotifications]);

  // The server reads this key on every sweep, so the change applies without a
  // restart and needs no Save button.
  const handleIdleInstanceTimeoutChange = React.useCallback((nextValue: string) => {
    const option = IDLE_INSTANCE_TIMEOUT_OPTIONS.find((entry) => entry.value === nextValue);
    if (!option) {
      return;
    }
    setIdleInstanceTimeoutMs(option.ms);
    void updateDesktopSettings({ idleInstanceTimeoutMs: option.ms });
  }, []);

  return (
    <SettingsSection title={t('settings.openchamber.opencodeCli.title')}>
      <div className="space-y-0.5">
        <SettingsFieldRow
          settingsItem="sessions.opencode-binary"
          label={t('settings.openchamber.opencodeCli.field.binaryPath')}
          info={(
            <>
              {t('settings.openchamber.opencodeCli.tipPrefix')}
              {' '}
              <span className="font-mono">OPENCODE_BINARY</span>
              {' '}
              {t('settings.openchamber.opencodeCli.tipMiddle')}
              {' '}
              <span className="font-mono">~/.config/openchamber/settings.json</span>
              {'.'}
            </>
          )}
          alignEnd={false}
          controlClassName="@xl:w-[20rem]"
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('settings.openchamber.opencodeCli.field.binaryPathPlaceholder')}
            disabled={isLoading || isSaving}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleBrowse}
            disabled={isLoading || isSaving || !isDesktopShell()}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={t('settings.openchamber.opencodeCli.actions.browseAria')}
            title={t('settings.openchamber.opencodeCli.actions.browse')}
          >
            <Icon name="folder" className="h-4 w-4" />
          </Button>
        </SettingsFieldRow>

        <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
          {!isWindowsArm64() && (
            <SettingsCheckboxRow
              settingsItem="sessions.opencode-update-notifications"
              checked={showOpenCodeUpdateNotifications}
              onChange={handleShowUpdateNotificationsChange}
              label={t('settings.openchamber.opencodeCli.field.showUpdateNotifications')}
              ariaLabel={t('settings.openchamber.opencodeCli.field.showUpdateNotificationsAria')}
            />
          )}

          <div className="flex justify-start py-1.5">
            <Button
              type="button"
              size="xs"
              onClick={handleSaveAndReload}
              disabled={isLoading || isSaving}
              className="shrink-0 !font-normal"
            >
              {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
            </Button>
          </div>
        </SettingsInset>

        <SettingsInset>
          <SettingsFieldRow
            settingsItem="general.idle-instance-timeout"
            label={t('settings.openchamber.opencodeCli.field.idleInstanceTimeout')}
            info={t('settings.openchamber.opencodeCli.field.idleInstanceTimeoutInfo')}
          >
            <Select
              value={idleInstanceTimeoutOptionValue(idleInstanceTimeoutMs)}
              onValueChange={handleIdleInstanceTimeoutChange}
              disabled={isLoading}
            >
              <SelectTrigger
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                aria-label={t('settings.openchamber.opencodeCli.field.idleInstanceTimeout')}
              >
                <SelectValue>
                  {(selected) => {
                    const option = IDLE_INSTANCE_TIMEOUT_OPTIONS.find((entry) => entry.value === selected);
                    return option ? t(option.labelKey) : null;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {IDLE_INSTANCE_TIMEOUT_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        </SettingsInset>
      </div>
    </SettingsSection>
  );
};
