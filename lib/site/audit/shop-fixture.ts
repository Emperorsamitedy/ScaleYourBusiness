// A fixture shop for the site audit's tests (P5-11..13): a Shopify-shaped
// site on *.example (which never resolves), read through a recording
// fetcher. /collections/sale is linked but missing — the broken link — and
// the blue bowl's price sits below its first screen. No network, ever.

import type { FetchedPage, PageFetcher } from "../fetch";

export const SHOP = "https://audit-shop.example";

const shell = (body: string) => `<!doctype html><html><head><title>Shop</title>
<script src="https://cdn.shopify.com/s/files/theme.js"></script></head><body>
<header><a href="/">Shop</a><nav><a href="/collections/all">Shop all</a> <a href="/pages/contact">Contact</a> <a href="/cart">Cart</a> <a href="/account/login">Log in</a> <a href="/collections/sale">Sale</a></nav></header>
<main>${body}</main><footer><a href="https://instagram.com/shop">Instagram</a></footer></body></html>`;

export const SHOP_PAGES: Record<string, string> = {
  [`${SHOP}/`]: shell(
    `<h1>Handmade bowls</h1><p>Bowls from €24.</p><a href="/collections/all">Browse</a>`,
  ),
  [`${SHOP}/collections/all`]: shell(
    `<h1>All</h1><a href="/products/blue-bowl">Blue bowl</a> <a href="/products/big-bowl">Big bowl</a> <a href="/cart/add?id=1">Quick add</a>`,
  ),
  [`${SHOP}/products/blue-bowl`]: shell(
    `<h1>Blue bowl</h1><p>A long story about the bowl, its clay and its glaze. ${"Thrown by hand. ".repeat(50)}</p><p class="price">€24.00</p><form action="/cart/add" method="post"><input type="hidden" name="id" value="1"><button type="submit">Add to cart</button></form>`,
  ),
  [`${SHOP}/products/big-bowl`]: shell(
    `<h1>Big bowl</h1><p class="price">€48.00</p><form action="/cart/add" method="post"><button type="submit">Add to cart</button></form>`,
  ),
  [`${SHOP}/cart`]: shell(
    `<h1>Your cart is empty</h1><form action="/cart" method="post"><button name="checkout">Check out</button></form><a href="/checkout">Checkout</a>`,
  ),
  [`${SHOP}/pages/contact`]: shell(
    `<h1>Contact</h1><form action="/contact" method="post"><input name="first"><input name="last"><input type="email" name="email" required><input type="tel" name="phone"><input name="company"><input name="city"><select name="topic"><option>a</option></select><input name="order"><textarea name="message" required></textarea><input type="hidden" name="form_type" value="contact"><button>Send</button></form><form role="search" action="/search"><input type="search" name="q"></form>`,
  ),
};

/** The fixture shop, recording every URL asked for. /collections/sale is missing: a broken link. */
export function shopFetcher(
  pages: Record<string, string> = SHOP_PAGES,
): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (url: string): Promise<FetchedPage> => {
    asked.push(url);
    const html = pages[url];
    return {
      url,
      status: html ? 200 : 404,
      html: html ?? "<h1>Not found</h1>",
      headers: { "content-type": "text/html" },
      duration_ms: 30,
    };
  }) as PageFetcher & { asked: string[] };
  fetcher.asked = asked;
  return fetcher;
}
