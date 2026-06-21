//https://www.youtube.com/watch?v=pmQdrAIdfGM
/***
 *returns [string]
 */
function getHeaderRow() {
  //Get the first row of the sheet. Show this to the dropdown of the app
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  let lastColumn = ss.getLastColumn();
  //Return only if there is sheet cols available or sent empty array
  return lastColumn == 0 ? [] : sheet.getRange(1, 1, 1, lastColumn).getValues();
}

