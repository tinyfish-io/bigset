import { useCallback, useMemo, useState } from "react";

function toggleAdjacent<I>(
  rows: I[],
  rowIndex: number,
  isSelected: (id: I) => boolean,
  toggle: (id: I) => void,
) {
  const checked = isSelected(rows[rowIndex]);
  if (checked) {
    for (let i = rowIndex; i < rows.length; i++) {
      if (!isSelected(rows[i])) break;
      toggle(rows[i]);
    }
  } else {
    const firstSelected = rows.findIndex((r) => isSelected(r));
    if (firstSelected > rowIndex) {
      for (let i = rowIndex; i < firstSelected; i++) toggle(rows[i]);
      return;
    }
    for (let i = rowIndex; i >= 0; i--) {
      if (isSelected(rows[i])) break;
      toggle(rows[i]);
    }
  }
}

export function useSelection(rowIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const has = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === rowIds.length ? new Set() : new Set(rowIds),
    );
  }, [rowIds]);

  const shiftToggle = useCallback(
    (id: string) => {
      const idx = rowIds.indexOf(id);
      if (idx === -1) return;
      setSelected((prev) => {
        const next = new Set(prev);
        toggleAdjacent(
          rowIds,
          idx,
          (r) => next.has(r),
          (r) => (next.has(r) ? next.delete(r) : next.add(r)),
        );
        return next;
      });
    },
    [rowIds],
  );

  const clear = useCallback(() => setSelected(new Set()), []);

  const allState: boolean | "indeterminate" = useMemo(() => {
    if (selected.size === 0) return false;
    if (selected.size === rowIds.length) return true;
    return "indeterminate";
  }, [selected.size, rowIds.length]);

  return { selected, has, toggle, toggleAll, shiftToggle, clear, allState };
}
