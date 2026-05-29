"use client";

import { useState, useEffect } from "react";
import { SettingsPageLayout } from "@/components/settings/SettingsPageLayout";
import { SettingsHeader } from "@/components/settings/SettingsHeader";
import { SettingsTile } from "@/components/settings/SettingsTile";
import { ModelSideSheet } from "@/components/settings/ModelSideSheet";
import { MODEL_ROLES, MOCK_MODELS, type ModelRole } from "@/components/settings/types";
import { SkeletonList } from "@/components/settings/Skeleton";

export default function ModelSettingsPage() {
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({
    schemaInference: "anthropic/claude-sonnet-4-6",
    populateOrchestrator: "qwen/qwen3.7-max",
    investigateSubagent: "qwen/qwen3.7-max",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [activeSheet, setActiveSheet] = useState<{
    role: ModelRole;
  } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 1000);
    return () => clearTimeout(timer);
  }, []);

  const navItems = [
    {
      label: "Models",
      href: "/dashboard/settings/models",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
    },
    {
      label: "Account",
      href: "/dashboard/settings/account",
      disabled: true,
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      ),
    },
    {
      label: "Billing",
      href: "/dashboard/settings/billing",
      disabled: true,
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="14" x="2" y="5" rx="2" />
          <line x1="2" x2="22" y1="10" y2="10" />
        </svg>
      ),
    },
  ];

  async function handleRefresh() {
    setRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setRefreshing(false);
  }

  function handleModelSelect(role: ModelRole, modelSlug: string) {
    setSelectedModels((prev) => ({ ...prev, [role.key]: modelSlug }));
  }

  return (
    <SettingsPageLayout navItems={navItems}>
      <SettingsHeader
        title="Model Settings"
        subtitle="Configure AI models for different tasks. Models are fetched from OpenRouter."
      />

      <div className="space-y-2">
        {isLoading ? (
          <SkeletonList count={MODEL_ROLES.length} />
        ) : (
          MODEL_ROLES.map((role) => (
            <SettingsTile
              key={role.key}
              label={role.label}
              description={role.description}
              value={selectedModels[role.key]}
              onClick={() => setActiveSheet({ role })}
            />
          ))
        )}
      </div>

      {activeSheet && (
        <ModelSideSheet
          open={true}
          onClose={() => setActiveSheet(null)}
          title={`Select ${activeSheet.role.label} Model`}
          selectedModel={selectedModels[activeSheet.role.key]}
          models={MOCK_MODELS}
          onSelect={(slug) => handleModelSelect(activeSheet.role, slug)}
          onRefresh={handleRefresh}
          isRefreshing={refreshing}
        />
      )}
    </SettingsPageLayout>
  );
}