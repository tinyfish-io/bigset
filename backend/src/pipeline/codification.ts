import type {
  CodificationProfile,
  PopulateColumn,
} from "./populate.js";
import type {
  CodificationProfile as SchemaCodificationProfile,
} from "./types.js";

interface CodificationClassificationInput {
  datasetName?: string;
  description?: string;
  columns: PopulateColumn[];
  primaryKeys?: Record<string, string>;
  urls?: string[];
  context?: string;
  retrievalStrategy?: "search_fetch" | "browser" | "hybrid";
  sourceHint?: string;
}

const PROFILE_VERSION = 1;
const BROAD_RESEARCH_TEXT_PATTERN =
  /\b(across|around|from)\s+the\s+web\b|\bsearch\s+the\s+web\b|\bany\s+source\b/;

export function schemaCodificationProfileToRuntime(
  profile: SchemaCodificationProfile,
): CodificationProfile {
  return {
    version: PROFILE_VERSION,
    mode: profile.mode,
    reason: profile.reason,
    primaryKeyShape: profile.primary_key_shape,
    families: profile.families.map((family) => ({
      label: family.label,
      sourceHost: family.source_host,
      sourcePathPrefix: family.source_path_prefix,
      urlTemplate: family.url_template,
      primaryKeyRegex: family.primary_key_regex,
    })),
  };
}

export function normalizeCodificationProfile(
  profile: CodificationProfile | undefined,
  input: CodificationClassificationInput,
): CodificationProfile {
  return profile ?? classifyCodificationProfile(input);
}

export function shouldAttemptCodification(
  profile: CodificationProfile,
  input?: CodificationClassificationInput,
): boolean {
  if (profile.mode === "candidate" || profile.mode === "required") return true;
  if (!input || (profile.mode !== "disabled" && profile.mode !== "unknown")) return false;
  return hasConcreteCodificationRoute(profile, input);
}

export function classifyCodificationProfile(
  input: CodificationClassificationInput,
): CodificationProfile {
  const primaryKeyShape = inferPrimaryKeyShape(input.columns);
  const sourceUrl = firstHttpUrl(input.sourceHint);
  const sourceFamily = sourceUrl ? familyFromUrl(sourceUrl) : undefined;
  const retrievalStrategy = input.retrievalStrategy ?? "search_fetch";
  const broadResearch = isBroadResearchInput(input);

  if (!sourceUrl && broadResearch) {
    return disabledProfile(
      primaryKeyShape,
      "Prompt describes broad web research rather than one stable page family.",
    );
  }

  if (!sourceUrl && primaryKeyShape !== "url") {
    return disabledProfile(
      primaryKeyShape,
      "No source URL or URL-shaped primary key; legacy metadata only supports broad investigation.",
    );
  }

  if (primaryKeyShape === "url") {
    return {
      version: PROFILE_VERSION,
      mode: "candidate",
      reason: "Primary key is URL-shaped, so rows can be routed by page family.",
      primaryKeyShape,
      families: sourceFamily ? [sourceFamily] : [],
    };
  }

  if (sourceFamily && (primaryKeyShape === "slug" || primaryKeyShape === "id")) {
    return {
      version: PROFILE_VERSION,
      mode: retrievalStrategy === "browser" ? "required" : "candidate",
      reason: "Dataset has a source URL and structured primary keys that may map to one page family.",
      primaryKeyShape,
      families: [sourceFamily],
    };
  }

  if (sourceFamily && retrievalStrategy === "browser") {
    return {
      version: PROFILE_VERSION,
      mode: "candidate",
      reason: "Browser retrieval with an explicit source URL may support a reusable extractor.",
      primaryKeyShape,
      families: [sourceFamily],
    };
  }

  return disabledProfile(
    primaryKeyShape,
    "Legacy metadata does not expose a stable URL, slug, ID, or browser source family.",
  );
}

function disabledProfile(
  primaryKeyShape: CodificationProfile["primaryKeyShape"],
  reason: string,
): CodificationProfile {
  return {
    version: PROFILE_VERSION,
    mode: "disabled",
    reason,
    primaryKeyShape,
    families: [],
  };
}

function inferPrimaryKeyShape(
  columns: PopulateColumn[],
): CodificationProfile["primaryKeyShape"] {
  const pkColumns = columns.filter((column) => column.isPrimaryKey);
  if (pkColumns.length === 0) return "unknown";
  const shapes = new Set(pkColumns.map(inferColumnShape));
  if (shapes.size === 1) return [...shapes][0] ?? "unknown";
  return "mixed";
}

function inferColumnShape(column: PopulateColumn): CodificationProfile["primaryKeyShape"] {
  const name = column.name.toLowerCase();
  const description = (column.description ?? "").toLowerCase();
  const regex = (column.validationRegex ?? "").toLowerCase();
  const text = `${name} ${description} ${regex}`;

  if (column.type === "url" || /\burl\b|https\?:|https?:/.test(text)) return "url";
  if (/\bslug\b|\bhandle\b|\bpath\b|\brepo\b|\bpackage\b|\busername\b/.test(text)) {
    return "slug";
  }
  if (/\bid\b|_id\b|\bidentifier\b|\buuid\b|\bisbn\b|\bsku\b/.test(text)) {
    return "id";
  }
  if (/\bname\b|\btitle\b/.test(text)) return "name";
  return "unknown";
}

function hasConcreteCodificationRoute(
  profile: CodificationProfile,
  input: CodificationClassificationInput,
): boolean {
  const hasUsableTemplate = profile.families.some(
    (family) => family.urlTemplate && hasTemplateValues(family.urlTemplate, input),
  );
  if (hasUsableTemplate) return true;

  const broadResearch =
    isBroadResearchDisableReason(profile.reason) || isBroadResearchInput(input);
  if (broadResearch) return false;

  const rowUrl = firstHttpUrl(
    [
      ...Object.values(input.primaryKeys ?? {}),
      ...(input.urls ?? []),
      input.context,
    ].join(" "),
  );
  if (rowUrl) return true;

  const sourceUrl = firstHttpUrl(input.sourceHint);
  const primaryKeyShape =
    profile.primaryKeyShape === "unknown"
      ? inferPrimaryKeyShape(input.columns)
      : profile.primaryKeyShape;
  const structuredPrimaryKey =
    primaryKeyShape === "id" ||
    primaryKeyShape === "slug" ||
    primaryKeyShape === "url";
  if (sourceUrl && structuredPrimaryKey) return true;

  const accessRiskOnly = /\b(block|blocked|captcha|bot|automation|browser|fetch|access|degrad)/i.test(
    profile.reason,
  );
  return accessRiskOnly && (structuredPrimaryKey || hasIdentifierLikePrimaryKey(input.primaryKeys));
}

function isBroadResearchDisableReason(reason: string): boolean {
  return /\b(broad web|broad investigation|arbitrary unrelated|unrelated domains|snippet-only|search snippets)\b/i.test(reason);
}

function isBroadResearchInput(input: CodificationClassificationInput): boolean {
  return BROAD_RESEARCH_TEXT_PATTERN.test(codificationSearchableText(input));
}

function codificationSearchableText(input: CodificationClassificationInput): string {
  return [
    input.datasetName,
    input.description,
    input.sourceHint,
    ...input.columns.map((column) => `${column.name} ${column.description ?? ""}`),
  ]
    .join(" ")
    .toLowerCase();
}

function hasTemplateValues(
  template: string,
  input: CodificationClassificationInput,
): boolean {
  const placeholders = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(
    (match) => match[1],
  );
  if (placeholders.length === 0) return false;
  return placeholders.every((placeholder) =>
    Boolean(findPrimaryKeyValue(placeholder, input.primaryKeys ?? {})),
  );
}

function hasIdentifierLikePrimaryKey(
  primaryKeys: Record<string, string> | undefined,
): boolean {
  const values = Object.values(primaryKeys ?? {})
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return false;

  return values.every((value) => {
    if (/\s/.test(value)) return false;
    if (/^https?:\/\//i.test(value)) return true;
    if (!/^[a-z0-9._~:/?#\[\]@!$&'()*+,;=%-]{6,}$/i.test(value)) return false;
    return /[0-9._~:/?#\[\]@!$&'()*+,;=%-]/.test(value);
  });
}

function firstHttpUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const match = value.match(/https?:\/\/[^\s)>"']+/i);
  if (!match) return undefined;
  try {
    return new URL(match[0].replace(/[.,;:]+$/, ""));
  } catch {
    return undefined;
  }
}

function familyFromUrl(url: URL): CodificationProfile["families"][number] {
  const pathPrefix = url.pathname.split("/").filter(Boolean)[0];
  return {
    label: sanitizeFamilyLabel([url.hostname, pathPrefix].filter(Boolean).join("_")),
    sourceHost: url.hostname.toLowerCase(),
    sourcePathPrefix: pathPrefix ? `/${pathPrefix}` : undefined,
  };
}

function sanitizeFamilyLabel(value: string): string {
  const label = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(label) ? label : `site_${label || "unknown"}`;
}

function findPrimaryKeyValue(
  columnName: string | undefined,
  primaryKeys: Record<string, string>,
): string | undefined {
  if (!columnName) return undefined;
  if (primaryKeys[columnName]) return primaryKeys[columnName];
  const normalizedColumn = normalizeFieldName(columnName);
  const entry = Object.entries(primaryKeys).find(
    ([key]) => normalizeFieldName(key) === normalizedColumn,
  );
  return entry?.[1];
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
