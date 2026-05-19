import type { ColumnType } from "./types";

const icons: Record<ColumnType, string> = {
  text: "≡",
  number: "#",
  boolean: "■",
  url: "⇗",
  date: "☆",
};

const colors: Record<ColumnType, string> = {
  text: "text-foreground/30",
  number: "text-violet-500/70",
  boolean: "text-emerald-500/70",
  url: "text-blue-500/70",
  date: "text-amber-500/70",
};

export function ColumnIcon({ type }: { type: ColumnType }) {
  return (
    <span className={`text-xs font-bold ${colors[type]}`}>{icons[type]}</span>
  );
}
