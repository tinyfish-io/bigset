"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
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

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"tinyfish" | "llm" | null>(null);

  useEffect(() => {
    if (!isLocalMode) {
      router.replace("/dashboard");
      return;
    }

    getLocalSetupStatus()
      .then(setStatus)
      .finally(() => setLoading(false));
  }, [router]);

  const complete = status?.complete ?? false;

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-surface px-6 py-3">
        <img src="/BigSetLogo.png" alt="BigSet" className="h-[30px] dark:hidden" />
        <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-[30px] hidden dark:block" />
      </header>

      <main className="flex-1 px-5 py-10 sm:px-6 sm:py-12">
        <div className="mx-auto w-full max-w-4xl">
          <div className="mb-8 max-w-2xl">
            <h1 className="text-[32px] font-bold leading-none tracking-tight sm:text-[38px]">
              Connect your services
            </h1>
            <p className="mt-3 text-base leading-7 text-muted">
              Add TinyFish and your preferred LLM provider to start building
              live datasets.
            </p>
          </div>

          <div className="grid gap-4">
            <ServiceCard
              brand={
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
              }
              description="BigSet uses TinyFish's best-in-class search API to unlock real-time information."
              status={status?.services.tinyfish}
              primaryLabel={
                status?.services.tinyfish.configured ? "Update key" : "Add API key"
              }
              onPrimary={() => setModal("tinyfish")}
              helperHref="https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2"
              helperLabel="Need a TinyFish key?"
              helperDescription="Open the TinyFish API keys page"
            />

            <ServiceCard
              brand={<LlmProviderBrand provider={status?.services.llm.provider} />}
              description="BigSet uses your LLM provider for schema generation and dataset-building agents."
              status={status?.services.llm}
              primaryLabel={
                status?.services.llm.configured
                  ? "Update provider"
                  : "Choose provider"
              }
              onPrimary={() => setModal("llm")}
              helperHref="https://platform.openai.com/api-keys"
              helperLabel="Bring your own model"
              helperDescription="OpenAI, Anthropic, OpenRouter, or custom"
            />
          </div>

          <div className="mt-8 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-6 text-muted sm:text-base">
              {complete
                ? "Everything is connected. You can start building datasets."
                : "Complete both connections to continue."}
            </p>
            <button
              type="button"
              disabled={!complete}
              onClick={() => router.replace("/dashboard")}
              className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent px-5 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Complete setup
              <CheckCircle2 className="size-4" />
            </button>
          </div>
        </div>
      </main>

      {modal && (
        <ApiKeyModal
          service={modal}
          onClose={() => setModal(null)}
          onSaved={(next) => {
            setStatus(next);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

function ServiceCard({
  brand,
  description,
  status,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  helperHref,
  helperLabel,
  helperDescription,
}: {
  brand: ReactNode;
  description: string;
  status?: ServiceSetupStatus;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  helperHref: string;
  helperLabel: string;
  helperDescription: string;
}) {
  const connected = status?.configured ?? false;
  const detail = useMemo(() => {
    if (!connected) return "Not connected";
    if (status?.providerLabel) return status.providerLabel;
    if (status?.connectionMethod === "oauth") return "Connected through OAuth";
    if (status?.source === "env") return "Connected through .env";
    return "Connected through API key";
  }, [connected, status?.connectionMethod, status?.providerLabel, status?.source]);

  return (
    <section className="border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex h-9 items-center">{brand}</div>
          <p className="mt-2 text-sm text-muted">{detail}</p>
        </div>
        {connected && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
            <CheckCircle2 className="size-4" />
            Connected
          </span>
        )}
      </div>

      <p className="mt-6 max-w-2xl text-base leading-7 text-foreground/80">
        {description}
      </p>

      <div className="mt-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onPrimary}
            className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
          >
            <KeyRound className="size-4" />
            {primaryLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-foreground/[0.04]"
            >
              {secondaryLabel}
            </button>
          )}
        </div>
        <a
          href={helperHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
        >
          {helperLabel} {helperDescription}
          <ExternalLink className="size-4 shrink-0" />
        </a>
      </div>
    </section>
  );
}

function ApiKeyModal({
  service,
  onClose,
  onSaved,
}: {
  service: "tinyfish" | "llm";
  onClose: () => void;
  onSaved: (status: LocalSetupStatus) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<LlmProviderType>("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const helperHref = isTinyFish
    ? "https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2"
    : providerCopy.helperHref;
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
            <h2 className="text-sm font-semibold">
              {isTinyFish ? "TinyFish API key" : "LLM provider"}
            </h2>
            <p className="mt-1 text-xs text-muted">
              BigSet checks the provider endpoint and stores the key in your OS keychain.
            </p>
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
              placeholder={isTinyFish ? "tf_..." : providerCopy.apiKeyPlaceholder}
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
