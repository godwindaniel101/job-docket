function latin1(bytes) {
  let text = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    text += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return text;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findSignature(data, from) {
  for (let index = from; index < data.length - 3; index += 1) {
    if (data[index] !== 0x50 || data[index + 1] !== 0x4b) continue;
    if (data[index + 2] === 0x03 || data[index + 2] === 0x01 || data[index + 2] === 0x05) return index;
  }
  return data.length;
}

export async function readZipEntry(bytes, wanted) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 30 < data.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    let size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(data.subarray(nameStart, nameStart + nameLength));
    const start = nameStart + nameLength + extraLength;
    if (flags & 0x8 && size === 0) size = findSignature(data, start) - start;
    const compressed = data.subarray(start, start + size);
    if (name === wanted) {
      if (method === 0) return compressed;
      if (method === 8) return inflateRaw(compressed);
      throw new Error("This Word file uses a compression method the docket cannot read.");
    }
    offset = start + size;
  }
  throw new Error("That Word file has no document text.");
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function textFromDocumentXml(xml) {
  return decodeXml(String(xml)
    .replace(/<w:p[^>]*\/>/g, "\n")
    .replace(/<w:p[\s>]/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function textFromDocx(bytes) {
  const xml = new TextDecoder().decode(await readZipEntry(bytes, "word/document.xml"));
  const text = textFromDocumentXml(xml);
  if (text.length < 40) throw new Error("That Word file had too little text to be a CV.");
  return text;
}

function readPdfLiteral(content, start) {
  let text = "";
  let index = start + 1;
  while (index < content.length) {
    const char = content[index];
    if (char === ")") return { text, next: index + 1 };
    if (char === "\\") {
      const next = content[index + 1];
      if (next === "n") text += "\n";
      else if (next === "r") text += "\r";
      else if (next === "t") text += "\t";
      else if (next >= "0" && next <= "7") {
        const octal = content.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] || next;
        text += String.fromCharCode(parseInt(octal, 8));
        index += octal.length + 1;
        continue;
      } else text += next || "";
      index += 2;
      continue;
    }
    text += char;
    index += 1;
  }
  return { text, next: index };
}

async function inflateFormat(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflatePdf(bytes) {
  try {
    return await inflateFormat(bytes, "deflate");
  } catch {
    return inflateFormat(bytes, "deflate-raw");
  }
}

function streamLength(dict, source) {
  const indirect = dict.match(/\/Length\s+(\d+)\s+\d+\s+R/);
  if (indirect) {
    const match = source.match(new RegExp(`(?:^|[\\r\\n])${indirect[1]} 0 obj\\s+(\\d+)`));
    if (match) return Number(match[1]);
  }
  const direct = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  return direct ? Number(direct[1]) : 0;
}

function utf16Hex(hex) {
  const clean = String(hex || "").replace(/\s+/g, "");
  let text = "";
  if (clean.length >= 4) {
    for (let index = 0; index + 4 <= clean.length; index += 4) {
      text += String.fromCharCode(parseInt(clean.slice(index, index + 4), 16));
    }
    return text;
  }
  if (clean.length === 2) return String.fromCharCode(parseInt(clean, 16));
  return "";
}

export function parseToUnicode(cmap) {
  const map = new Map();
  const space = String(cmap || "").match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  const width = space ? space[1].length : 2;
  const put = (code, hex) => {
    const value = utf16Hex(hex);
    if (value) map.set(code.toUpperCase(), value);
  };
  for (const block of String(cmap || "").matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) put(pair[1], pair[2]);
  }
  for (const block of String(cmap || "").matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const start = parseInt(range[1], 16);
      const dests = [...range[3].matchAll(/<([0-9A-Fa-f]+)>/g)];
      dests.forEach((dest, index) => {
        put((start + index).toString(16).padStart(range[1].length, "0"), dest[1]);
      });
    }
    for (const range of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const start = parseInt(range[1], 16);
      const end = parseInt(range[2], 16);
      let dest = parseInt(range[3], 16);
      for (let code = start; code <= end && code - start < 5000; code += 1) {
        put(code.toString(16).padStart(range[1].length, "0"), dest.toString(16).padStart(range[3].length, "0"));
        dest += 1;
      }
    }
  }
  return { width, map };
}

function decodeHex(hex, cmap) {
  if (!cmap?.map?.size) return "";
  const clean = String(hex || "").replace(/\s+/g, "").toUpperCase();
  let text = "";
  for (let index = 0; index + cmap.width <= clean.length; index += cmap.width) {
    text += cmap.map.get(clean.slice(index, index + cmap.width)) || "";
  }
  return text;
}

function decodePieces(body, cmap) {
  let text = "";
  const re = /<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)/g;
  let match;
  while ((match = re.exec(body))) {
    text += match[1] != null ? decodeHex(match[1], cmap) : readPdfLiteral(`(${match[2]})`, 0).text;
  }
  return text;
}

function textFromContent(content, cmaps) {
  const lines = [];
  const re = /\/([A-Za-z0-9]+)\s+[-\d.]+\s+Tf|\[([\s\S]*?)\]\s*TJ|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let font = "";
  let match;
  while ((match = re.exec(content))) {
    if (match[1]) {
      font = match[1];
      continue;
    }
    const cmap = cmaps.get(font);
    const line = match[2] != null
      ? decodePieces(match[2], cmap)
      : match[3] != null
        ? decodeHex(match[3], cmap)
        : readPdfLiteral(`(${match[4]})`, 0).text;
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join("\n");
}

function fontCmaps(source, streams) {
  const unicodeByFont = new Map();
  const fontRe = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>/g;
  let match;
  while ((match = fontRe.exec(source))) {
    if (!/\/Type\s*\/Font/.test(match[2])) continue;
    const unicode = match[2].match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (unicode) unicodeByFont.set(match[1], unicode[1]);
  }
  const names = new Set();
  for (const stream of streams.values()) {
    for (const found of stream.matchAll(/\/([A-Za-z0-9]+)\s+[-\d.]+\s+Tf/g)) names.add(found[1]);
  }
  const cmaps = new Map();
  for (const name of names) {
    const re = new RegExp(`\\/${name}\\s+(\\d+)\\s+\\d+\\s+R`, "g");
    let fontId = "";
    let found;
    while ((found = re.exec(source))) {
      if (unicodeByFont.has(found[1])) {
        fontId = found[1];
        break;
      }
    }
    const cmapText = streams.get(unicodeByFont.get(fontId) || "");
    if (cmapText) cmaps.set(name, parseToUnicode(cmapText));
  }
  return cmaps;
}

export function textFromPdfContent(content) {
  const pieces = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] !== "(") {
      index += 1;
      continue;
    }
    const literal = readPdfLiteral(content, index);
    const after = content.slice(literal.next, literal.next + 40);
    const before = content.slice(Math.max(0, index - 200), index);
    const shown = /^\s*(Tj|'|")/.test(after) || (/\[/.test(before) && /\]\s*TJ/.test(after));
    if (shown && /[A-Za-z]/.test(literal.text)) pieces.push(literal.text);
    index = literal.next;
  }
  return pieces.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function textFromPdf(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const source = latin1(data);
  const streams = new Map();
  const started = Date.now();
  const re = /(\d+)\s+0\s+obj\s*<<([^>]*?)>>\s*stream\r?\n/g;
  let match;
  while ((match = re.exec(source))) {
    if (Date.now() - started > 8000) break;
    const dict = match[2];
    if (/\/Length1\b|\/Predictor\b/.test(dict)) continue;
    const start = match.index + match[0].length;
    const length = streamLength(dict, source);
    const end = length ? start + length : source.indexOf("endstream", start);
    if (end <= start) continue;
    let slice = data.slice(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        slice = await inflatePdf(slice);
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) {
      continue;
    }
    streams.set(match[1], latin1(slice));
  }
  const cmaps = fontCmaps(source, streams);
  const chunks = [];
  for (const content of streams.values()) {
    if (!/Tj|TJ/.test(content)) continue;
    const decoded = textFromContent(content, cmaps);
    const literal = textFromPdfContent(content);
    chunks.push(decoded.replace(/[^A-Za-z]/g, "").length >= literal.replace(/[^A-Za-z]/g, "").length ? decoded : literal);
  }
  const text = chunks.filter(Boolean).join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.replace(/[^A-Za-z]/g, "").length < 40) {
    throw new Error("This PDF didn't yield readable text. Export a .docx or paste the CV.");
  }
  return text;
}

export async function textFromCvFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    const text = new TextDecoder().decode(bytes).trim();
    if (text.length < 40) throw new Error("That file had too little text to be a CV.");
    return text;
  }
  if (name.endsWith(".docx")) return textFromDocx(bytes);
  if (name.endsWith(".pdf")) return textFromPdf(bytes);
  throw new Error("Upload a PDF, a Word .docx, or a text file.");
}
