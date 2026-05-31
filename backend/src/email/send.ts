import { env } from "../env.js";
import { getResendClient, isEmailEnabled } from "./client.js";
import type { EmailTemplate } from "./types.js";

/**
 * Send a transactional email via Resend.
 *
 * Behavior:
 *   - No-ops with a log line when `RESEND_API_KEY` is unset (local dev
 *     without a Resend account works normally).
 *   - Throws on actual delivery failure so callers can decide whether to
 *     surface the error. The /populate handler wraps this in a try/catch
 *     and only logs — a Resend outage must not fail dataset population.
 */
export async function sendTransactionalEmail(
  to: string,
  template: EmailTemplate,
): Promise<void> {
  if (!isEmailEnabled()) {
    console.warn(
      `[email] RESEND_API_KEY not set; would have sent "${template.subject}" to ${to}`,
    );
    return;
  }

  const client = getResendClient();
  if (!client) return; // belt-and-suspenders; isEmailEnabled covers this

  const { data, error } = await client.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  if (error) {
    // Resend errors come back structured; throw a normalized Error so the
    // caller's logger captures a useful stack + message.
    throw new Error(
      `Resend send failed: ${error.name ?? "error"} — ${error.message ?? "unknown"}`,
    );
  }

  console.log(
    `[email] sent "${template.subject}" to ${to} (id=${data?.id ?? "?"})`,
  );
}
