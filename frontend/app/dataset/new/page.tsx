"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMutation, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";

type ColumnType = "text" | "number" | "boolean" | "url" | "date";

interface ProposedColumn {
  id: string;
  name: string;
  type: ColumnType;
  description: string;
}

type Cadence = "30m" | "6h" | "12h" | "daily" | "weekly";
type Step = "describe" | "generating" | "review";

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: "30m", label: "Every 30 min" },
  { value: "6h", label: "Every 6 hours" },
  { value: "12h", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const CADENCE_LABELS: Record<Cadence, string> = {
  "30m": "Every 30 min",
  "6h": "Every 6 hours",
  "12h": "Every 12 hours",
  daily: "Daily",
  weekly: "Weekly",
};

const COLUMN_TYPES: { value: ColumnType; label: string; icon: string }[] = [
  { value: "text", label: "Text", icon: "≡" },
  { value: "number", label: "Number", icon: "#" },
  { value: "boolean", label: "Boolean", icon: "■" },
  { value: "url", label: "URL", icon: "⇗" },
  { value: "date", label: "Date", icon: "☆" },
];

const MOCK_SCHEMAS: Record<string, ProposedColumn[]> = {
  default: [
    { id: "1", name: "Name", type: "text", description: "Primary identifier for each entry" },
    { id: "2", name: "Description", type: "text", description: "Brief summary of the entry" },
    { id: "3", name: "URL", type: "url", description: "Source website or reference link" },
    { id: "4", name: "Status", type: "text", description: "Current status or state" },
    { id: "5", name: "Last Updated", type: "date", description: "When this entry was last refreshed" },
  ],
  hiring: [
    { id: "1", name: "Company", type: "text", description: "Company name" },
    { id: "2", name: "Description", type: "text", description: "What the company does" },
    { id: "3", name: "Website", type: "url", description: "Company website" },
    { id: "4", name: "Hiring", type: "boolean", description: "Currently hiring engineers" },
    { id: "5", name: "Open Roles", type: "number", description: "Number of open engineering positions" },
    { id: "6", name: "Stage", type: "text", description: "Funding stage" },
    { id: "7", name: "Location", type: "text", description: "HQ or primary office location" },
    { id: "8", name: "Employees", type: "number", description: "Approximate employee count" },
    { id: "9", name: "LinkedIn", type: "url", description: "Company LinkedIn profile" },
  ],
  price: [
    { id: "1", name: "Product", type: "text", description: "Product or item name" },
    { id: "2", name: "Retailer", type: "text", description: "Store or seller name" },
    { id: "3", name: "Price", type: "number", description: "Current listed price" },
    { id: "4", name: "In Stock", type: "boolean", description: "Whether the item is available" },
    { id: "5", name: "URL", type: "url", description: "Direct link to product page" },
    { id: "6", name: "Shipping", type: "text", description: "Shipping cost or method" },
    { id: "7", name: "Last Checked", type: "date", description: "When price was last verified" },
  ],
  insurance: [
    { id: "1", name: "Provider", type: "text", description: "Insurance company name" },
    { id: "2", name: "Monthly Premium", type: "number", description: "Monthly cost of the policy" },
    { id: "3", name: "Deductible", type: "number", description: "Deductible amount" },
    { id: "4", name: "Coverage Type", type: "text", description: "Full, Basic, or Liability only" },
    { id: "5", name: "Website", type: "url", description: "Provider website" },
    { id: "6", name: "AM Best Rating", type: "text", description: "Financial strength rating" },
    { id: "7", name: "Customer Rating", type: "number", description: "Average customer review score" },
    { id: "8", name: "Quote Date", type: "date", description: "When quote was obtained" },
  ],
};

function pickMockSchema(prompt: string): ProposedColumn[] {
  const lower = prompt.toLowerCase();
  if (lower.includes("hiring") || lower.includes("companies") || lower.includes("yc") || lower.includes("startup")) return MOCK_SCHEMAS.hiring;
  if (lower.includes("price") || lower.includes("gpu") || lower.includes("stock") || lower.includes("retail")) return MOCK_SCHEMAS.price;
  if (lower.includes("insurance") || lower.includes("quote") || lower.includes("premium")) return MOCK_SCHEMAS.insurance;
  return MOCK_SCHEMAS.default;
}

function TypeSelector({ value, onChange }: { value: ColumnType; onChange: (v: ColumnType) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ColumnType)}
      className="border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-foreground/30"
    >
      {COLUMN_TYPES.map((t) => (
        <option key={t.value} value={t.value}>
          {t.icon} {t.label}
        </option>
      ))}
    </select>
  );
}

export default function NewDatasetPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();

  const [step, setStep] = useState<Step>("describe");
  const [prompt, setPrompt] = useState("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [columns, setColumns] = useState<ProposedColumn[]>([]);
  const [datasetName, setDatasetName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const generatingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createDataset = useMutation(api.datasets.create);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  function handleGenerate() {
    if (!prompt.trim()) return;
    setStep("generating");

    generatingTimeout.current = setTimeout(() => {
      const schema = pickMockSchema(prompt);
      setColumns(schema.map((c) => ({ ...c })));
      const words = prompt.trim().split(/\s+/).slice(0, 6);
      setDatasetName(
        words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
      );
      setStep("review");
    }, 2000);
  }

  function handleUpdateColumn(id: string, field: "name" | "type" | "description", value: string) {
    setColumns((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    );
  }

  function handleRemoveColumn(id: string) {
    setColumns((prev) => prev.filter((c) => c.id !== id));
  }

  function handleAddColumn() {
    setColumns((prev) => [
      ...prev,
      { id: String(Date.now()), name: "New Column", type: "text" as ColumnType, description: "" },
    ]);
  }

  async function handleConfirm() {
    if (isCreating) return;
    setIsCreating(true);
    const datasetId = await createDataset({
      name: datasetName,
      description: prompt,
      cadence: CADENCE_LABELS[cadence],
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        description: c.description || undefined,
      })),
    });
    router.push(`/dataset/${datasetId}`);
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border px-5 py-3 flex items-center justify-between bg-surface shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="hover:opacity-80 transition-opacity">
            <img src="/BigSetLogo.png" alt="BigSet" className="h-[26px]" />
          </Link>
          <span className="text-foreground/15">/</span>
          <h1 className="text-sm font-semibold tracking-tight">New Dataset</h1>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          {step === "describe" && (
            <div className="space-y-8">
              <div>
                <h2 className="text-[28px] font-bold tracking-tight leading-none">
                  Create a new dataset
                </h2>
                <p className="mt-2 text-sm text-muted">
                  Describe what data you want to collect. Our agents will figure out the schema and start populating it.
                </p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">What do you want to track?</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. YC companies that are currently hiring engineers, with their funding stage, location, and number of open roles"
                  rows={4}
                  className="w-full border border-border bg-surface px-4 py-3 text-sm outline-none placeholder:text-muted/50 focus:border-foreground/30 transition-colors resize-none"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Update frequency</label>
                <div className="flex flex-wrap gap-2">
                  {CADENCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setCadence(opt.value)}
                      className={`border px-3 py-1.5 text-xs font-medium transition-colors ${
                        cadence === opt.value
                          ? "border-foreground bg-foreground text-accent-text"
                          : "border-border bg-surface text-foreground hover:border-foreground/30"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleGenerate}
                disabled={!prompt.trim()}
                className="border border-accent bg-accent px-6 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90 disabled:opacity-30"
              >
                Generate Schema
              </button>
            </div>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center justify-center py-20 space-y-6">
              <div className="flex items-center gap-3">
                <div className="h-5 w-5 border-2 border-foreground/20 border-t-foreground rounded-full animate-spin" />
                <span className="text-sm font-medium">Analyzing your request...</span>
              </div>
              <div className="space-y-2 text-center">
                <p className="text-xs text-muted">Figuring out what columns and data sources to use</p>
                <p className="text-xs text-muted/60 max-w-sm">&ldquo;{prompt}&rdquo;</p>
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-8">
              <div>
                <h2 className="text-[28px] font-bold tracking-tight leading-none">
                  Review your schema
                </h2>
                <p className="mt-2 text-sm text-muted">
                  We proposed a schema based on your description. Edit column names, types, or remove ones you don&apos;t need.
                </p>
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium">Dataset name</label>
                <input
                  type="text"
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value)}
                  className="w-full border border-border bg-surface px-4 py-2.5 text-sm font-medium outline-none focus:border-foreground/30 transition-colors"
                />
              </div>

              <div className="border border-border bg-background px-4 py-3">
                <p className="text-[11px] uppercase tracking-wider text-muted font-medium mb-1">Your prompt</p>
                <p className="text-sm text-foreground/70">{prompt}</p>
                <div className="mt-2 flex items-center gap-3">
                  <span className="text-[11px] text-muted">
                    Cadence: {CADENCE_LABELS[cadence]}
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium">Columns ({columns.length})</label>
                  <button onClick={handleAddColumn} className="text-xs font-medium text-foreground hover:underline">
                    + Add column
                  </button>
                </div>

                <div className="border border-border bg-surface divide-y divide-border">
                  <div className="grid grid-cols-[1fr_120px_1fr_40px] gap-3 px-4 py-2 bg-background">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Name</span>
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Type</span>
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Description</span>
                    <span />
                  </div>

                  {columns.map((col) => (
                    <div key={col.id} className="grid grid-cols-[1fr_120px_1fr_40px] gap-3 px-4 py-2.5 items-center">
                      <input
                        type="text"
                        value={col.name}
                        onChange={(e) => handleUpdateColumn(col.id, "name", e.target.value)}
                        className="border border-border bg-background px-2 py-1 text-sm outline-none focus:border-foreground/30"
                      />
                      <TypeSelector value={col.type} onChange={(v) => handleUpdateColumn(col.id, "type", v)} />
                      <input
                        type="text"
                        value={col.description}
                        onChange={(e) => handleUpdateColumn(col.id, "description", e.target.value)}
                        className="border border-border bg-background px-2 py-1 text-xs text-muted outline-none focus:border-foreground/30"
                        placeholder="Optional description"
                      />
                      <button
                        onClick={() => handleRemoveColumn(col.id)}
                        className="text-muted hover:text-red-600 transition-colors text-center text-sm"
                        title="Remove column"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleConfirm}
                  className="border border-accent bg-accent px-6 py-2.5 text-sm font-semibold text-accent-text transition-opacity hover:opacity-90"
                >
                  Create Dataset
                </button>
                <button
                  onClick={() => setStep("describe")}
                  className="border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-foreground/[0.03] transition-colors"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
