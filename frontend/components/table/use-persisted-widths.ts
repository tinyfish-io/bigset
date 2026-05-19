import { useCallback, useState } from "react";

function load<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function usePersistedColumnWidths(datasetId: string) {
  const key = `bigset:${datasetId}:colWidths`;
  const [widths, setWidths] = useState<Record<string, number>>(() => load(key, {}));

  const updateWidths = useCallback(
    (next: Record<string, number>) => {
      setWidths(next);
      save(key, next);
    },
    [key],
  );

  return [widths, updateWidths] as const;
}
