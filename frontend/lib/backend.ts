export interface InferredSchema {
  dataset_name: string;
  description: string;
  columns: InferredColumn[];
  primary_key: string;
  retrieval_strategy: "search_fetch" | "browser" | "hybrid";
  source_hint: string;
}

export interface InferredColumn {
  name: string;
  display_name: string;
  type: "string" | "url" | "date" | "number" | "boolean" | "enum";
  is_primary_key: boolean;
  is_enumerable: boolean;
  retrieval_hint: string;
  nullable: boolean;
}

export interface PopulateColumn {
  name: string;
  type: "text" | "number" | "boolean" | "url" | "date";
  description?: string;
  nullable?: boolean;
}

export interface PopulateResult {
  success: boolean;
  result: PopulateRunSummary;
}

export interface PopulateRunSummary {
  action: string;
  datasetId: string;
  success: boolean;
  validationState?: "accepted_full" | "accepted_partial" | "rejected";
  committedRows?: {
    clearedRowCount?: number;
    insertedRowCount: number;
  };
  rejectionReasons: string[];
  validationIssues: string[];
  rowCount: number;
  sampleRows: Array<{
    cells: Record<string, unknown>;
    sourceUrls: string[];
    evidence: Array<{
      columnName: string;
      sourceUrl: string;
      quote: string;
    }>;
    needsReview: boolean;
  }>;
  productionValidation?: {
    state: "accepted_full" | "accepted_partial" | "rejected";
    isValid: boolean;
    score: number;
    rowCount: number;
    safeRowCount: number;
    requestedCellCompletenessRatio: number;
    sourceUrlCoverageRatio: number;
    evidenceCoverageRatio: number;
    expectedEntityCoverageRatio: number;
    expectedEntities: string[];
    missingExpectedEntities: string[];
    coveragePolicy: "partial_allowed" | "full_required";
    targetSource: string;
    criticalIssues: string[];
    warnings: string[];
  };
  metrics?: Record<string, unknown>;
}

export class PopulateApiError extends Error {
  readonly status: number;
  readonly result?: PopulateRunSummary;

  constructor(input: {
    message: string;
    status: number;
    result?: PopulateRunSummary;
  }) {
    super(input.message);
    this.name = "PopulateApiError";
    this.status = input.status;
    this.result = input.result;
  }
}

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3501";

export async function inferSchema(
  prompt: string,
  token: string,
): Promise<InferredSchema> {
  const res = await fetch(`${BACKEND_URL}/infer-schema`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error || `Backend error (${res.status})`;
    throw new PopulateApiError({
      message,
      status: res.status,
      result: body?.result,
    });
  }

  return res.json();
}

export async function populate(
  datasetId: string,
  datasetName: string,
  description: string,
  columns: PopulateColumn[],
  token: string,
): Promise<PopulateResult> {
  const res = await fetch(`${BACKEND_URL}/populate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ datasetId, datasetName: datasetName, description, columns }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error || `Backend error (${res.status})`;
    throw new PopulateApiError({
      message,
      status: res.status,
      result: body?.result,
    });
  }

  return res.json();
}
