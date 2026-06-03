"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
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

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<LocalSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"tinyfish" | "openrouter" | null>(null);

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
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-surface">
        <img src="/BigSetLogo.png" alt="BigSet" className="h-[30px] dark:hidden" />
        <img src="/BigSetLogoDarkBG.png" alt="BigSet" className="h-[30px] hidden dark:block" />
        <span className="text-xs text-muted">Local setup</span>
      </header>

      <main className="flex-1 px-6 py-12">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-8">
            <p className="text-[11px] uppercase tracking-[0.15em] text-muted font-semibold">
              BigSet local
            </p>
            <h1 className="mt-2 text-[30px] font-bold tracking-tight leading-none">
              Connect your services
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
              This local copy uses one workspace. Add your own TinyFish
              and OpenRouter credentials here; the cloud build still uses env
              configuration when <span className="font-mono">PROD=1</span>.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <ServiceCard
              icon={<Fish className="size-5" />}
              title="TinyFish"
              description="Search and fetch APIs for live dataset population."
              status={status?.services.tinyfish}
              primaryLabel={
                status?.services.tinyfish.configured ? "Update key" : "Add API key"
              }
              onPrimary={() => setModal("tinyfish")}
              helperHref="https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2"
              helperLabel="Get a TinyFish key"
            />

            <ServiceCard
              icon={<Bot className="size-5" />}
              title="OpenRouter"
              description="Model access for schema inference and agents."
              status={status?.services.openrouter}
              primaryLabel={
                status?.services.openrouter.configured
                  ? "Reconnect OAuth"
                  : "Connect OAuth"
              }
              onPrimary={() => {
                void beginOpenRouterOAuth("/setup");
              }}
              secondaryLabel="Use API key"
              onSecondary={() => setModal("openrouter")}
              helperHref="https://openrouter.ai/settings/keys"
              helperLabel="OpenRouter keys"
            />
          </div>

          <div className="mt-8 flex items-center justify-between gap-4 border-t border-border pt-5">
            <p className="text-xs text-muted">
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
  icon,
  title,
  description,
  status,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  helperHref,
  helperLabel,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  status?: ServiceSetupStatus;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  helperHref: string;
  helperLabel: string;
}) {
  const connected = status?.configured ?? false;
  const detail = useMemo(() => {
    if (!connected) return "Not connected";
    if (status?.connectionMethod === "oauth") return "Connected through OAuth";
    if (status?.source === "env") return "Connected through .env";
    return "Connected through API key";
  }, [connected, status?.connectionMethod, status?.source]);

  return (
    <section className="border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-background text-foreground">
            {icon}
          </span>
          <div>
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">{detail}</p>
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
            connected
              ? "border-green-500/30 text-green-700 dark:text-green-400"
              : "border-border text-muted"
          }`}
        >
          {connected && <CheckCircle2 className="size-3" />}
          {connected ? "Connected" : "Required"}
        </span>
      </div>

      <p className="mt-5 min-h-10 text-sm leading-5 text-foreground/80">
        {description}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onPrimary}
          className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent px-3 py-2 text-xs font-semibold text-accent-text transition-opacity hover:opacity-90"
        >
          <KeyRound className="size-3.5" />
          {primaryLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button
            type="button"
            onClick={onSecondary}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.04]"
          >
            {secondaryLabel}
          </button>
        )}
        <a
          href={helperHref}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
        >
          {helperLabel}
          <ExternalLink className="size-3" />
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
  service: "tinyfish" | "openrouter";
  onClose: () => void;
  onSaved: (status: LocalSetupStatus) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            <h2 className="text-sm font-semibold">
              {isTinyFish ? "TinyFish API key" : "OpenRouter API key"}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {isTinyFish
                ? "BigSet verifies the key with a small search request."
                : "OAuth is preferred, but a direct API key works too."}
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
          <label className="block text-xs font-medium text-muted">
            API key
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              autoFocus
              className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:border-foreground/30"
              placeholder={isTinyFish ? "tf_..." : "sk-or-..."}
            />
          </label>

          {error && (
            <div className="border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <a
              href={
                isTinyFish
                  ? "https://agent.tinyfish.ai/api-keys?utm_source=github&utm_medium=organic&utm_campaign=bigset-developer-2026q2"
                  : "https://openrouter.ai/settings/keys"
              }
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
