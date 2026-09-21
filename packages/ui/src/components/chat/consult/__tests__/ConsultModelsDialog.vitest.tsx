import React, { act } from 'react';
import { expect, test } from 'bun:test';
import type { Model } from '@opencode-ai/sdk/v2';

import type { ConsultAdvisorSelection } from '@/lib/consult/routing';
import type { ConsultSubmissionHandle, SubmitConsultMessageInput } from '@/lib/consult/submission';
import type { ConsultSubmissionCapture } from '../consultUi';
import { installConsultTestDom } from './consultTestDom';

/**
 * Consult Models dialog (WP2.2).
 *
 * The dialog owns the advisor options and calls the submission entry point
 * with the composer's captured payload; these tests pin that split: the acting
 * model is read-only, the advisor selection flows through `ModelMultiSelect`
 * into exact per-advisor selections, and no queue logic runs here.
 */

const createModel = (providerID: string, id: string, name: string): Model => ({
  id,
  providerID,
  name,
  api: { id, url: 'https://example.test/v1', npm: '@example/sdk' },
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    interleaved: false,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: 'active',
  options: {},
  headers: {},
  release_date: '2025-01-01',
});

const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'env' as const,
    env: [],
    options: {},
    models: [
      createModel('openai', 'gpt-5.5', 'GPT-5.5'),
      createModel('openai', 'gpt-5.4', 'GPT-5.4'),
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    source: 'env' as const,
    env: [],
    options: {},
    models: [createModel('anthropic', 'claude-sonnet-4', 'Claude Sonnet 4')],
  },
];

const capture: ConsultSubmissionCapture = {
  parentSessionId: 'ses_parent',
  directory: '/repo',
  runtimeKey: 'runtime-1',
  message: { content: 'explain the sync layer', text: 'explain the sync layer' },
  sendConfig: { providerID: 'openai', modelID: 'gpt-5.5', agent: 'build' },
};

const neverSettles = <T,>(): Promise<T> => new Promise<T>(() => {});

type DialogHarnessOptions = {
  advisorAgent?: string | null;
  captureResult?: ConsultSubmissionCapture | null;
};

const renderDialog = async (options: DialogHarnessOptions = {}) => {
  const restoreDom = installConsultTestDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const { ConsultModelsDialog } = await import('../ConsultModelsDialog');

  useConfigStore.setState({ providers, modelsMetadata: new Map() });

  const submitted: SubmitConsultMessageInput[] = [];
  const handles: ConsultSubmissionHandle[] = [];
  const submittedAdvisors: Array<readonly ConsultAdvisorSelection[]> = [];
  const openChanges: boolean[] = [];
  let captures = 0;

  const handle: ConsultSubmissionHandle = {
    runId: 'run-1',
    result: neverSettles(),
    cancel: () => {},
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <I18nProvider>
        <ConsultModelsDialog
          open
          onOpenChange={(next) => openChanges.push(next)}
          acting={{ providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' }}
          advisorAgent={options.advisorAgent === undefined ? 'build' : options.advisorAgent}
          captureSubmission={async () => {
            captures += 1;
            return options.captureResult === undefined ? capture : options.captureResult;
          }}
          onSubmitted={(submittedHandle, advisors) => {
            handles.push(submittedHandle);
            submittedAdvisors.push(advisors);
          }}
          submit={(input) => {
            submitted.push(input);
            return handle;
          }}
        />
      </I18nProvider>,
    );
  });

  const byText = (text: string, selector = 'button'): HTMLElement | null => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    return elements.find((element) => element.textContent?.trim() === text) ?? null;
  };

  return {
    byText,
    submitted,
    handles,
    submittedAdvisors,
    openChanges,
    captures: () => captures,
    handle,
    cleanup: async () => {
      await act(async () => root.unmount());
      restoreDom();
    },
  };
};

const addAdvisorModels = async (byText: (text: string, selector?: string) => HTMLElement | null) => {
  const addModel = byText('Add model');
  if (!addModel) throw new Error('Expected the add-model trigger');
  await act(async () => { addModel.click(); });

  const optionRows = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
  if (optionRows.length < 3) throw new Error(`Expected three model options, found ${optionRows.length}`);
  await act(async () => { optionRows[0].click(); });
  await act(async () => { optionRows[2].click(); });
};

test('shows the acting model read-only and requires two advisors', async () => {
  const view = await renderDialog();
  try {
    expect(document.body.textContent).toContain('Consult models');
    expect(document.body.textContent).toContain('GPT-5.5');
    expect(document.body.textContent).toContain('Acting model');
    expect(document.body.textContent).toContain('high');
    expect(document.body.textContent).toContain('Advisors receive your message');

    const submit = view.byText('Consult & send');
    if (!submit) throw new Error('Expected the consult submit button');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await addAdvisorModels(view.byText);
    expect(document.body.textContent).toContain('GPT-5.5');
    expect(document.body.textContent).toContain('Claude Sonnet 4');
    expect(submit.hasAttribute('disabled')).toBe(false);
  } finally {
    await view.cleanup();
  }
});

test('submits the captured payload with the exact advisor selections and options', async () => {
  const view = await renderDialog();
  try {
    await addAdvisorModels(view.byText);

    const sequential = view.byText('Sequential');
    const shortTimeout = view.byText('30 s');
    if (!sequential || !shortTimeout) throw new Error('Expected the mode and timeout chips');
    await act(async () => { sequential.click(); });
    await act(async () => { shortTimeout.click(); });

    const submit = view.byText('Consult & send');
    if (!submit) throw new Error('Expected the consult submit button');
    await act(async () => { submit.click(); });

    expect(view.captures()).toBe(1);
    expect(view.submitted).toHaveLength(1);
    expect(view.submitted[0]).toEqual({
      ...capture,
      advisors: [
        { providerID: 'openai', modelID: 'gpt-5.5', agent: 'build' },
        { providerID: 'anthropic', modelID: 'claude-sonnet-4', agent: 'build' },
      ],
      mode: 'sequential',
      timeoutMs: 30_000,
    });
    expect(view.handles).toEqual([view.handle]);
    // The composer receives the same selections the submission got, so a
    // refusal can name the rejected advisors.
    expect(view.submittedAdvisors).toEqual([view.submitted[0].advisors]);
    expect(view.openChanges).toEqual([false]);
  } finally {
    await view.cleanup();
  }
});

test('keeps the dialog open without submitting when the capture aborts', async () => {
  const view = await renderDialog({ captureResult: null });
  try {
    await addAdvisorModels(view.byText);
    const submit = view.byText('Consult & send');
    if (!submit) throw new Error('Expected the consult submit button');
    await act(async () => { submit.click(); });

    expect(view.captures()).toBe(1);
    expect(view.submitted).toHaveLength(0);
    expect(view.openChanges).toEqual([false]);
  } finally {
    await view.cleanup();
  }
});

test('disables the confirm when no primary advisor agent exists', async () => {
  const view = await renderDialog({ advisorAgent: null });
  try {
    await addAdvisorModels(view.byText);
    expect(document.body.textContent).toContain('No primary agent is available for advisors');
    const submit = view.byText('Consult & send');
    if (!submit) throw new Error('Expected the consult submit button');
    expect(submit.hasAttribute('disabled')).toBe(true);

    await act(async () => { submit.click(); });
    expect(view.captures()).toBe(0);
    expect(view.submitted).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});
