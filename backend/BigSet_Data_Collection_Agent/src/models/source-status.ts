import { z } from "zod";

export const sourceStatusSchema = z.enum([
  "extract_now",
  "requires_navigation",
  "requires_form_submission",
  "requires_detail_page_followup",
  "irrelevant",
  "duplicate",
  "blocked",
  "low_value",
]);

export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const AGENT_STATUSES: SourceStatus[] = [
  "requires_navigation",
  "requires_form_submission",
  "requires_detail_page_followup",
];

export function statusNeedsAgent(status: SourceStatus): boolean {
  return AGENT_STATUSES.includes(status);
}
