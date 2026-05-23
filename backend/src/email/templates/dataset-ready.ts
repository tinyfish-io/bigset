import type { EmailTemplate } from "../types.js";

interface DatasetReadyParams {
  datasetName: string;
  rowCount: number;
  datasetUrl: string;
}

/**
 * "Your dataset is ready" — fired when populateWorkflow completes
 * successfully AND the dataset has at least one row.
 *
 * Plain inline-styled HTML (table-based layout) so Gmail, Outlook,
 * Apple Mail, and webmail all render it consistently. No external CSS,
 * no web fonts, no remote images.
 */
export function datasetReadyTemplate(params: DatasetReadyParams): EmailTemplate {
  const safeName = escapeHtml(params.datasetName);
  const safeUrl = escapeAttr(params.datasetUrl);
  const rowLabel = params.rowCount === 1 ? "row" : "rows";

  const subject = `Your "${params.datasetName}" dataset is ready`;

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1b16;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f0;">
      <tr>
        <td align="center" style="padding:48px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #d5d6cf;border-radius:8px;">
            <tr>
              <td style="padding:24px 28px 0;">
                <span style="font-size:16px;font-weight:700;letter-spacing:-0.02em;color:#1d1b16;">BigSet</span>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 4px;">
                <h1 style="margin:0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.02em;color:#1d1b16;">
                  Your dataset is ready
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f8f4;border:1px solid #e1e2db;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0;color:#1d1b16;font-size:14px;font-weight:600;line-height:1.3;">${safeName}</p>
                      <p style="margin:6px 0 0;color:#7c7f74;font-size:12px;line-height:1.3;">${params.rowCount.toLocaleString()} ${rowLabel} generated</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 28px 24px;">
                <p style="margin:0;color:#7c7f74;font-size:14px;line-height:1.55;">
                  Your dataset has been populated. Open it to view, query, or export the rows.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 32px;">
                <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;background:#1d1b16;color:#f4f4f0;text-decoration:none;font-size:14px;font-weight:600;border-radius:6px;letter-spacing:-0.01em;">
                  Open Dataset
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;border-top:1px solid #e8e9e3;color:#7c7f74;font-size:11px;line-height:1.5;">
                BigSet · Live, queryable datasets by TinyFish
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "Your dataset is ready",
    "",
    `${params.datasetName}`,
    `${params.rowCount.toLocaleString()} ${rowLabel} generated`,
    "",
    `Open dataset: ${params.datasetUrl}`,
    "",
    "—",
    "BigSet · Live, queryable datasets by TinyFish",
  ].join("\n");

  return { subject, html, text };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function escapeAttr(s: string): string {
  // Same set for href attributes — Resend won't accept javascript:
  // URIs and we control the URL anyway, but be defensive.
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
