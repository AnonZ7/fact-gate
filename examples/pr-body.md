## Per-plan rate limits

Moves the hard-coded limit into `src/limits.mjs` and wires it through the server.

- Touches 6 files: 2 new, 1 deleted, 3 modified
- Adds 26 lines, removes 6
- Adds 4 tests in `test/limits.test.mjs`
- Adds 1 dependency (`zod`) for request validation
- Corrects the README: the pro plan allows 5,000 requests/day
