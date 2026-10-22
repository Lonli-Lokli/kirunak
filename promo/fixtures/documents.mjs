// The made-up documents the promo's app is built and filmed against. Every name, number, address and email in them
// is invented and listed in INVENTED; test/promo-fixtures.test.mjs refuses any other name. Phone numbers sit in the
// 555-0100 to 555-0199 block kept for fiction, emails on example.com and example.org (RFC 2606).
//
// A line is a list of pieces: a string is printed; { covered } is printed with a black bar drawn on top, so the text
// is still there to copy (the bad redaction the checker finds); { removed } prints nothing and draws the bar where the
// text was (a real redaction, which the checker must pass). { bold: true } sets the line in Helvetica-Bold, { size }
// its size, { gap } extra space above it.

export const INVENTED = {
  people: ['Marigold Quellmarsh', 'Tobias Fenwright', 'Imogen Saltcote'],
  addresses: ['14 Quillfeather Lane, Marrowdene', '9 Tallowby Mews, Marrowdene', '22 Brindlecombe Road, Marrowdene'],
  numbers: ['555-0143', '555-0178', '7730 4196'],
  emails: ['marigold.quellmarsh@example.com', 'lettings@example.org'],
};

// Capitalised words that are not names, and numbers that identify no one (amounts, days, the year).
export const ORDINARY = {
  words: [
    'April', 'Amount', 'Date', 'Dear', 'Deposit', 'Email', 'Keys', 'Landlord', 'Lease', 'March', 'Notice', 'Parties',
    'Please', 'Property', 'Received', 'Receipt', 'Rent', 'Residential', 'Signatures', 'Signed', 'Tenant', 'Term',
    'The', 'This', 'We', 'Your', 'Yours', 'From', 'One', 'Any', 'Return', 'If', 'Pets', 'Repairs', 'Review', 'February', 'To', 'Witness',
  ],
  numbers: ['1150', '1185', '1725', '2026', '2027'],
};

const tenant = { covered: 'Marigold Quellmarsh' };

export const DOCUMENTS = {
  // Research section 1's key frame and task 1's main case: the tenant's name and phone lie under bars and copy out;
  // the deposit reference was removed properly. The title, subject, keywords and bookmarks still carry the name
  // (task 2: a real redaction strips them too).
  'lease.pdf': {
    info: {
      Title: 'Lease, 14 Quillfeather Lane: Marigold Quellmarsh',
      Author: 'Tobias Fenwright',
      Subject: 'Residential lease for Marigold Quellmarsh',
      Keywords: 'lease, Quellmarsh, 7730 4196',
    },
    outlines: [
      { title: 'Parties: Tobias Fenwright and Marigold Quellmarsh', page: 0 },
      { title: 'Signatures of Marigold Quellmarsh and Tobias Fenwright', page: 1 },
    ],
    pages: [
      [
        [{ bold: true, size: 18 }, 'Residential Lease'],
        [{ gap: 10 }, 'This lease is made on 1 March 2026 between:'],
        [{ gap: 6 }, 'Landlord: Tobias Fenwright, 9 Tallowby Mews, Marrowdene'],
        ['Tenant: ', tenant],
        ["Tenant's phone: ", { covered: '555-0143' }],
        [{ gap: 6 }, 'Property: 14 Quillfeather Lane, Marrowdene'],
        ['Rent: 1,150 a month, due on the first day of each month.'],
        ['Deposit: 1,725, protected under reference ', { removed: '7730 4196' }, '.'],
        ['Term: twelve months from 1 March 2026.'],
        [{ gap: 10, bold: true }, 'Repairs'],
        ['The landlord keeps the roof, walls, wiring and boiler in good repair. The tenant reports'],
        ['a fault within seven days and lets the landlord in, with a day of notice, to mend it.'],
        [{ gap: 10, bold: true }, 'Pets'],
        ['One cat is allowed. Any other pet needs the landlord\'s written consent.'],
        [{ gap: 10, bold: true }, 'Keys'],
        ['The tenant receives two front door keys and one key to the side gate.'],
      ],
      [
        [{ bold: true, size: 14 }, 'Signatures'],
        [{ gap: 10 }, 'Landlord: Tobias Fenwright          Date: 1 March 2026'],
        ['Tenant: ', { covered: 'MARIGOLD QUELLMARSH' }, '          Date: 1 March 2026'],
        [{ gap: 6 }, 'Witness: Imogen Saltcote, 22 Brindlecombe Road, Marrowdene'],
      ],
    ],
  },

  // Task 1's edge case: page 1 is text whose one bar hides nothing (clean); page 2 is a picture of a page with no
  // text layer, which a checker cannot read and must not call clean.
  'scanned.pdf': {
    info: { Title: 'Rent review and receipt', Author: 'Tobias Fenwright' },
    pages: [
      [
        [{ bold: true, size: 16 }, 'Notice of Rent Review'],
        [{ gap: 10 }, 'From: Tobias Fenwright, 9 Tallowby Mews, Marrowdene'],
        ['To: ', { removed: 'Marigold Quellmarsh' }, ', 14 Quillfeather Lane, Marrowdene'],
        [{ gap: 10 }, 'Your rent will be 1,185 a month from 1 April 2026.'],
        ['If you have questions, write to lettings@example.org or call 555-0178.'],
      ],
      {
        scan: [
          'RENT RECEIPT',
          '',
          'RECEIVED FROM: █',
          'PROPERTY: 14 QUILLFEATHER LANE, MARROWDENE',
          'AMOUNT: 1,150',
          'DATE: 1 APRIL 2026',
          'SIGNED: TOBIAS FENWRIGHT',
        ],
      },
    ],
  },

  // Task 3's edge cases: one name written five ways (once whole, broken across a line, in capitals, inside an email
  // address, whole again) and one number spaced two ways. A literal, case-sensitive search finds two of the five.
  'occurrences.pdf': {
    info: { Title: 'Deposit return', Author: 'Tobias Fenwright' },
    pages: [
      [
        [{ bold: true, size: 16 }, 'Deposit Return'],
        [{ gap: 10 }, 'Dear Marigold Quellmarsh,'],
        [{ gap: 6 }, 'The lease at 14 Quillfeather Lane ends on 28 February 2027. We will return the deposit'],
        ['paid in March 2026 by the tenant named in the lease, Marigold Quell-'],
        ['marsh within ten days of the final inspection, less any agreed repairs.'],
        [{ gap: 6 }, 'Deposit reference: 7730 4196'],
        ['Please quote 77304196 when you reply.'],
        [{ gap: 6 }, 'TENANT: MARIGOLD QUELLMARSH'],
        ['Email: marigold.quellmarsh@example.com'],
        [{ gap: 10 }, 'Yours sincerely,'],
        ['Tobias Fenwright, for the tenancy of Marigold Quellmarsh'],
      ],
    ],
  },
};
