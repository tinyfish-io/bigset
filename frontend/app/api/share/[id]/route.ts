import { NextResponse } from "next/server";
import { fetchPublicDatasetMeta } from "@/lib/fetch-dataset-meta";

const CORS = { "Access-Control-Allow-Origin": "*" };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const dataset = await fetchPublicDatasetMeta(id);
  if (!dataset) {
    return NextResponse.json({ error: "Dataset not found" }, { status: 404, headers: CORS });
  }
  return NextResponse.json(dataset, { headers: CORS });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
