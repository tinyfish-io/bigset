"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  X,
} from "lucide-react";
import {
  getLocalSetupStatus,
  saveLlmProviderConfig,
  saveTinyFishApiKey,
  type LlmProviderType,
  type LocalSetupStatus,
  type ServiceSetupStatus,
} from "@/lib/backend";
import { isLocalMode } from "@/lib/app-mode";
import {
  LlmProviderBrand,
  LlmProviderSelector,
  llmProviderOption,
} from "@/components/settings/llm-providers";

type ServiceName = "tinyfish" | "llm";

const SERVICE_COPY = {
  tinyfish: {
    modalTitle: "TinyFish API key",
    description:
      "BigSet uses TinyFish's best-in-class search API to unlock real-time information.",
    inputPlaceholder: "tf_...",
    modalDescription: "BigSet verifies the key and stores it in your OS keychain.",
    helperHref:
      "https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2",
    helperLabel: "Need a TinyFish key?",
    helperDescription: "Open the TinyFish API keys page",
  },
  llm: {
    modalTitle: "LLM provider",
    description:
      "BigSet uses your LLM provider for schema generation and dataset-building agents.",
    inputPlaceholder: "API key",
    modalDescription:
      "BigSet checks the provider endpoint and stores the key in your OS keychain.",
    helperHref: "https://platform.openai.com/api-keys",
    helperLabel: "Bring your own model",
    helperDescription: "OpenAI, Anthropic, OpenRouter, or custom",
  },
} satisfies Record<
  ServiceName,
  {
    modalTitle: string;
    description: string;
    inputPlaceholder: string;
    modalDescription: string;
    helperHref: string;
    helperLabel: string;
    helperDescription: string;
  }
>;

export function LocalCredentialsPanel({
  onStatusChange,
}: {
  onStatusChange?: (status: LocalSetupStatus) => void;
} = {}) {
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ServiceName | null>(null);

  useEffect(() => {
    if (!isLocalMode) return;

    let active = true;
    getLocalSetupStatus()
      .then((next) => {
        if (active) {
          setStatus(next);
          onStatusChange?.(next);
        }
      })
      .catch((err) => {
        if (active) {
          setLoadError(
            err instanceof Error
              ? err.message
              : "Could not load local credentials",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [onStatusChange]);

  if (!isLocalMode) return null;

  return (
    <section className="mb-10">
      <div className="mb-4 max-w-2xl">
        <h2 className="text-sm font-semibold text-foreground">
          Service credentials
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Add TinyFish and your preferred LLM provider for live datasets. Local
          keys stay in your OS keychain.
        </p>
      </div>

      {loadError ? (
        <div className="border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {loadError}
        </div>
      ) : (
        <div className="grid gap-4">
          <CredentialCard
            service="tinyfish"
            status={status?.services.tinyfish}
            loading={loading}
            onApiKey={() => setModal("tinyfish")}
          />
          <CredentialCard
            service="llm"
            status={status?.services.llm}
            loading={loading}
            onApiKey={() => setModal("llm")}
          />
        </div>
      )}

      {modal && (
        <ApiKeyModal
          service={modal}
          onClose={() => setModal(null)}
          onSaved={(next) => {
            setStatus(next);
            onStatusChange?.(next);
            setModal(null);
          }}
        />
      )}
    </section>
  );
}

function CredentialCard({
  service,
  status,
  loading,
  onApiKey,
}: {
  service: ServiceName;
  status?: ServiceSetupStatus;
  loading: boolean;
  onApiKey: () => void;
}) {
  const copy = SERVICE_COPY[service];
  const connected = status?.configured ?? false;
  const detail = useCredentialDetail(status, loading);

  return (
    <section className="border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex h-9 items-center">
            <ServiceBrand service={service} provider={status?.provider} />
          </div>
          <p className="mt-2 text-sm text-muted">{detail}</p>
        </div>
        <StatusLabel connected={connected} loading={loading} />
      </div>

      <p className="mt-6 max-w-2xl text-base leading-7 text-foreground/80">
        {copy.description}
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <button
          type="button"
          onClick={onApiKey}
          className="inline-flex w-fit items-center gap-2 rounded-lg border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
        >
          <KeyRound className="size-4" />
          {service === "llm" ? (connected ? "Update provider" : "Choose provider") : connected ? "Update key" : "Add API key"}
        </button>
        <a
          href={copy.helperHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
        >
          {copy.helperLabel} {copy.helperDescription}
          <ExternalLink className="size-4 shrink-0" />
        </a>
      </div>
    </section>
  );
}

function ServiceBrand({
  service,
  provider,
}: {
  service: ServiceName;
  provider?: LlmProviderType;
}) {
  if (service === "tinyfish") {
    return (
      <>
        <img
          src="https://www.tinyfish.ai/TF-Logos/Horizontal%20Logo/SVG/TF_Horizontal.svg"
          alt="TinyFish"
          className="h-8 w-auto dark:hidden"
        />
        <img
          src="/logos/engines/tinyfish-wordmark-dark.svg"
          alt="TinyFish"
          className="hidden h-8 w-auto dark:block"
        />
      </>
    );
  }

  return <LlmProviderBrand provider={provider} />;
}

function StatusLabel({
  connected,
  loading,
}: {
  connected: boolean;
  loading: boolean;
}) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted">
        <Loader2 className="size-4 animate-spin" />
        Checking
      </span>
    );
  }

  if (!connected) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
      <CheckCircle2 className="size-4" />
      Connected
    </span>
  );
}

function useCredentialDetail(
  status: ServiceSetupStatus | undefined,
  loading: boolean,
) {
  return useMemo(() => {
    if (loading) return "Checking connection...";
    if (!status?.configured) return "Not connected";
    if (status.providerLabel) return status.providerLabel;
    if (status.connectionMethod === "oauth") return "Connected through OAuth";
    if (status.source === "env") return "Connected through .env";
    return "Connected through API key";
  }, [loading, status?.configured, status?.connectionMethod, status?.providerLabel, status?.source]);
}

function ApiKeyModal({
  service,
  onClose,
  onSaved,
}: {
  service: ServiceName;
  onClose: () => void;
  onSaved: (status: LocalSetupStatus) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<LlmProviderType>("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = SERVICE_COPY[service];
  const isTinyFish = service === "tinyfish";
  const providerCopy = llmProviderOption(provider);

  function handleProviderChange(next: LlmProviderType) {
    setProvider(next);
    setBaseUrl("");
  }

  async function handleSubmit() {
    if (saving) return;
    if (isTinyFish && !apiKey.trim()) return;
    if (!isTinyFish && provider !== "custom" && !apiKey.trim()) return;
    if (!isTinyFish && provider === "custom" && !baseUrl.trim()) {
      setError("Custom providers require a base URL");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const next = isTinyFish
        ? await saveTinyFishApiKey(apiKey.trim())
        : await saveLlmProviderConfig({
            provider,
            apiKey: apiKey.trim(),
            defaultModel: llmProviderOption(provider).defaultModel,
            baseUrl: provider === "custom" ? baseUrl.trim() : undefined,
          });
      onSaved(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setSaving(false);
    }
  }

  const helperHref = isTinyFish ? copy.helperHref : providerCopy.helperHref;
  const helperLabel = !isTinyFish && provider === "custom" ? "Provider docs" : "Get a key";
  const canSubmit =
    !saving &&
    (isTinyFish
      ? !!apiKey.trim()
      : provider === "custom"
        ? !!baseUrl.trim()
        : !!apiKey.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-foreground/20 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{copy.modalTitle}</h2>
            <p className="mt-1 text-xs text-muted">{copy.modalDescription}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-foreground/[0.05] hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {!isTinyFish && (
            <fieldset>
              <legend className="text-xs font-medium text-muted">Provider</legend>
              <LlmProviderSelector value={provider} onChange={handleProviderChange} />
            </fieldset>
          )}

          {!isTinyFish && provider === "custom" && (
            <label className="block text-xs font-medium text-muted">
              Base URL
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/30"
                placeholder="http://localhost:1234 (LM Studio) or https://your-provider.example/v1"
              />
            </label>
          )}

          <label className="block text-xs font-medium text-muted">
            API key{!isTinyFish && provider === "custom" ? " (optional)" : ""}
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoFocus
              className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/30"
              placeholder={isTinyFish ? copy.inputPlaceholder : providerCopy.apiKeyPlaceholder}
            />
          </label>

          {error && (
            <div className="border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <a
              href={helperHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              {helperLabel}
              <ExternalLink className="size-3" />
            </a>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent px-4 py-2 text-xs font-semibold text-accent-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Verify and save to keychain
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
