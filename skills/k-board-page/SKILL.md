---
name: k-board-page
description: Publishes kirunak's board as a private page on claude.ai and answers with its link, so the owner can read it on the phone. Use ONLY when the owner types /k-board-page; never on your own judgement, and never to refresh the page unasked.
---

# k-board-page: the board as a page for the phone

One turn, these steps in this order and nothing else: no other tool, no other skill, no edit of any file but
`board-artifact.json`. `<home>` is `$KIRUNAK_HOME`, or `~/.kirunak` when it is not set.

1. **Write the page**, where `<file>` is `board.html` in this session's scratchpad directory when the session has
   one, else `<home>/board.html`:

   ```sh
   k board --html <file> --no-open
   ```

   If `k` refuses, answer with its message and stop.
2. **Read** `<file>` whole (the Artifact tool publishes only a file you have read) and note the time after
   "Made at". The page is kirunak's own, tested for both themes, contrast and reading order: publish it as it is.
3. **Read** `<home>/board-artifact.json` if it exists: `{ "url": "<the page's link>" }`.
4. **Publish** with the Artifact tool:
   - With a url: first read that artifact with the Artifact tool's `read` action (a publish to an artifact this
     conversation has not read is refused), then publish `<file>` with that `url`, which keeps the link. If the
     read says the artifact is gone or cannot be written, publish it new as below.
   - With none: publish `<file>` as a new artifact, private, with no capabilities and the icon `board`.
5. **Keep the link**: write `{ "url": "<url>" }` to `<home>/board-artifact.json` with the Write tool.
6. **Answer in one line**, naming kirunak once: `kirunak: board published at <time>: <url>`.
