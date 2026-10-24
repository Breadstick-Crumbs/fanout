# Tasks (one agent each)

Every new module goes in `src/` and is exported from `src/index.mjs`, which is generated: run `npm run gen` after adding a module. Money is in dollars as numbers rounded to cents. Dates are "YYYY-MM-DD" strings; use `src/dates.mjs`. The seed data in `data/sample.mjs` is handy for tests. Add tests in `test/` for what you build.

## search
Add `search(store, query)` in `src/search.mjs`. Every `query` field is optional:
- `q`: case-insensitive; every whitespace-separated word in `q` must appear in the book's title or author.
- `author`: exact author match, case-insensitive.
- `tag`: the book has this tag.
- `yearFrom`, `yearTo`: inclusive bounds on `year`.
- `available`: when `true`, only books with `availableCopies(store, id) > 0`.
- `sort`: `"title"` (default, A to Z, case-insensitive) or `"year"` (newest first, ties by title A to Z).
- `page` (default 1) and `pageSize` (default 10).

Return `{ items, total, page, pages }`: `items` are the matching book objects on that page, `total` counts all matches before paging, `pages` is `Math.ceil(total / pageSize)`.

## fines
Add `src/fines.mjs`:
- `finesFor(store, memberId, asOf)`: one entry `{ loanId, bookId, daysLate, amount }` per late loan of that member. A loan's late days are the days from its due date to its return date (or to `asOf` if still open), minus a 2-day grace period. Only loans with `daysLate > 0` are listed. `amount` is $0.25 per late day, capped at $10.00 per loan. Order by `loanId`.
- `memberBalance(store, memberId, asOf)`: the sum of that member's fine amounts minus the sum of that member's payments, rounded to cents.
- `payFine(store, memberId, amount, date)`: records `{ memberId, amount, date }` in `store.payments` and returns the new balance as of `date`.

`createStore` must start every store with `payments: []` (keep any `seed.payments`).

## csv
Add `src/csv.mjs`:
- `exportBooks(store)`: CSV text. Header `id,title,author,year,tags,copies`, then one line per book in store order. `tags` are joined with `;`. A field containing a comma, a double quote or a newline is wrapped in double quotes, with inner double quotes doubled. Lines end with `\n`, including the last.
- `importBooks(store, text)`: parses CSV whose first line is a header naming the columns `title,author,year,tags,copies` in any order (the same quoting rules apply; `tags` split on `;`, empty means none). Each valid row is added with `addBook`. Returns `{ added, errors }` where `errors` is `[{ line, message }]` and `line` is the 1-based line number in the text (the header is line 1). A row is invalid, and skipped, when `title` or `author` is empty, `year` is not a whole number, or `copies` is not a positive whole number (an empty `copies` means 1).

## reports
Add `src/reports.mjs`:
- `overdueReport(store, asOf)`: open loans whose due date is before `asOf`, as `{ loanId, bookId, title, memberId, memberName, daysOverdue }` (days from due date to `asOf`), sorted by `daysOverdue` descending, then `loanId` ascending.
- `popularBooks(store, { from, to, limit = 5 })`: books ranked by the number of loans whose `out` date is within `from`..`to` inclusive, as `{ bookId, title, loans }`, sorted by `loans` descending then `title` ascending, at most `limit`, books with no such loans left out.
- `memberActivity(store, memberId)`: `{ memberId, totalLoans, openLoans, lastOut }` where `lastOut` is the latest `out` date, or `null`.

## holds
Add `src/holds.mjs` and change `src/store.mjs`:
- `placeHold(store, bookId, memberId, date)`: adds `{ id, bookId, memberId, date }` to `store.holds` and returns it. Throws if the book or member doesn't exist, or that member already holds that book.
- `cancelHold(store, holdId)`: removes it.
- `holdsFor(store, bookId)`: that book's holds in the order they were placed.

`createStore` must start every store with `holds: []` (keep any `seed.holds`). A book's free copies are `copies` minus its open loans. `availableCopies(store, bookId)` becomes `max(0, free copies - number of holds on the book)`. In `checkout`: if the member holds the book and their position in its queue (1-based) is at most the free copies, the checkout succeeds and their hold is removed; otherwise it needs `availableCopies > 0`, or it throws `Error("no copies available")`.

## api
Add `src/api.mjs` with `createServer(store)`, returning a `node:http` server that is not yet listening. JSON in and out, with `Content-Type: application/json`:
- `GET /books` with optional query parameters `q`, `author`, `tag`, `page`, `pageSize` (numbers parsed): 200 with the result of `search(store, ...)` from `src/search.mjs`.
- `GET /books/:id`: 200 with the book, or 404 `{ "error": "not found" }`.
- `POST /loans` with body `{ bookId, memberId, date }`: 201 with the loan from `checkout`. A missing field gives 400 `{ "error": "missing <field>" }`; an error thrown by `checkout` gives 409 `{ "error": <its message> }`.
- `GET /members/:id/balance?asOf=YYYY-MM-DD`: 200 `{ memberId, balance }` using `memberBalance` from `src/fines.mjs`.
- Anything else: 404 `{ "error": "not found" }`.
