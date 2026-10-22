#!/usr/bin/env node
// Writes the made-up PDFs of documents.mjs next to this file, with no dependency: Helvetica from the PDF's standard
// fonts, a drawn pixel font for the scanned page, zlib for its picture. The bytes are the same on every run, so the
// test can rebuild them and compare. Run: node promo/fixtures/make.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { DOCUMENTS } from './documents.mjs';

const W = 595, H = 842, MARGIN = 72, BODY = 11, LEADING = 16;

// Helvetica's widths in thousandths of the size, characters 32 to 126 (Adobe's AFM).
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500,
  667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
  556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500,
  500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722,
  611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611,
  556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584];

function width(text, size, bold) {
  const table = bold ? BOLD : HELVETICA;
  return [...text].reduce((sum, ch) => {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`not printable ASCII: ${JSON.stringify(ch)} in ${text}`);
    return sum + table[code - 32];
  }, 0) * size / 1000;
}

const literal = (text) => `(${text.replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
const num = (n) => String(Math.round(n * 100) / 100);

// One page of text lines; returns its content stream.
function textPage(lines) {
  const ops = [];
  let y = H - MARGIN;
  for (const line of lines) {
    const opts = typeof line[0] === 'object' && !line[0].covered && !line[0].removed ? line[0] : {};
    const pieces = opts === line[0] ? line.slice(1) : line;
    const size = opts.size ?? BODY, bold = !!opts.bold;
    y -= (opts.gap ?? 0) + Math.max(LEADING, size * 1.4);
    let x = MARGIN;
    for (const piece of pieces) {
      const text = typeof piece === 'string' ? piece : piece.covered ?? piece.removed;
      const w = width(text, size, bold);
      if (typeof piece === 'string' || piece.covered) {
        ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(y)} Td ${literal(text)} Tj ET`);
      }
      if (typeof piece === 'object') {
        ops.push(`0 0 0 rg ${num(x - 2)} ${num(y - size * 0.3)} ${num(w + 4)} ${num(size * 1.25)} re f`);
      }
      x += w;
    }
  }
  return ops.join('\n') + '\n';
}

// A 5 by 7 pixel font, capitals only, for the scanned page.
const GLYPHS = {
  A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.', C: '.###.#...##....#....#....#...#.###.',
  D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
  G: '.###.#...##....#.####...##...#.####', H: '#...##...##...#######...##...##...#', I: '.###...#....#....#....#....#...###.',
  J: '..###...#....#....#....##..#..##...', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##.#.##...##...##...#', N: '#...##...###..##.#.##..###...##...#', O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####', 0: '.###.#...##..###.#.###..##...#.###.',
  1: '..#...##....#....#....#....#...###.', 2: '.###.#...#....#...#...#...#...#####', 3: '####.....#....#.###.....#....#####.',
  4: '...#...##..#.#.#..#.#####...#....#.', 5: '######....####.....#....##...#.###.', 6: '..##..#...#....####.#...##...#.###.',
  7: '#####....#...#...#...#....#....#...', 8: '.###.#...##...#.###.#...##...#.###.', 9: '.###.#...##...#.####....#...#..##..',
  ' ': '...................................', '.': '..........................##...##..', ',': '.....................##....#...#...',
  ':': '......##...##........##...##.......', '-': '...............#####...............',
};

// The scanned page: an off-white picture of capital lines and a printed bar, a little speckle, a shadow at the edge.
function scanImage(lines) {
  const dpi = 75, w = Math.round(W / 72 * dpi), h = Math.round(H / 72 * dpi), scale = 2;
  const px = Buffer.alloc(w * h, 238);
  const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = v; };
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < w * h; i++) if (rand() < 0.004) px[i] = 150 + Math.floor(rand() * 60);
  for (let y = 0; y < h; y++) for (let x = 0; x < 6; x++) set(x, y, 120 + x * 20);
  let top = Math.round(MARGIN / 72 * dpi);
  lines.forEach((line, i) => {
    const s = i === 0 ? scale + 1 : scale;
    let left = Math.round(MARGIN / 72 * dpi);
    for (const ch of line) {
      if (ch === '█') {
        for (let y = -s; y < 8 * s; y++) for (let x = 0; x < 18 * 6 * s; x++) set(left + x, top + y, 12);
        left += 18 * 6 * s;
        continue;
      }
      const glyph = GLYPHS[ch];
      if (!glyph) throw new Error(`no glyph for ${JSON.stringify(ch)} in the scan`);
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy * 5 + gx] !== '#') continue;
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) set(left + gx * s + dx, top + gy * s + dy, 30);
      }
      left += 6 * s;
    }
    top += 12 * s;
  });
  // Hex over Flate keeps the whole file ASCII, so a reader can scan it for strings without tripping on binary.
  const data = Buffer.from(deflateSync(px, { level: 9 }).toString('hex').toUpperCase() + '>');
  return { w, h, data };
}

function stream(dict, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
}

export function buildPdf({ info, outlines = [], pages }) {
  const bodies = [];
  const ref = () => bodies.push(null);
  const set = (n, body) => { bodies[n - 1] = body; };
  const catalog = ref(), pagesRef = ref(), f1 = ref(), f2 = ref();
  set(f1, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  set(f2, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageRefs = pages.map((page) => {
    const p = ref(), content = ref();
    let resources = `/Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>`;
    if (page.scan) {
      const { w, h, data } = scanImage(page.scan);
      const image = ref();
      set(image, stream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray `
        + '/BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode]', data));
      resources = `/XObject << /Im1 ${image} 0 R >>`;
      set(content, stream('', `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q\n`));
    } else {
      set(content, stream('', textPage(page)));
    }
    set(p, `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << ${resources} >> `
      + `/Contents ${content} 0 R >>`);
    return p;
  });
  set(pagesRef, `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  let outlineEntry = '';
  if (outlines.length) {
    const root = ref();
    const items = outlines.map(() => ref());
    items.forEach((item, i) => set(item, `<< /Title ${literal(outlines[i].title)} /Parent ${root} 0 R`
      + (i > 0 ? ` /Prev ${items[i - 1]} 0 R` : '') + (i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : '')
      + ` /Dest [${pageRefs[outlines[i].page]} 0 R /Fit] >>`));
    set(root, `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`);
    outlineEntry = ` /Outlines ${root} 0 R /PageMode /UseOutlines`;
  }
  set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R${outlineEntry} >>`);
  const infoRef = ref();
  set(infoRef, `<< ${Object.entries({ ...info, Producer: 'kirunak promo fixtures' })
    .map(([key, value]) => `/${key} ${literal(value)}`).join(' ')} >>`);

  const parts = [Buffer.from('%PDF-1.4\n')];
  let offset = parts[0].length;
  const offsets = bodies.map((body, i) => {
    const bytes = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(body), Buffer.from('\nendobj\n')]);
    const at = offset;
    parts.push(bytes);
    offset += bytes.length;
    return at;
  });
  const xref = [`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${bodies.length + 1} /Root ${catalog} 0 R /Info ${infoRef} 0 R >>\nstartxref\n${offset}\n%%EOF\n`];
  parts.push(Buffer.from(xref.join('')));
  return Buffer.concat(parts);
}

export const build = () => Object.fromEntries(Object.entries(DOCUMENTS).map(([name, doc]) => [name, buildPdf(doc)]));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, bytes] of Object.entries(build())) {
    writeFileSync(new URL(name, import.meta.url), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}
