"use client";

export function SkeletonTile() {
  return (
    <div className="w-full flex items-center p-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="h-4 w-32 rounded bg-foreground/5 animate-pulse mb-2" />
        <div className="h-3 w-48 rounded bg-foreground/5 animate-pulse" />
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="hidden sm:flex items-center h-8 px-3 rounded-lg border border-border">
          <div className="h-3 w-24 rounded bg-foreground/5 animate-pulse" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonTile key={i} />
      ))}
    </div>
  );
}