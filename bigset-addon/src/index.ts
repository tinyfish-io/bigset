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