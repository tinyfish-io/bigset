/**
 * API helper constants for the BigSet backend.
 *
 * All server-callable functions live in index.ts to keep them globally
 * accessible to google.script.run.
 */

// Backend route prefixes
var BACKEND_PATHS = {
  health: "/health",
  inferSchema: "/infer-schema",
  populate: "/populate",
  stop: "/stop",
  createDataset: "/addon/datasets",
  listDatasets: "/addon/datasets",
  getDataset: "/addon/datasets/",
  listRows: "/addon/datasets/",
  apiKeys: "/api-keys",
};

// Expected column types
var COLUMN_TYPES = ["text", "number", "boolean", "url", "date"];