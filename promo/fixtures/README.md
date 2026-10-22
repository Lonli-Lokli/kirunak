# Made-up PDFs for the promo

The PDFs the promo's demo app is built and filmed against: a free check of whether a PDF's black bars really hide the
text, and real redaction. Every name, address, number and email in them is invented and listed in `documents.mjs`;
`test/promo-fixtures.test.mjs` refuses any other name, keeps phone numbers in the 555-0100 to 555-0199 block and emails
on example.com and example.org.

| File | Pages | What it is for |
| --- | --- | --- |
| `lease.pdf` | 2 | The key frame. The tenant's name and phone lie under black bars and still copy out; the deposit reference was removed properly, so its bar hides nothing. The title, subject, keywords and both bookmarks still carry the name, which a real redaction strips. |
| `scanned.pdf` | 2 | Page 1 is text whose one bar hides nothing (clean). Page 2 is a picture of a receipt with no text layer: a checker cannot read it and must say so, not call it clean. |
| `occurrences.pdf` | 1 | One name written five ways (whole, broken across a line as "Quell-" / "marsh", in capitals, inside an email address, whole again) and one number spaced two ways ("7730 4196", "77304196"). A literal, case-sensitive search finds two of the five names. |

`node promo/fixtures/make.mjs` writes them again, byte for byte, with no dependency; the test fails when a committed
file differs from what the script builds.
