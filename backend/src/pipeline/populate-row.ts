export type PopulateCellValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface PopulateRuntimeRow {
  cells: Record<string, PopulateCellValue>;
  sourceUrls: string[];
  evidence: Array<{
    columnName: string;
    sourceUrl: string;
    quote: string;
  }>;
  needsReview: boolean;
}

/** Row emitted by a parallel worker before global merge. */
export interface PopulateCandidateRow extends PopulateRuntimeRow {
  extractionConfidence: number;
  primaryKey: string;
}
