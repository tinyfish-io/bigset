import assert from "node:assert/strict";
import test from "node:test";

import { finalizePopulateLlmRecords } from "../src/pipeline/populate-extract-records.js";
import type { PopulateExtractionSpec } from "../src/pipeline/populate-extraction-spec.js";
import { coerceHttpUrl, uniqueHttpUrls } from "../src/pipeline/populate-url-utils.js";

const spec: PopulateExtractionSpec = {
  dataset_name: "yc",
  description: "YC companies",
  primary_key: "company_name",
  dedupe_keys: ["company_name"],
  columns: [
    {
      name: "company_name",
      display_name: "Company",
      type: "string",
      description: "Name",
      nullable: false,
    },
    {
      name: "source_url",
      display_name: "Source",
      type: "url",
      description: "Source page URL",
      nullable: true,
    },
  ],
};

test("coerceHttpUrl accepts strings and nested LLM shapes", () => {
  assert.equal(coerceHttpUrl(" https://example.com "), "https://example.com");
  assert.equal(coerceHttpUrl({ url: "https://nested.com" }), "https://nested.com");
  assert.equal(
    coerceHttpUrl(["https://first.com", "https://second.com"]),
    "https://first.com"
  );
  assert.equal(coerceHttpUrl(42), null);
});

test("uniqueHttpUrls ignores non-string url values", () => {
  assert.deepEqual(
    uniqueHttpUrls([
      "https://page.com",
      { href: "https://obj.com" },
      null,
      undefined,
      99,
    ]),
    ["https://page.com", "https://obj.com"]
  );
});

test("finalizePopulateLlmRecords tolerates non-string evidence urls", () => {
  const rows = finalizePopulateLlmRecords({
    pageUrl: "https://techcrunch.com/article",
    spec,
    records: [
      {
        row: {
          company_name: "Acme",
          source_url: "https://acme.com",
        },
        evidence: [
          {
            field: "company_name",
            quote: "Acme",
            url: { href: "https://acme.com/about" },
          },
        ],
        extraction_confidence: 0.9,
      },
    ],
  });

  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.sourceUrls.includes("https://techcrunch.com/article"));
  assert.ok(rows[0]?.sourceUrls.includes("https://acme.com"));
  assert.equal(rows[0]?.evidence[0]?.sourceUrl, "https://acme.com/about");
});
