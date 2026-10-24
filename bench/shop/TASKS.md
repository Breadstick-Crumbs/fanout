# Tasks (one agent each)

## currency
Prices must support currencies and avoid floating-point money. Store prices as integer cents plus an ISO currency code (default "USD"). Update everything that creates or reads prices, and formatting, so the existing behaviour still works. Add tests.

## discounts
Add coupon support to the cart: applyCoupon(cart, code) with SAVE10 (10% off the whole cart) and FLAT5 (5 dollars off, never below zero). total(cart) must reflect the applied coupon. Add tests.

## receipt
Add receipt(cart) in a new module src/receipt.mjs. It returns a multi-line string: one line per item ("name x qty  <line price>"), then a final "Total  <total>" line, with prices formatted the same way as the rest of the shop. Export it from src/index.mjs (generated: run `npm run gen`). Add tests.

## tax
Add taxFor(cart, region) in a new module src/tax.mjs, with rates CA 7.25%, NY 4%, and 0 for any other region, applied to the cart total. Export it from src/index.mjs (generated: run `npm run gen`). Add tests.
