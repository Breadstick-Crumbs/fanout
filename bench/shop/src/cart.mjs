export function makeCart() {
  return { items: [] };
}

export function addItem(cart, product, qty = 1) {
  cart.items.push({ product, qty });
  return cart;
}

export function total(cart) {
  return cart.items.reduce((sum, { product, qty }) => sum + product.price * qty, 0);
}
