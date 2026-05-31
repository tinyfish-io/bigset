"use client";

interface SettingsHeaderProps {
  title: string;
  subtitle?: string;
}

export function SettingsHeader({ title, subtitle }: SettingsHeaderProps) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {subtitle && (
        <p className="text-sm text-muted mt-1">{subtitle}</p>
      )}
    </div>
  );
}