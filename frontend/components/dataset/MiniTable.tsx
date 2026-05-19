const PREVIEW_COL_COUNT = 5;
const CELL_MAX_LEN = 20;

function truncate(str: string): string {
  return str.length > CELL_MAX_LEN ? str.slice(0, CELL_MAX_LEN) + "…" : str;
}

export function MiniTable({
  columns,
  rows,
}: {
  columns: { name: string }[];
  rows: Record<string, unknown>[];
}) {
  const previewCols = columns.slice(0, PREVIEW_COL_COUNT);

  return (
    <div className="overflow-hidden border border-border bg-surface">
      <table className="w-full text-[10px] leading-none">
        <thead>
          <tr className="border-b border-border bg-background">
            {previewCols.map((col, i) => (
              <th
                key={i}
                className="px-2 py-1.5 text-left font-semibold text-foreground/60 whitespace-nowrap uppercase tracking-wider"
                style={{ fontSize: "9px" }}
              >
                {col.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              {previewCols.map((col, j) => {
                const raw = row[col.name];
                const val = raw == null ? "" : String(raw);
                return (
                  <td
                    key={j}
                    // Session-replay masking: see DataRow.tsx for rationale.
                    data-ph-mask-text="true"
                    className={`px-2 py-1.5 whitespace-nowrap ${j === 0 ? "text-foreground/80 font-medium" : "text-muted"}`}
                  >
                    {truncate(val)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
