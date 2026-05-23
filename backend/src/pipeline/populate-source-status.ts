import {
  populateSourceStatusSchema,
  type PopulateSourceStatus,
} from "./types.js";

export type { PopulateSourceStatus } from "./types.js";
export { populateSourceStatusSchema } from "./types.js";

export const AGENT_TRIAGE_STATUSES: PopulateSourceStatus[] = [
  "requires_navigation",
  "requires_form_submission",
  "requires_detail_page_followup",
];

export function statusNeedsTinyfishAgent(status: PopulateSourceStatus): boolean {
  return AGENT_TRIAGE_STATUSES.includes(status);
}

export function parsePopulateSourceStatus(
  value: string
): PopulateSourceStatus {
  return populateSourceStatusSchema.parse(value);
}
