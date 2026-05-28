/**
 * Shared types for the email module.
 *
 * A template is a pure function from typed params → { subject, html, text }.
 * Subject lines and bodies live next to each other so the contract is one
 * file per email. Adding a new template = drop a new file in
 * `templates/`; nothing else needs to change.
 */
export interface EmailTemplate {
  subject: string;
  /** Fully-rendered HTML body. Inline styles only; no external assets. */
  html: string;
  /** Plain-text fallback for clients that don't render HTML. */
  text: string;
}
