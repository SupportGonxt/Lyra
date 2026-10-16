// A pasted employee list → rows for `POST /v1/axis/census/normalise`.
//
// The API takes `string[][]` because a census arrives as a spreadsheet, and the
// screen gets it as text somebody copied out of one. This is the only place that
// translation happens, so it is a pure function with its own tests rather than
// three lines inside a loader.
//
// Delimiter and quoting are both decided by **looking**, not by asking: an
// operator pasting from Excel has no idea whether they copied TSV or CSV, and a
// comma inside `Al Farsi, Ahmed` is a name rather than a column break.

/** One row of cells. Quoted cells keep their delimiters and lost quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted cell is one quote, not the end of it.
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      // CRLF and LF are one line break; a blank line is kept as an empty row so
      // the normaliser can skip it and keep its row numbers true to the sheet.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  // A file that does not end in a newline still has a last row; one that does
  // does not have an empty one.
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * The delimiter this text actually uses.
 *
 * Tabs win outright — a CSV export never contains a tab, so a tab means a paste
 * from a spreadsheet. Otherwise the comma and the semicolon are compared by how
 * many **header** fields they produce, because a file whose data rows are full of
 * commas in addresses is common and its header is not.
 */
export function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  if (firstLine.includes("\t")) return "\t";
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

/** Pasted text → the rows the normaliser takes, with trailing blank rows dropped. */
export function parseCensusText(text: string): string[][] {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return [];
  const rows = parseDelimited(trimmed, sniffDelimiter(trimmed));
  // The trailing blank line a copy always brings is not a row; a blank line in
  // the middle is kept, and the normaliser skips it.
  while (rows.length && rows[rows.length - 1]!.every((cell) => !cell.trim())) rows.pop();
  return rows;
}
