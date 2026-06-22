const ADDON_NAME = "BigSet";
const SCRIPT_PROPERTY_KEY = "BIGSET_API_KEY";
const SCRIPT_PROPERTY_URL = "BIGSET_BACKEND_URL";
const DEFAULT_BACKEND_URL = "https://eab6-2a09-bac1-36e0-5d68-00-2a8-5d.ngrok-free.app";

/**
 * @OnlyCurrentDoc
 */

function onOpen(e) {
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem("Open", "showSidebar")
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  const ui = HtmlService.createTemplateFromFile("sidebar")
    .evaluate()
    .setTitle(ADDON_NAME);
  SpreadsheetApp.getUi().showSidebar(ui);
}

// ─────────────────────────────────────────────────────────────────────
//  Backend HTTP proxy — called by google.script.run from the sidebar
// ─────────────────────────────────────────────────────────────────────

function callBackend(path, method, body) {
  const baseUrl = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_URL) || DEFAULT_BACKEND_URL;
  const apiKey = PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEY) || "";
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;

  const options = {
    method: method || "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    muteHttpExceptions: true,
    followRedirects: true,
    timeout: 30000,
  };

  if (apiKey) {
    options.headers["X-API-Key"] = apiKey;
    options.headers.Authorization = `Bearer ${apiKey}`;
  }

  if (body !== null && body !== undefined) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(body);
  }

  const response = UrlFetchApp.fetch(url, options);
  const status = response.getResponseCode();
  const text = response.getContentText();

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_e) {
    // not JSON
  }

  if (status >= 200 && status < 300) {
    return parsed;
  }

  const errorMsg =
    parsed && typeof parsed === "object" && parsed.error
      ? String(parsed.error)
      : `Backend responded with ${status}`;

  throw new Error(errorMsg);
}

function getApiKey() {
  return PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_KEY) || "";
}

function setApiKey(key) {
  PropertiesService.getScriptProperties().setProperty(SCRIPT_PROPERTY_KEY, key);
}

function getBackendUrl() {
  return PropertiesService.getScriptProperties().getProperty(SCRIPT_PROPERTY_URL) || DEFAULT_BACKEND_URL;
}

function setBackendUrl(url) {
  PropertiesService.getScriptProperties().setProperty(SCRIPT_PROPERTY_URL, url);
}

function insertRowsIntoActiveSheet(headers, rows, clearFirst) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (clearFirst) {
    sheet.clearContents();
    sheet.clearFormats();
  }

  if (!rows || rows.length === 0) {
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return { rowsInserted: 0, startCell: "A1", endCell: "A1" };
  }

  const data = [headers];
  for (const row of rows) {
    const values = headers.map((h) => {
      const val = row[h];
      return val !== null && val !== undefined ? val : "";
    });
    data.push(values);
  }

  const numRows = data.length;
  const numCols = headers.length;
  const range = sheet.getRange(1, 1, numRows, numCols);
  range.setValues(data);

  const startCell = "A1";
  const endCell = `${String.fromCharCode(64 + numCols)}${numRows}`;

  return { rowsInserted: rows.length, startCell, endCell };
}

function showErrorToast(message) {
  SpreadsheetApp.getActiveSpreadsheet().toast(message, "BigSet", 5);
}

// ─────────────────────────────────────────────────────────────────────
//  Sheet Enrichment — read selection, enrich, write back
// ─────────────────────────────────────────────────────────────────────

/**
 * Read the user's selected range from the active sheet.
 * Expects the first row of the selection to contain column headers.
 *
 * Returns:
 *   { headers: string[], rows: Array<{ rowIndex: number, data: {} }>, range: string }
 *
 * Only includes rows where at least one cell is non-empty.
 */
function getSelectedRange() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const activeRange = sheet.getActiveRange();

  if (!activeRange) {
    return { headers: [], rows: [], range: "" };
  }

  const rowStart = activeRange.getRow();
  const colStart = activeRange.getColumn();
  const numRows = activeRange.getNumRows();
  const numCols = activeRange.getNumColumns();

  const rawRangeStr = `${columnLetter(colStart)}${rowStart}:${columnLetter(colStart + numCols - 1)}${rowStart + numRows - 1}`;

  if (numRows < 2) {
    return { headers: [], rows: [], range: rawRangeStr };
  }

  const values = activeRange.getValues();

  // Find the last column with a non-empty header
  let lastCol = 0;
  for (let j = values[0].length - 1; j >= 0; j--) {
    const header = values[0][j];
    if (header !== "" && header !== null && header !== undefined) {
      lastCol = j + 1;
      break;
    }
  }

  if (lastCol === 0) {
    return { headers: [], rows: [], range: rawRangeStr };
  }

  // Find the last row with at least one non-empty value
  let lastRow = 0;
  for (let i = values.length - 1; i >= 1; i--) {
    for (let j = 0; j < lastCol; j++) {
      const val = values[i][j];
      if (val !== "" && val !== null && val !== undefined) {
        lastRow = i;
        break;
      }
    }
    if (lastRow > 0) break;
  }

  if (lastRow === 0) {
    return { headers: [], rows: [], range: rawRangeStr };
  }

  // Build headers from trimmed columns
  var headers = [];
  for (let j = 0; j < lastCol; j++) {
    headers.push(String(values[0][j]));
  }

  // Build rows from trimmed data
  const rowsData = [];
  for (let i = 1; i <= lastRow; i++) {
    const rowData = {};
    let hasValue = false;
    for (let j = 0; j < lastCol; j++) {
      const val = values[i][j];
      if (val !== "" && val !== null && val !== undefined) {
        rowData[headers[j]] = val;
        hasValue = true;
      } else {
        rowData[headers[j]] = null;
      }
    }
    if (hasValue) {
      rowsData.push({
        rowIndex: rowStart + i,
        data: rowData,
      });
    }
  }

  const trimmedRange = `${columnLetter(colStart)}${rowStart}:${columnLetter(colStart + lastCol - 1)}${rowStart + lastRow}`;

  return { headers, rows: rowsData, range: trimmedRange };
}

function columnLetter(col) {
  let letter = "";
  while (col > 0) {
    col--;
    letter = String.fromCharCode(65 + (col % 26)) + letter;
    col = Math.floor(col / 26);
  }
  return letter;
}

/**
 * Write enrichment results back to the sheet.
 * Only writes to cells that are currently empty — never overwrites data.
 *
 * @param {Array<{rowIndex: number, columnName: string, value: any}>} updates
 */
function updateSheetCells(updates) {
  if (!updates || updates.length === 0) {
    return { updated: 0 };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const activeRange = sheet.getActiveRange();

  if (!activeRange) return { updated: 0 };

  const colStart = activeRange.getColumn();
  const numCols = activeRange.getNumColumns();
  const headersRange = sheet.getRange(activeRange.getRow(), colStart, 1, numCols);
  const headers = headersRange.getValues()[0].map(String);

  let updated = 0;

  for (const update of updates) {
    const colIndex = headers.indexOf(update.columnName);
    if (colIndex === -1) continue;

    const rowIndex = parseInt(update.rowIndex, 10);
    if (isNaN(rowIndex) || rowIndex < 2) continue;

    const cell = sheet.getRange(rowIndex, colStart + colIndex);
    const currentValue = cell.getValue();

    // NEVER overwrite existing data
    if (currentValue !== "" && currentValue !== null && currentValue !== undefined) {
      continue;
    }

    cell.setValue(update.value);
    updated++;
  }

  return { updated };
}