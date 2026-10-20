const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encode(text) {
  return new TextEncoder().encode(text);
}

function storeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    locals.push(local);
    centrals.push(concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]));
    offset += local.length;
  }
  const central = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, end]);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The CV is written as markdown and rendered here. The shape is fixed so the
 * document reads the same every time:
 *
 *   # Full Name
 *   Lagos · ada@example.com · +234 … · linkedin.com/in/ada
 *   ## Experience
 *   ### Senior Backend Engineer — Acme | 2022–Present
 *   - what you did
 *   ## Skills
 *   TypeScript · Node · Postgres
 */
export function markdownToParagraphs(markdown) {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const out = [];
  let seenName = false;
  let afterName = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      afterName = false;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push({ kind: "name", text: line.slice(2).trim() });
      seenName = true;
      afterName = true;
      continue;
    }
    if (line.startsWith("### ")) {
      const body = line.slice(4).trim();
      const split = body.lastIndexOf("|");
      out.push(split > 0
        ? { kind: "role", text: body.slice(0, split).trim(), dates: body.slice(split + 1).trim() }
        : { kind: "role", text: body });
      afterName = false;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push({ kind: "section", text: line.slice(3).trim().toUpperCase() });
      afterName = false;
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      out.push({ kind: "bullet", text: line.replace(/^[-*•]\s+/, "") });
      afterName = false;
      continue;
    }
    if (seenName && afterName) {
      out.push({ kind: "contact", text: line.replace(/\s*[|·]\s*/g, "  ·  ") });
      afterName = false;
      continue;
    }
    out.push({ kind: "body", text: line });
  }
  return out;
}

/** Splits **bold** out of a line so a run can carry it. */
function runs(text, baseBold = false) {
  const parts = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), bold: baseBold });
    parts.push({ text: match[1] || match[2], bold: true });
    last = pattern.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: baseBold });
  return parts.length ? parts : [{ text, bold: baseBold }];
}

function runXml({ text, bold, size, color, caps, spacing }) {
  const props = [
    // Named on every run: some readers ignore the document defaults.
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>',
    bold ? "<w:b/>" : "",
    caps ? "<w:caps/>" : "",
    color ? `<w:color w:val="${color}"/>` : "",
    spacing ? `<w:spacing w:val="${spacing}"/>` : "",
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
  ].join("");
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

// Half-points: Word sizes are doubled, so 21 is 10.5pt.
const SIZE = { name: 40, contact: 18, section: 20, role: 21, body: 21 };

function paragraphXml(paragraph, { rightEdge }) {
  const common = (props, children) => `<w:p><w:pPr>${props}</w:pPr>${children}</w:p>`;

  if (paragraph.kind === "name") {
    return common(
      '<w:spacing w:before="0" w:after="40" w:line="240" w:lineRule="auto"/>',
      runXml({ text: paragraph.text, bold: true, size: SIZE.name, spacing: 10 }),
    );
  }
  if (paragraph.kind === "contact") {
    return common(
      '<w:spacing w:before="0" w:after="180"/>',
      runXml({ text: paragraph.text, size: SIZE.contact, color: "4A4A4A" }),
    );
  }
  if (paragraph.kind === "section") {
    return common(
      '<w:spacing w:before="260" w:after="90"/>'
      + '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="BFBFBF"/></w:pBdr>',
      runXml({ text: paragraph.text, bold: true, size: SIZE.section, spacing: 20, color: "222222" }),
    );
  }
  if (paragraph.kind === "role") {
    // One tab stop at the right margin keeps every date column flush.
    const props = `<w:spacing w:before="140" w:after="40"/><w:tabs><w:tab w:val="right" w:pos="${rightEdge}"/></w:tabs>`;
    const left = runs(paragraph.text, true).map((part) => runXml({ ...part, size: SIZE.role })).join("");
    if (!paragraph.dates) return common(props, left);
    const tab = '<w:r><w:tab/></w:r>';
    return common(props, left + tab + runXml({ text: paragraph.dates, size: SIZE.contact, color: "4A4A4A" }));
  }
  if (paragraph.kind === "bullet") {
    const props = '<w:spacing w:before="0" w:after="60" w:line="264" w:lineRule="auto"/>'
      + '<w:ind w:left="284" w:hanging="284"/>';
    const marker = runXml({ text: "•\t", size: SIZE.body });
    const body = runs(paragraph.text).map((part) => runXml({ ...part, size: SIZE.body })).join("");
    return common(props, marker + body);
  }
  const props = '<w:spacing w:before="0" w:after="80" w:line="264" w:lineRule="auto"/>';
  return common(props, runs(paragraph.text).map((part) => runXml({ ...part, size: SIZE.body })).join(""));
}

const PAGE = {
  a4: { w: 11906, h: 16838 },
  letter: { w: 12240, h: 15840 },
};

const MARGIN = 1021; // 1.8cm, the usual CV margin and still generous for a printer.

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/>
      <w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="1A1A1A"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>
      <w:spacing w:after="80" w:line="264" w:lineRule="auto"/>
    </w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
  </w:style>
</w:styles>`;

export function buildDocx(markdown, pageSize = "a4") {
  const page = PAGE[pageSize] || PAGE.a4;
  const rightEdge = page.w - MARGIN * 2;
  const body = markdownToParagraphs(markdown)
    .map((paragraph) => paragraphXml(paragraph, { rightEdge }))
    .join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  return storeZip([
    { name: "[Content_Types].xml", data: encode(contentTypes) },
    { name: "_rels/.rels", data: encode(rels) },
    { name: "word/document.xml", data: encode(documentXml) },
    { name: "word/_rels/document.xml.rels", data: encode(docRels) },
    { name: "word/styles.xml", data: encode(STYLES) },
  ]);
}

export function docxFilename(profile, job) {
  const who = String(profile?.fullName || "Candidate").trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
  const role = String(job?.title || "Role").trim().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  return `${who || "Candidate"}-${role || "Role"}-CV.docx`;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
