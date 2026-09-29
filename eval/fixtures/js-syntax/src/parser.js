/**
 * Parses one CSV line. Supports double-quoted fields containing commas and
 * escaped quotes ("").
 */
export function parseLine(line) {
  const fields = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  fields.push(cur);
  return fields;
}

export function parse(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map(parseLine);
}
