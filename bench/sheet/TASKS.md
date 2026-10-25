# Tasks (one agent each)

A small spreadsheet engine. A sheet (`src/sheet.mjs`) stores each cell's raw text by address; addresses are handled by `src/addr.mjs`. Every new module goes in `src/` and is exported from `src/index.mjs`, which is generated: run `npm run gen` after adding a module. A cell *value* is a number, a string, a boolean, `null` (empty), or an error: a string starting with `#` (`"#DIV/0!"`, `"#VALUE!"`, `"#NAME?"`, `"#REF!"`, `"#NUM!"`, `"#ERROR!"`, `"#CYCLE!"`). Add tests in `test/` for what you build.

## formula
Add `src/formula.mjs` with:
- `parseFormula(text)`: parses a formula's text (without the leading `=`) and returns an AST of your design. Throws a `SyntaxError` on bad syntax.
- `refsOf(ast)`: the cell addresses the formula reads, normalized (no `$`, upper case), ranges expanded row by row, each address once, in order of first appearance.
- `evaluate(ast, lookup)`: the formula's value. `lookup(addr)` returns the value of a cell (normalized address) and `null` for an empty cell.

Syntax: numbers (`12`, `3.5`, `.5`, `1e3`); strings in double quotes, with `""` for a quote inside; `TRUE`, `FALSE`; cell references (`A1`, `$A$1`, `A$1`, `$A1`, any case); ranges (`A1:B3`, corners in any order) which are only allowed as function arguments (elsewhere the formula's value is `"#VALUE!"`); parentheses; function calls `NAME(arg, ...)` with case-insensitive names. Operators, lowest precedence first: comparison `= <> < > <= >=`; `&` (concatenation); `+ -`; `* /`; `^`; unary `-` and `+`. All binary operators are left-associative, and unary minus binds tighter than `^`, so `-2^2` is 4 and `2^3^2` is 64. Whitespace between tokens is ignored.

Values:
- Errors propagate: if an operand is an error, the result is that error (the left operand's first).
- Arithmetic (`+ - * / ^`, unary) converts operands to numbers: `null` is 0, `TRUE`/`FALSE` are 1/0, a string that is a number once trimmed (and not empty) is that number, any other string gives `"#VALUE!"`. Division by zero gives `"#DIV/0!"`. A result that is not finite gives `"#NUM!"`.
- `&` converts to text: `null` is `""`, numbers as JavaScript prints them, booleans as `TRUE`/`FALSE`.
- Comparisons give a boolean. `null` counts as 0 against a number, `""` against a string, and `FALSE` against a boolean. Numbers compare numerically, strings case-insensitively, booleans with `FALSE < TRUE`. Values of different types order number < string < boolean.
- Functions (wrong number of arguments gives `"#VALUE!"`, an unknown name gives `"#NAME?"`):
  - `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT` take any number of arguments. In a range, only number cells count (strings, booleans and empty cells are skipped) but an error cell propagates. A direct argument is converted like arithmetic, except for `COUNT`, which counts direct arguments that are numbers and never gives an error. `AVERAGE` of no numbers is `"#DIV/0!"`; `MIN`/`MAX` of no numbers is 0.
  - `IF(cond, then, [else])`: `cond` converts to a boolean (numbers: not 0; `null`: false; strings `"TRUE"`/`"FALSE"` any case; other strings `"#VALUE!"`). Only the chosen branch is evaluated. A missing `else` gives `FALSE`.
  - `AND`, `OR` (at least one argument; in ranges, numbers and booleans count, other cells are skipped), `NOT(x)`. Arguments convert like `IF`'s condition.
  - `ROUND(x, digits)` rounds half away from zero (`digits` may be negative), `ABS(x)`.
  - `LEN(s)`, `UPPER(s)`, `LOWER(s)` convert like `&`; `CONCAT(...)` joins all arguments as text, ranges row by row (an error cell propagates).

## recalc
Add `src/recalc.mjs`, built on `parseFormula`, `refsOf` and `evaluate` from `src/formula.mjs`:
- `valueOf(raw)`: the value of a non-formula cell's raw text. `""` is `null`; text that is a finite number once trimmed is that number; `TRUE`/`FALSE` (any case) are booleans; text starting with `'` is the rest of the text as a string; anything else is the string itself.
- `computeAll(sheet)`: a `Map` from every non-empty cell's address to its value. Raw text starting with `=` is a formula; one that doesn't parse has the value `"#ERROR!"`. Every cell on a reference cycle (including a cell that references itself) has the value `"#CYCLE!"`; cells that only read a cycle get whatever their formula gives with `"#CYCLE!"` as input. Must handle a chain of 10,000 formulas (`A2` is `=A1+1`, `A3` is `=A2+1`, ...) without a stack overflow.
- `dependents(sheet, addr)`: the formula cells that read `addr` directly or indirectly, not including `addr` itself, in an order where every cell comes after the cells of the list it reads. Among cells that are ready at the same time, take the first by row, then column. Cells on a cycle are left out.

## numfmt
Add `src/numfmt.mjs` with `formatNumber(value, pattern)`, a subset of spreadsheet number formats. A value that is not a number is returned as text (`null` as `""`, booleans as `TRUE`/`FALSE`). The pattern `General` gives the number as JavaScript prints it.
- Sections are separated by `;` (outside quotes): one section for all numbers; two for positive-and-zero; negative; three for positive; negative; zero. A negative number formatted with its own section is formatted as its absolute value with no minus sign added. With one section, a negative number gets a leading `-`, unless it rounds to all zeros.
- `0` is a digit that is always shown; `#` is a digit shown only when significant. In the integer part, the number has at least as many digits as there are `0`s (so `#.00` formats 0.5 as `.50`, `0.00` as `0.50`). After the `.`, the number of `0` and `#` placeholders is the number of decimals; it is rounded half away from zero on the decimal digits as JavaScript prints the number (so 1.005 with `0.00` is `1.01`), and trailing zeros are dropped for `#` places (`0.##` formats 2.5 as `2.5`, and 2 as `2.`).
- A `,` between digit placeholders in the integer part groups thousands with `,`.
- `%` multiplies the number by 100 and shows `%`.
- `0.00E+00`: scientific, with one integer digit, the decimals given, and an exponent of at least as many digits as there are `0`s after `E+`; `E+` always shows the exponent's sign, `E-` only a minus.
- Text in double quotes and the character after `\` are shown as is; `$ - + ( ) : /` and spaces are shown as is.

## csv
Add `src/csv.mjs`:
- `toCSV(sheet, values)`: CSV text for the rectangle from `A1` to the last used row and column. With `values` (a `Map` from address to value, as `computeAll` returns) each field is the cell's value as text (`null` as empty, booleans as `TRUE`/`FALSE`); with `values` null, each field is the raw text. A field is wrapped in double quotes, with inner quotes doubled, when it contains `,`, `"`, a newline or a carriage return, or starts or ends with a space. Every line has the same number of fields and ends with `\n`, including the last. An empty sheet is `""`.
- `fromCSV(text, options)`: a new sheet (`createSheet`) with the fields placed from `A1`. Rows end with `\n` or `\r\n`; quoted fields may contain the delimiter, newlines, and `""` for a quote; a final line break does not start a row; empty fields leave their cell empty. `options.delimiter` is the field delimiter; if it is not given, it is whichever of `,`, `;` or a tab occurs most in the first line outside quotes (`,` on a tie). By default a field starting with `=` is stored with a `'` in front, so it is not a formula; with `options.formulas` true it is stored as is. An unclosed quote throws an `Error` with the message `unclosed quote at line N`, where N is the 1-based line where the quoted field began.

## structure
Add `src/structure.mjs` with `insertRows(sheet, at, count = 1)`, `deleteRows(sheet, at, count = 1)`, `insertCols(sheet, at, count = 1)` and `deleteCols(sheet, at, count = 1)`. For rows, `at` is a 1-based row number; for columns, a column letter (`"C"`). Inserting moves the cells at and after `at` down (or right) by `count`; deleting removes `count` rows (or columns) starting at `at` and moves the later ones up (or left).

Every formula in the sheet is rewritten to follow the cells it reads:
- A reference to a moved cell is moved the same way, whether or not it has `$`, and keeps its `$` signs.
- A reference to a deleted cell becomes `#REF!` (the whole reference is replaced).
- A range keeps covering the same cells: inserting inside it, after its first row (or column) and up to its last, makes it bigger; deleting part of it makes it smaller; deleting all of it makes it `#REF!`.
- Only references are changed: text inside string literals and function names stay as they are. A reference is letters then digits (with optional `$`) not preceded or followed by a letter, digit, `_` or `.`, and not followed by `(`.

## table
Add `src/table.mjs`:
- `sortRange(sheet, range, keys, options)`: sorts the rows of `range` (like `"A2:C10"`) in place, moving each row's raw text within the range's columns only (formulas are moved unchanged). `keys` is a list of `{ col: "B", desc: false }`, compared in order. Cells are compared by their value using `valueOf` from `src/recalc.mjs`: numbers before strings (case-insensitive) before booleans (`FALSE` before `TRUE`), with `desc` reversing that, and empty cells always last. The sort is stable. With `options.header` true, the range's first row stays where it is.
- `pivot(values, range, { rows, value, agg })`: `values` is a `Map` from address to value (as `computeAll` returns) and the range's first row holds the column names. Groups the other rows by the value in column `rows` and aggregates column `value` with `agg`: `"sum"`, `"avg"`, `"min"`, `"max"` (over number values only; `avg`, `min` and `max` of none are `null`, `sum` of none is 0) or `"count"` (non-empty values). Returns `[{ key, value }]` ordered by key: numbers ascending, then strings case-insensitively, then booleans; rows whose key cell is empty form one group with key `"(blank)"`, last. Throws an `Error` naming the column if `rows` or `value` is not a column name.
