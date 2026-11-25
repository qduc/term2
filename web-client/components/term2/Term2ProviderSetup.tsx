'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { term2Client } from '../../lib/api/term2';
import type { ModelSummary, ProviderPresetEntry, SettingsProjection } from '../../lib/term2/types';
import { ADD_PROVIDER_ROUTE, ProvidersSection } from './settings/ProvidersSection';
import { Term2SetupDialog } from './Term2SetupDialog';

const paths = [
  { id: 'sign-in', label: 'Sign in with ChatGPT', hint: 'Use your ChatGPT account to connect Codex.' },
  { id: 'api-key', label: 'Use an API key', hint: 'Choose an AI service and paste a key from your account.' },
  { id: 'server', label: 'Connect a local or custom server', hint: 'Use a local model runner or your own server.' },
] as const;

export function Term2ProviderSetup({
  projection,
  models,
  modelsLoading,
  onReload,
  onModelsChanged,
  onContinue,
  onClose,
}: {
  projection: SettingsProjection;
  models: ModelSummary[];
  modelsLoading: boolean;
  onReload: () => Promise<SettingsProjection | null>;
  onModelsChanged: () => Promise<void>;
  onContinue: (model: ModelSummary) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<(typeof paths)[number]['id'] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ presets: ProviderPresetEntry[]; types: string[] } | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void term2Client
      .listProviderPresets(controller.signal)
      .then(setCatalog)
      .catch(() => {
        if (!controller.signal.aborted) setCatalogError(true);
      });
    return () => controller.abort();
  }, [attempt]);

  const currentProvider = projection.settings.providers.find((item) => item.id === provider);
  const available =
    currentProvider?.credential.configured && !currentProvider.disabled
      ? models.filter((item) => item.provider === provider)
      : [];
  const model = available.find((item) => item.id === selectedModel);
  const presets =
    catalog?.presets.filter(
      (item) =>
        path === 'sign-in' ||
        provider !== ADD_PROVIDER_ROUTE ||
        (path === 'server' ? item.category === 'local' : item.category !== 'local' && item.category !== 'subscription'),
    ) ?? [];

  const navigate = (id: string | null) => {
    setProvider(id ?? ADD_PROVIDER_ROUTE);
    setSelectedModel(null);
  };

  return (
    <Term2SetupDialog title="Connect an AI service" onClose={onClose} wide fixedHeight>
      {!path ? (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            Choose how Term2 will get replies. API keys are stored on this machine.
          </p>
          <div className="space-y-2">
            {paths.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="outline"
                className="h-auto w-full flex-col items-start gap-1 whitespace-normal px-3 py-3 text-left"
                onClick={() => {
                  setPath(option.id);
                  navigate(option.id === 'sign-in' ? 'codex' : ADD_PROVIDER_ROUTE);
                }}
              >
                {option.label}
                <span className="text-xs font-normal text-muted-foreground">{option.hint}</span>
              </Button>
            ))}
          </div>
        </>
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 mb-3"
            onClick={() => {
              if (provider !== ADD_PROVIDER_ROUTE && path !== 'sign-in') navigate(ADD_PROVIDER_ROUTE);
              else setPath(null);
            }}
          >
            <ArrowLeft /> Back
          </Button>
          {!catalog && provider === ADD_PROVIDER_ROUTE ? (
            catalogError ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-destructive">
                  Couldn’t load the available services.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCatalogError(false);
                    setAttempt(attempt + 1);
                  }}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading services…
              </p>
            )
          ) : (
            <ProvidersSection
              projection={projection}
              models={models}
              modelsLoading={modelsLoading}
              modelsChecked
              presets={presets}
              providerTypes={catalog?.types ?? []}
              routeProvider={provider}
              setupPath={path}
              onNavigate={navigate}
              onReload={onReload}
              onModelsChanged={onModelsChanged}
            />
          )}
          {available.length > 0 && !modelsLoading && (
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t pt-4">
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">Model for your new chats</p>
                <Select value={selectedModel ?? ''} onValueChange={setSelectedModel}>
                  <SelectTrigger aria-label="Model for your new chats">
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {available.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name ?? item.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" disabled={!model} onClick={() => model && onContinue(model)}>
                Continue setup
              </Button>
            </div>
          )}
        </>
      )}
    </Term2SetupDialog>
  );
}
