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
    throw new Error(message);
  }

  return res.json();
}
