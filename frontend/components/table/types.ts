export type ColumnType = "text" | "number" | "boolean" | "url" | "date";

export interface DatasetColumn {
  name: string;
  type: ColumnType;
  description?: string;
  isPrimaryKey?: boolean;
}

export interface DatasetMeta {
  _id: string;
  name: string;
  description: string;
  status: "live" | "paused" | "building" | "updating" | "failed";
  lastStatusError?: string;
  cadence: string;
  columns: DatasetColumn[];
}

export interface DatasetRow {
  _id: string;
  _creationTime: number;
  data: Record<string, unknown>;
  updateStatus?: "pending";
}
