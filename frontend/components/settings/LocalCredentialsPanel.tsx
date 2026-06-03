"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  Fish,
  KeyRound,
  Loader2,
  X,
} from "lucide-react";
import {
  getLocalSetupStatus,
  saveOpenRouterApiKey,
  saveTinyFishApiKey,
  type LocalSetupStatus,
  type ServiceSetupStatus,
} from "@/lib/backend";
import { isLocalMode } from "@/lib/app-mode";
import { beginOpenRouterOAuth } from "@/lib/openrouter-oauth";

type ServiceName = "tinyfish" | "openrouter";

const SERVICE_COPY = {
  tinyfish: {
    title: "TinyFish",
    modalTitle: "TinyFish API key",
    description: "Search and fetch APIs for live dataset population.",
    inputPlaceholder: "tf_...",
    modalDescription: "BigSet verifies the key with a small search request.",
    helperHref:
      "https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2",
  },
  openrouter: {
    title: "OpenRouter",
    modalTitle: "OpenRouter API key",
    description: "Model access for schema inference and agents.",
    inputPlaceholder: "sk-or-...",
    modalDescription: "OAuth is preferred, but a direct API key works too.",
    helperHref: "https://openrouter.ai/settings/keys",
  },
} satisfies Record<
  ServiceName,
  {
    title: string;
    modalTitle: string;
    description: string;
    inputPlaceholder: string;
    modalDescription: string;
    helperHref: string;
  }
>;

export function LocalCredentialsPanel() {
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ServiceName | null>(null);

  useEffect(() => {
    if (!isLocalMode) return;

    let active = true;
    getLocalSetupStatus()
      .then((next) => {
        if (active) setStatus(next);
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
  }, []);

  if (!isLocalMode) return null;

  return (
    <section className="mb-8 border border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">
          Service credentials
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          Local BigSet stores these keys for this local workspace. Cloud
          deployments continue to use environment variables.
        </p>
      </div>

      {loadError ? (
        <div className="px-5 py-4 text-xs text-red-600 dark:text-red-400">
          {loadError}
        </div>
      ) : (
        <div className="divide-y divide-border">
          <CredentialRow
            icon={<Fish className="size-4" />}
            service="tinyfish"
            status={status?.services.tinyfish}
            loading={loading}
            onApiKey={() => setModal("tinyfish")}
          />
          <CredentialRow
            icon={<Bot className="size-4" />}
            service="openrouter"
            status={status?.services.openrouter}
            loading={loading}
            onApiKey={() => setModal("openrouter")}
            onOAuth={() => {
              void beginOpenRouterOAuth("/dashboard/settings/models");
            }}
          />
        </div>
      )}

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
    </section>
  );
}

function CredentialRow({
  icon,
  service,
  status,
  loading,
  onApiKey,
  onOAuth,
}: {
  icon: ReactNode;
  service: ServiceName;
  status?: ServiceSetupStatus;
  loading: boolean;
  onApiKey: () => void;
  onOAuth?: () => void;
}) {
  const copy = SERVICE_COPY[service];
  const connected = status?.configured ?? false;
  const detail = useCredentialDetail(status, loading);

  return (
    <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {copy.title}
            </h3>
            <StatusPill connected={connected} loading={loading} />
          </div>
          <p className="mt-1 text-xs leading-5 text-muted">
            {copy.description}
          </p>
          <p className="mt-1 text-xs text-foreground/70">{detail}</p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        {service === "openrouter" && onOAuth && (
          <button
            type="button"
            onClick={onOAuth}
            className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent px-3 py-2 text-xs font-semibold text-accent-text transition-opacity hover:opacity-90"
          >
            <KeyRound className="size-3.5" />
            {connected ? "Reconnect OAuth" : "Connect OAuth"}
          </button>
        )}
        <button
          type="button"
          onClick={onApiKey}
          className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.04]"
        >
          {connected ? "Change API key" : "Add API key"}
        </button>
        <a
          href={copy.helperHref}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
        >
          Get key
          <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  );
}

function StatusPill({
  connected,
  loading,
}: {
  connected: boolean;
  loading: boolean;
}) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted">
        <Loader2 className="size-3 animate-spin" />
        Checking
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        connected
          ? "border-green-500/30 text-green-700 dark:text-green-400"
          : "border-border text-muted"
      }`}
    >
      {connected && <CheckCircle2 className="size-3" />}
      {connected ? "Connected" : "Required"}
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
    if (status.connectionMethod === "oauth") return "Connected through OAuth";
    if (status.source === "env") return "Using key from .env";
    return "Connected through API key";
  }, [loading, status?.configured, status?.connectionMethod, status?.source]);
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = SERVICE_COPY[service];
  const isTinyFish = service === "tinyfish";

  async function handleSubmit() {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = isTinyFish
        ? await saveTinyFishApiKey(apiKey.trim())
        : await saveOpenRouterApiKey(apiKey.trim());
      onSaved(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setSaving(false);
    }
  }

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
          <label className="block text-xs font-medium text-muted">
            API key
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoFocus
              className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/30"
              placeholder={copy.inputPlaceholder}
            />
          </label>

          {error && (
            <div className="border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <a
              href={copy.helperHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
            >
              Get a key
              <ExternalLink className="size-3" />
            </a>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!apiKey.trim() || saving}
              className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent px-4 py-2 text-xs font-semibold text-accent-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              Verify and save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
