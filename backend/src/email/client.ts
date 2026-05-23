import { Resend } from "resend";
import { env } from "../env.js";

/**
 * Lazily-constructed Resend client.
 *
 * `null` when `RESEND_API_KEY` is unset (local dev without a Resend
 * account). Callers must check `isEmailEnabled()` first, or use
 * `sendTransactionalEmail` which already does.
 */
let _client: Resend | null = null;

function getClient(): Resend | null {
  if (_client) return _client;
  if (!env.RESEND_API_KEY) return null;
  _client = new Resend(env.RESEND_API_KEY);
  return _client;
}

export function isEmailEnabled(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

export function getResendClient(): Resend | null {
  return getClient();
}
