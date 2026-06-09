import { useEffect, useRef, useState, useMemo } from "react";
import type { DatasetRow } from "./types";

const FLASH_DURATION_MS = 1500;

export function useRowChangeDetection(rows: DatasetRow[]) {
  const prevRowsRef = useRef<Map<string, DatasetRow>>(new Map());
  const flashTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [flashingCells, setFlashingCells] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const pendingRowIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      if (row.updateStatus === "pending") {
        set.add(row._id);
      }
    }
    return set;
  }, [rows]);

  useEffect(() => {
    const prevMap = prevRowsRef.current;
    const newFlashes = new Set<string>();

    for (const row of rows) {
      const prev = prevMap.get(row._id);
      if (!prev) continue;

      const wasPending = prev.updateStatus === "pending";
      const isNowClear = row.updateStatus !== "pending";

      if (wasPending && isNowClear) {
        for (const [key, newVal] of Object.entries(row.data)) {
          const oldVal = prev.data[key];
          if (String(oldVal ?? "") !== String(newVal ?? "")) {
            newFlashes.add(`${row._id}:${key}`);
          }
        }
      }
    }

    const nextMap = new Map<string, DatasetRow>();
    for (const row of rows) {
      nextMap.set(row._id, { ...row, data: { ...row.data } });
    }
    prevRowsRef.current = nextMap;

    if (newFlashes.size > 0) {
      const startTimer = setTimeout(() => {
        setFlashingCells((prev) => {
          const merged = new Set(prev);
          for (const key of newFlashes) merged.add(key);
          return merged;
        });
        flashTimersRef.current.delete(startTimer);

        const clearTimer = setTimeout(() => {
          setFlashingCells((prev) => {
            const next = new Set(prev);
            for (const key of newFlashes) next.delete(key);
            return next;
          });
          flashTimersRef.current.delete(clearTimer);
        }, FLASH_DURATION_MS);
        flashTimersRef.current.add(clearTimer);
      }, 0);
      flashTimersRef.current.add(startTimer);
    }
  }, [rows]);

  return { flashingCells, pendingRowIds };
}
