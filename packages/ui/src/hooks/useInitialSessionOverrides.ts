import * as React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { parseModelIdentifier } from '@/lib/modelIdentifier';

export type InitialSessionOverridesOptions = {
  /** Whether the host dialog is currently open. Used to gate load + prefill. */
  open: boolean;
  /** Directory passed to loadProviders/loadConfigAgents. Use null to skip per-directory loading. */
  projectDirectory: string | null;
  /** Source tag for the loadProviders trace (e.g. 'forkSessionDialog'). */
  source: string;
  /**
   * Optional extra deps that, when toggled together with `open`, re-run the prefill.
   * Use this for gates like `createInWorktree` that should reset the selectors to defaults.
   */
  extraPrefillTriggers?: ReadonlyArray<unknown>;
};

export type InitialSessionOverrides = {
  providerID: string;
  modelID: string;
  variant: string;
  agent: string;
  setProviderID: (next: string) => void;
  setModelID: (next: string) => void;
  setVariant: (next: string) => void;
  setAgent: (next: string) => void;
  /** Helper: re-prefill from current config defaults. Useful for explicit triggers. */
  prefillFromDefaults: () => void;
  providers: ReturnType<typeof useConfigStore.getState>['providers'];
  variantOptions: string[];
  hasVariantOptions: boolean;
  agentFilter: (candidate: { mode?: string }) => boolean;
  /** Set provider+model together; clears variant (matches ThinkingPill onModelChange pattern). */
  setProviderAndModel: (nextProviderID: string, nextModelID: string) => void;
};

/**
 * Shared session-override state used by dialogs that let the user pick a
 * provider / model / variant / agent before kicking off a new session or worktree.
 *
 * Encapsulates:
 *   - loading providers + agents when the dialog opens
 *   - prefilling selector defaults from settings (settingsDefaultModel/Agent/Variant)
 *     with a current-state fallback
 *   - falling back to the first available provider/model when the current
 *     selection is missing or invalidated by a refresh
 *   - resetting the variant when the selected model no longer offers it
 *   - exposing a stable agentFilter for primary-mode agents and a
 *     setProviderAndModel helper that mirrors the ThinkingPill pattern
 *
 * Initial state is read from the config store once via getState() so background
 * config refreshes do not clobber in-progress user edits.
 */
export const useInitialSessionOverrides = (
  options: InitialSessionOverridesOptions
): InitialSessionOverrides => {
  const { open, projectDirectory, source, extraPrefillTriggers = [] } = options;

  // Reactive: providers (so the fallback effect can re-validate selection)
  const providers = useConfigStore((state) => state.providers);
  // Stable function references
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadConfigAgents = useConfigStore((state) => state.loadAgents);
  const loadAgentsStoreAgents = useAgentsStore((state) => state.loadAgents);

  // Initial state snapshot — read once, don't subscribe to background config changes
  // (background config refreshes would otherwise clobber in-progress user edits).
  const initial = React.useMemo(() => {
    const s = useConfigStore.getState();
    return {
      providerID: s.currentProviderId,
      modelID: s.currentModelId,
      variant: s.currentVariant || '',
      agent: s.currentAgentName || '',
    };
  }, []);

  const [providerID, setProviderID] = React.useState(initial.providerID);
  const [modelID, setModelID] = React.useState(initial.modelID);
  const [variant, setVariant] = React.useState(initial.variant);
  const [agent, setAgent] = React.useState(initial.agent);

  // Snapshot of `resolveDefault*` logic — read from config store via getState().
  // Re-runs on `open` transition and any extraPrefillTriggers change.
  const prefillFromDefaults = React.useCallback(() => {
    const s = useConfigStore.getState();
    const settingsDefaultModel = s.settingsDefaultModel;
    let defaultProviderID = s.currentProviderId;
    let defaultModelID = s.currentModelId;
    if (settingsDefaultModel) {
      const parsed = parseModelIdentifier(settingsDefaultModel);
      if (parsed) {
        // Only adopt the parsed model if the config store has metadata for it;
        // this matches the previous `resolveDefaultModelSelection` behavior.
        const modelMetadata = s.getModelMetadata(parsed.providerId, parsed.modelId);
        if (modelMetadata) {
          defaultProviderID = parsed.providerId;
          defaultModelID = parsed.modelId;
        }
      }
    }
    const visibleAgents = s.getVisibleAgents();
    let defaultAgent = '';
    if (s.settingsDefaultAgent) {
      const found = visibleAgents.find((a) => a.name === s.settingsDefaultAgent);
      if (found) defaultAgent = found.name;
    }
    if (!defaultAgent) {
      defaultAgent =
        visibleAgents.find((a) => a.name === 'build')?.name || visibleAgents[0]?.name || '';
    }
    // Default variant
    let defaultVariant = '';
    if (s.settingsDefaultVariant) {
      const provider = s.providers.find((p) => p.id === defaultProviderID);
      const model = provider?.models.find((m: { id?: string }) => m.id === defaultModelID) as
        | { variants?: Record<string, unknown> }
        | undefined;
      if (model?.variants && Object.prototype.hasOwnProperty.call(model.variants, s.settingsDefaultVariant)) {
        defaultVariant = s.settingsDefaultVariant;
      }
    }
    if (!defaultVariant && s.currentProviderId === defaultProviderID && s.currentModelId === defaultModelID && s.currentVariant) {
      const provider = s.providers.find((p) => p.id === defaultProviderID);
      const model = provider?.models.find((m: { id?: string }) => m.id === defaultModelID) as
        | { variants?: Record<string, unknown> }
        | undefined;
      if (model?.variants && Object.prototype.hasOwnProperty.call(model.variants, s.currentVariant)) {
        defaultVariant = s.currentVariant;
      }
    }
    setProviderID(defaultProviderID);
    setModelID(defaultModelID);
    setVariant(defaultVariant);
    setAgent(defaultAgent);
  }, []);

  // Load on open
  React.useEffect(() => {
    if (!open) return;
    void loadProviders({ directory: projectDirectory, source });
    void loadConfigAgents({ directory: projectDirectory });
    void loadAgentsStoreAgents();
  }, [open, loadProviders, loadConfigAgents, loadAgentsStoreAgents, projectDirectory, source]);

  // Prefill on open + extra triggers
  React.useEffect(() => {
    if (!open) return;
    prefillFromDefaults();
    // extraPrefillTriggers are flattened into deps so the effect re-runs on each
    // declared trigger (e.g. when createInWorktree toggles back on).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefillFromDefaults, ...extraPrefillTriggers]);

  // Fallback to first available provider/model if current selection is missing
  React.useEffect(() => {
    if (!open || providers.length === 0) return;

    const provider = providers.find((p) => p.id === providerID) ?? providers[0];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const hasModel = models.some((m) => m.id === modelID);
    const fallbackModelID = models[0]?.id ?? '';

    if (provider?.id === providerID && hasModel) return;

    setProviderID(provider?.id ?? '');
    setModelID(hasModel ? modelID : fallbackModelID);
    setVariant('');
  }, [open, providers, providerID, modelID]);

  // Reset variant when the model no longer offers it
  const variantOptions = React.useMemo(() => {
    const provider = providers.find((p) => p.id === providerID);
    const model = provider?.models?.find((m) => m.id === modelID) as
      | { variants?: Record<string, unknown> }
      | undefined;
    return model?.variants ? Object.keys(model.variants) : [];
  }, [providers, providerID, modelID]);

  const hasVariantOptions = variantOptions.length > 0;

  React.useEffect(() => {
    if (!variant) return;
    if (!hasVariantOptions || !variantOptions.includes(variant)) {
      setVariant('');
    }
  }, [hasVariantOptions, variantOptions, variant]);

  const agentFilter = React.useCallback(
    (candidate: { mode?: string }) => isPrimaryMode(candidate.mode),
    []
  );

  const setProviderAndModel = React.useCallback((nextProviderID: string, nextModelID: string) => {
    setProviderID(nextProviderID);
    setModelID(nextModelID);
    setVariant('');
  }, []);

  return {
    providerID,
    modelID,
    variant,
    agent,
    setProviderID,
    setModelID,
    setVariant,
    setAgent,
    prefillFromDefaults,
    providers,
    variantOptions,
    hasVariantOptions,
    agentFilter,
    setProviderAndModel,
  };
};
