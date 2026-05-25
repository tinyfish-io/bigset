/**
 * Backend-side event names. Past-tense snake_case, matching the
 * frontend's `EVENTS` constant in `frontend/lib/analytics.ts`.
 *
 * These events fire from server-side code paths the frontend can't
 * observe (e.g. the email actually leaving the building, not just the
 * /populate response returning success).
 */
export const EVENTS = {
  /** Resend accepted the email for delivery. */
  DATASET_READY_EMAIL_SENT: "dataset_ready_email_sent",
  /** Notify attempted but couldn't deliver — see `error_kind` property. */
  DATASET_READY_EMAIL_FAILED: "dataset_ready_email_failed",
  /**
   * A populate-agent tool call was refused because the LLM tried to
   * touch a row outside its authorized dataset (or fabricated an id).
   *
   * Fires per refused operation, never per success. Payload is
   * deliberately small — see backend/src/mastra/tools/dataset-tools.ts.
   * Useful as a leading indicator for prompt-injection attempts and as
   * a regression signal if the closure-scoping discipline ever breaks.
   */
  CAPABILITY_VIOLATION: "capability_violation",
} as const;

export type BackendEventName = (typeof EVENTS)[keyof typeof EVENTS];
