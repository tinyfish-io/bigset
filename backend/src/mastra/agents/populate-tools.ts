import { normalizeSearchResultUrl } from "../../pipeline/populate-search-prioritization.js";
import {
  getRowTool,
  insertRowTool,
  listRowsTool,
  updateRowTool,
  deleteRowTool,
} from "../tools/dataset-tools.js";
import { createFetchPageTool } from "../tools/web-tools.js";

export function createPopulateAgentTools(input: {
  allowedFetchUrls: Set<string>;
}) {
  return {
    insert_row: insertRowTool,
    list_rows: listRowsTool,
    get_row: getRowTool,
    update_row: updateRowTool,
    delete_row: deleteRowTool,
    fetch_page: createFetchPageTool({
      allowedUrls: input.allowedFetchUrls,
      normalizeUrl: normalizeSearchResultUrl,
    }),
  };
}
