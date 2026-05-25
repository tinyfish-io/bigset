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
  const formattedRowCount = params.rowCount.toLocaleString();
  const rowLabel = params.rowCount === 1 ? "row" : "rows";

  const subject = `BigSet: "${sanitizeSubjectText(params.datasetName)}" is ready`;

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1d1b16;-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${safeName} has ${formattedRowCount} ${rowLabel} ready to inspect and export.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f3ee;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #dedbd2;border-radius:8px;border-top:4px solid #1d1b16;">
            <tr>
              <td style="padding:26px 30px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="left" style="font-size:19px;font-weight:800;color:#1d1b16;">BigSet}</td>
                    <td align="right">
                      <span style="display:inline-block;border:1px solid #a9ddc4;background:#eefaf4;color:#04724d;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Dataset ready</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 30px 8px;">
                <h1 style="margin:0;font-size:26px;line-height:1.22;font-weight:800;color:#1d1b16;">
                  Fresh rows are ready
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 18px;">
                <p style="margin:0;color:#6f7169;font-size:15px;line-height:1.55;">
                  BigSet finished populating your dataset. Open it to review the table, spot-check sources, or export the rows.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#faf9f5;border:1px solid #e5e2d8;border-radius:8px;">
                  <tr>
                    <td style="padding:18px 20px;border-bottom:1px solid #e5e2d8;">
                      <p style="margin:0;color:#8a877d;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;line-height:1.3;">Dataset</p>
                      <p style="margin:6px 0 0;color:#1d1b16;font-size:16px;font-weight:700;line-height:1.35;">${safeName}</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:18px 20px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td align="left" style="color:#8a877d;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">Rows generated</td>
                          <td align="right" style="color:#1d1b16;font-size:22px;font-weight:800;line-height:1;">${formattedRowCount}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 30px 34px;">
                <a href="${safeUrl}" style="display:inline-block;padding:13px 22px;background:#1d1b16;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;border-radius:6px;">
                  Open dataset
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px;border-top:1px solid #ece9df;color:#7c7f74;font-size:12px;line-height:1.5;">
                BigSet by TinyFish - live, queryable datasets from the web.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "BigSet dataset ready",
    "",
    `${params.datasetName}`,
    `${formattedRowCount} ${rowLabel} generated`,
    "",
    "Open it to review the table, spot-check sources, or export the rows.",
    "",
    `Open dataset: ${params.datasetUrl}`,
    "",
    "BigSet by TinyFish",
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

function sanitizeSubjectText(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}
