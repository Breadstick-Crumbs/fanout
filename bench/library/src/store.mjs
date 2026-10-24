// In-memory library store. Ids are strings; dates are "YYYY-MM-DD".
import { addDays } from "./dates.mjs";

export const LOAN_DAYS = 14;

export function createStore(seed = {}) {
  return {
    books: (seed.books ?? []).map((b) => ({ ...b, tags: [...(b.tags ?? [])] })),
    members: (seed.members ?? []).map((m) => ({ ...m })),
    loans: (seed.loans ?? []).map((l) => ({ ...l })),
    nextId: seed.nextId ?? 1000,
  };
}

export function addBook(store, { title, author, year, tags = [], copies = 1 }) {
  const book = { id: `b${store.nextId++}`, title, author, year, tags: [...tags], copies };
  store.books.push(book);
  return book;
}

export const getBook = (store, id) => store.books.find((b) => b.id === id) ?? null;

export function addMember(store, { name, email }) {
  const member = { id: `m${store.nextId++}`, name, email };
  store.members.push(member);
  return member;
}

export const getMember = (store, id) => store.members.find((m) => m.id === id) ?? null;

export const openLoans = (store, bookId) => store.loans.filter((l) => l.bookId === bookId && !l.returned);

export function availableCopies(store, bookId) {
  const book = getBook(store, bookId);
  return book ? book.copies - openLoans(store, bookId).length : 0;
}

export function checkout(store, bookId, memberId, date) {
  if (!getBook(store, bookId)) throw new Error("no such book");
  if (!getMember(store, memberId)) throw new Error("no such member");
  if (availableCopies(store, bookId) <= 0) throw new Error("no copies available");
  const loan = { id: `l${store.nextId++}`, bookId, memberId, out: date, due: addDays(date, LOAN_DAYS), returned: null };
  store.loans.push(loan);
  return loan;
}

export function checkin(store, loanId, date) {
  const loan = store.loans.find((l) => l.id === loanId);
  if (!loan || loan.returned) throw new Error("no such open loan");
  loan.returned = date;
  return loan;
}
