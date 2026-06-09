"use client";

import type { LlmProviderType } from "@/lib/backend";

export type LlmProviderOption = {
  value: LlmProviderType;
  label: string;
  description: string;
  defaultModel: string;
  apiKeyPlaceholder: string;
  helperHref: string;
  iconSrc?: string;
  wordmarkSrc?: string;
};

export const LLM_PROVIDER_OPTIONS: LlmProviderOption[] = [
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Use OpenRouter model slugs.",
    defaultModel: "anthropic/claude-sonnet-4.6",
    apiKeyPlaceholder: "sk-or-...",
    helperHref: "https://openrouter.ai/settings/keys",
    iconSrc: "/logos/providers/openrouter.svg",
    wordmarkSrc: "/logos/providers/openrouter-wordmark.svg",
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "Use an OpenAI API key directly.",
    defaultModel: "gpt-5.4-mini",
    apiKeyPlaceholder: "sk-...",
    helperHref: "https://platform.openai.com/api-keys",
    iconSrc: "/logos/providers/openai.svg",
    wordmarkSrc: "/logos/providers/openai.svg",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Use a Claude API key directly.",
    defaultModel: "claude-sonnet-4-6",
    apiKeyPlaceholder: "sk-ant-...",
    helperHref: "https://console.anthropic.com/settings/keys",
    iconSrc: "/logos/providers/anthropic.svg",
    wordmarkSrc: "/logos/providers/anthropic.svg",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Use LM Studio or any OpenAI-compatible base URL.",
    defaultModel: "",
    apiKeyPlaceholder: "Optional — leave blank for LM Studio",
    helperHref: "https://lmstudio.ai/docs/app/api/endpoints/openai",
  },
];

export function llmProviderOption(value: LlmProviderType) {
  return (
    LLM_PROVIDER_OPTIONS.find((option) => option.value === value) ??
    LLM_PROVIDER_OPTIONS[0]
  );
}

export function LlmProviderLogo({
  provider,
  variant = "wordmark",
  className = "",
}: {
  provider: LlmProviderType;
  variant?: "icon" | "wordmark";
  className?: string;
}) {
  const option = llmProviderOption(provider);

  if (provider === "custom") {
    return (
      <span className={`text-base font-semibold tracking-tight text-foreground ${className}`}>
        Custom
      </span>
    );
  }

  const src = variant === "icon" ? option.iconSrc : option.wordmarkSrc;

  return (
    <img
      src={src}
      alt={option.label}
      className={`${variant === "icon" ? "size-7 object-contain" : "h-7 w-auto max-w-36 object-contain"} dark:invert ${className}`}
    />
  );
}

export function LlmProviderBrand({ provider }: { provider?: LlmProviderType }) {
  if (provider) {
    return (
      <div className="flex items-center gap-2 text-foreground">
        <LlmProviderLogo provider={provider} variant="wordmark" className="h-8 max-w-44" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-foreground">
      <span className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-sm font-bold">
        AI
      </span>
      <span className="text-xl font-semibold tracking-tight">LLM Provider</span>
    </div>
  );
}

export function LlmProviderSelector({
  value,
  onChange,
}: {
  value: LlmProviderType;
  onChange: (provider: LlmProviderType) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {LLM_PROVIDER_OPTIONS.map((option) => {
        const selected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={`rounded-lg border px-3 py-3 text-left transition-colors ${
              selected
                ? "border-foreground/40 bg-foreground/[0.04]"
                : "border-border bg-background hover:bg-foreground/[0.03]"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex h-8 min-w-0 items-center">
                <LlmProviderLogo provider={option.value} variant="wordmark" />
              </div>
              <span
                className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border ${
                  selected ? "border-foreground" : "border-muted/40"
                }`}
                aria-hidden="true"
              >
                {selected && <span className="size-2 rounded-full bg-foreground" />}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted">{option.description}</p>
          </button>
        );
      })}
    </div>
  );
}
