import type { ColumnType } from "./types";

const MAX_CHARS = 150;

function truncate(str: string): string {
  return str.length > MAX_CHARS ? str.slice(0, MAX_CHARS) + "…" : str;
}

function toSafeHttpUrl(input: string): string | null {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export function CellValue({
  value,
  type,
}: {
  value: unknown;
  type: ColumnType;
}) {
  const str = value == null || value === "" ? "" : String(value);

  if (!str) return <span className="text-muted/40">&mdash;</span>;

  if (type === "url") {
    const safeUrl = toSafeHttpUrl(str);
    if (!safeUrl) return <span title={str}>{truncate(str)}</span>;
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline underline-offset-2 decoration-blue-600/30 hover:decoration-blue-600/60"
        title={str}
        onClick={(e) => e.stopPropagation()}
      >
        {truncate(str)}
      </a>
    );
  }

  if (type === "boolean") {
    const yes =
      str === "true" || str === "Yes" || str === "yes" || str === "1";
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium border ${
          yes
            ? "border-emerald-600/15 bg-emerald-600/5 text-emerald-700"
            : "border-foreground/8 bg-foreground/[0.02] text-muted"
        }`}
      >
        {yes ? "Yes" : "No"}
      </span>
    );
  }

  if (type === "number") {
    return <span className="tabular-nums">{str}</span>;
  }

  return (
    <span title={str.length > MAX_CHARS ? str : undefined}>
      {truncate(str)}
    </span>
  );
}
