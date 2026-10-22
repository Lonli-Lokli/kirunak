import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DOCUMENTS, INVENTED, ORDINARY } from '../promo/fixtures/documents.mjs';
import { build } from '../promo/fixtures/make.mjs';

const DIR = new URL('../promo/fixtures/', import.meta.url);
const read = (name) => readFileSync(new URL(name, DIR), 'latin1');
const unescape = (s) => s.replace(/\\(.)/g, '$1');
// Every string the file carries (page text, title, subject, keywords, bookmarks); the scan's picture is hex, so it
// holds none. shown is the text a page prints (the strings Tj draws).
const strings = (pdf) => [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((m) => unescape(m[1]));
const shown = (pdf) => [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => unescape(m[1]));
const scanLines = (doc) => doc.pages.flatMap((page) => page.scan ?? []).map((line) => line.replace('█', ''));
const nameWords = new Set([...INVENTED.people, ...INVENTED.addresses].flatMap((s) => s.match(/[A-Za-z]+/g)));
const inventedDigits = INVENTED.numbers.map((n) => n.replace(/\D/g, ''));
const title = (w) => w[0] + w.slice(1).toLowerCase();

test('the committed PDFs are exactly what make.mjs builds', () => {
  const built = build();
  assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith('.pdf')).sort(), Object.keys(DOCUMENTS).sort());
  for (const [name, bytes] of Object.entries(built)) {
    assert.ok(bytes.equals(readFileSync(new URL(name, DIR))), `${name} is stale: run node promo/fixtures/make.mjs`);
  }
});

test('every name, number and email in the PDFs is on the made-up list', () => {
  const ordinary = new Set(ORDINARY.words);
  const usedOrdinary = new Set();
  for (const name of Object.keys(DOCUMENTS)) {
    for (const text of [...strings(read(name)), ...scanLines(DOCUMENTS[name])]) {
      for (const email of text.match(/\S+@\S+/g) ?? []) {
        assert.ok(INVENTED.emails.includes(email.replace(/[.,]$/, '')), `${name}: ${email} is not a made-up email`);
        assert.match(email, /@example\.(com|org)\b/, `${name}: ${email} is not on a reserved domain`);
      }
      const words = text.replace(/\S+@\S+/g, '').match(/[A-Za-z]+/g) ?? [];
      for (const word of words.filter((w) => /^[A-Z]/.test(w))) {
        if (ordinary.has(word) || ordinary.has(title(word))) {
          usedOrdinary.add(ordinary.has(word) ? word : title(word));
          continue;
        }
        const broken = text.includes(`${word}-`) && [...nameWords].some((n) => n.startsWith(word));
        assert.ok(nameWords.has(word) || nameWords.has(title(word)) || broken,
          `${name}: "${word}" in "${text}" is neither on the made-up list nor an ordinary word`);
      }
      for (const run of text.replace(/(\d),(\d)/g, '$1$2').match(/\d{3,}/g) ?? []) {
        assert.ok(ORDINARY.numbers.includes(run) || inventedDigits.some((d) => d.includes(run)),
          `${name}: ${run} in "${text}" is not a made-up number`);
      }
    }
  }
  for (const word of ORDINARY.words) assert.ok(!nameWords.has(word), `${word} is a name word, not an ordinary one`);
  assert.deepEqual([...ordinary].filter((w) => !usedOrdinary.has(w)), [], 'ordinary words no document uses');
  for (const phone of INVENTED.numbers.filter((n) => /^555-/.test(n))) {
    assert.ok(Number(phone.slice(4)) >= 100 && Number(phone.slice(4)) <= 199, `${phone} is outside 555-0100 to 0199`);
  }
});

test('lease.pdf: the name and phone copy out from under their bars; the removed reference does not', () => {
  const pdf = read('lease.pdf');
  const page = shown(pdf);
  assert.ok(page.includes('Marigold Quellmarsh'));
  assert.ok(page.includes('555-0143'));
  assert.ok(page.includes('MARIGOLD QUELLMARSH'));
  assert.ok(!page.some((s) => s.includes('7730 4196')));
  assert.equal((pdf.match(/ re f$/gm) ?? []).length, 4);
  // A real redaction must strip these too.
  assert.match(pdf, /\/Title \(Lease, 14 Quillfeather Lane: Marigold Quellmarsh\)/);
  assert.match(pdf, /\/Keywords \(lease, Quellmarsh, 7730 4196\)/);
  assert.equal((pdf.match(/\/Title \([^)]*Quellmarsh[^)]*\) \/Parent/g) ?? []).length, 2);
});

test('scanned.pdf: page 1 is text with nothing under its bar, page 2 is a picture with no text', () => {
  const pdf = read('scanned.pdf');
  assert.ok(!shown(pdf).some((s) => s.includes('Quellmarsh')));
  assert.match(pdf, /\/Subtype \/Image/);
  const contents = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
  assert.equal(contents.filter((c) => c.includes('BT ')).length, 1);
  assert.equal(contents.filter((c) => c.includes('/Im1 Do')).length, 1);
});

test('occurrences.pdf: a literal search for the name finds two of its five', () => {
  const lines = shown(read('occurrences.pdf'));
  const text = lines.join('\n');
  assert.equal(text.split('Marigold Quellmarsh').length - 1, 2);
  assert.equal(text.toLowerCase().split('marigold quellmarsh').length - 1, 3);
  assert.ok(lines.some((l) => l.endsWith('Marigold Quell-')) && lines.some((l) => l.startsWith('marsh ')));
  assert.ok(text.includes('marigold.quellmarsh@example.com'));
  assert.ok(text.includes('7730 4196') && text.includes('77304196'));
});
