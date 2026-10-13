const CRC_TABLE = makeCrcTable();

export function downloadCreditFolder(folder: string, json: string, pdfLines: string[]) {
  const name = safeName(folder);
  const zip = buildZip(name, [
    { name: "credit-file.json", data: encode(json) },
    { name: "credit-file.pdf", data: buildPdf(pdfLines) },
  ]);
  const blob = new Blob([zip], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function safeName(value: string) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "credit-file";
}

export function buildPdf(lines: string[]) {
  const pages = paginate(lines.map(ascii));
  const objects: string[] = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
  const fontId = 3;
  objects.push(`${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`);
  const pageIds: number[] = [];
  let next = 4;
  const pageObjects: string[] = [];
  pages.forEach((page) => {
    const contentId = next++;
    const pageId = next++;
    pageIds.push(pageId);
    const stream = pageStream(page);
    pageObjects.push(`${contentId} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
    pageObjects.push(
      `${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >> endobj\n`,
    );
  });
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  objects.splice(1, 0, `2 0 obj << /Type /Pages /Count ${pages.length} /Kids [${kids}] >> endobj\n`);
  objects.push(...pageObjects);
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object) => {
    offsets.push(body.length);
    body += object;
  });
  const xrefAt = body.length;
  let xref = `xref\n0 ${offsets.length}\n`;
  xref += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += xref;
  body += `trailer << /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return encode(body);
}

function paginate(lines: string[]) {
  const pages: string[][] = [];
  let page: string[] = [];
  lines.forEach((line) => {
    wrap(line, 88).forEach((part) => {
      if (page.length >= 42) {
        pages.push(page);
        page = [];
      }
      page.push(part);
    });
  });
  if (page.length) pages.push(page);
  if (!pages.length) pages.push(["Traceline credit file"]);
  return pages;
}

function wrap(line: string, width: number) {
  if (line.length <= width) return [line];
  const parts: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut < 24) cut = width;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function pageStream(lines: string[]) {
  const commands = ["BT", "/F1 11 Tf", "54 750 Td"];
  lines.forEach((line, index) => {
    if (index === 0) commands.push("/F1 16 Tf");
    if (index === 1) commands.push("/F1 11 Tf");
    if (index > 0) commands.push("0 -16 Td");
    commands.push(`(${pdfEscape(line)}) Tj`);
  });
  commands.push("ET");
  return commands.join("\n");
}

function pdfEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function ascii(value: string) {
  return value.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
}

export function buildZip(folder: string, files: { name: string; data: Uint8Array }[]) {
  const entries = [{ name: `${folder}/`, data: new Uint8Array(0) }, ...files.map((file) => ({ name: `${folder}/${file.name}`, data: file.data }))];
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  entries.forEach((entry) => {
    const name = encode(entry.name);
    const crc = crc32(entry.data);
    locals.push(localHeader(name.length, crc, entry.data.length), name, entry.data);
    centrals.push(centralHeader(name.length, crc, entry.data.length, offset, entry.name.endsWith("/")), name);
    offset += 30 + name.length + entry.data.length;
  });
  const centralBytes = concat(centrals);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralBytes.length, true);
  view.setUint32(16, offset, true);
  return concat([...locals, centralBytes, end]);
}

function localHeader(nameLength: number, crc: number, length: number) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, length, true);
  view.setUint32(22, length, true);
  view.setUint16(26, nameLength, true);
  return bytes;
}

function centralHeader(nameLength: number, crc: number, length: number, offset: number, directory: boolean) {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, length, true);
  view.setUint32(24, length, true);
  view.setUint16(28, nameLength, true);
  view.setUint32(38, directory ? 0x10 : 0, true);
  view.setUint32(42, offset, true);
  return bytes;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function encode(value: string) {
  return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}
