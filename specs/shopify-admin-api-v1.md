# Shopify Admin API — store changes (v1)

D6 in `TASKS-PHASE3.md`: Shopify store changes through the execution engine.
The owner decided this on 2026-11-16 ("make all these automatic all the owner
should do is just approve", then "Shopify first" for shop writes). The
executor is `lib/execution/providers/shopify.ts`, the only file that may send
a Shopify mutation. The read-only connector
(`lib/connectors/providers/shopify.ts`) is unchanged.

Every fact the code relies on is listed here. Each was read in Shopify's own
documentation on **2026-11-16**, through a search of shopify.dev, not by
reading every page in full. A fact is `verified: true` when a Shopify page
stated it, and `verified: false` when the pages read did not. For a `false`
fact the code takes the safe reading and refuses by name if Shopify answers
otherwise. None of this has been checked against a real store, so every
`verified: false` line needs re-checking on the first real connection, against
a development store.

Pages read:

- Admin GraphQL: `pageUpdate`, `PageUpdateInput`, `Page`, `productBundleCreate`, `ProductBundleOperation`, `productVariantsBulkUpdate`, `ProductVariant`, `AccessScope`
- `usage/access-scopes`
- `apps/build/product-merchandising/bundles/add-product-fixed-bundle`

## Version, endpoint and credential

| Fact                                                                                                                               | verified |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Admin GraphQL endpoint `https://{shop}.myshopify.com/admin/api/{version}/graphql.json`, header `X-Shopify-Access-Token`            | true     |
| Pinned version `2026-07`, the read connector's (`SHOPIFY_API_VERSION`); one constant for both                                      | true     |
| An owner-created Dev Dashboard app on the owner's own store gets a 24-hour token by the client credentials grant (the read route)   | true     |
| `currentAppInstallation { accessScopes { handle } }` lists the installation's granted scopes                                       | true     |
| A write scope grants the matching read, so `write_X` is requested alone                                                            | true     |
| Whether `accessScopes` also lists `read_X` beside a granted `write_X` (the code drops such an implied read before the exact match) | false    |
| A missing scope answers HTTP 200 with `errors[].extensions.code = ACCESS_DENIED` and `data: null`                                  | true     |
| A throttled request answers `extensions.code = THROTTLED` and is not executed, so sending it again is safe                         | false    |

## Scopes

| Fact                                                                                                                       | verified |
| -------------------------------------------------------------------------------------------------------------------------- | -------- |
| `pageUpdate` requires either `write_content` or `write_online_store_pages`. SYB asks for `write_online_store_pages`, which is narrower | true     |
| `productBundleCreate` requires `write_products`, and the shop must have access to the bundles feature                     | true     |
| `productOperation` (polling a bundle) requires `read_products`, which `write_products` grants                              | true     |
| `productVariantsBulkUpdate` requires `write_products`, and the app user must be allowed to edit variants                   | true     |
| `productUpdate` (the status, for undo by archiving) requires `write_products`                                              | false    |
| `shop { myshopifyDomain currencyCode primaryDomain { host } }` needs no extra scope                                        | false    |

## Pages (`update_page_body`)

| Fact                                                                                                         | verified |
| ------------------------------------------------------------------------------------------------------------ | -------- |
| `pageUpdate(id: ID!, page: PageUpdateInput!)` returns `{ page, userErrors }`                                 | false    |
| `PageUpdateInput` has `body` (HTML), as well as title, handle, isPublished and others SYB never sends        | true     |
| `pages(first:, query: "handle:<handle>")` finds a page by its handle                                          | false    |
| An online store page is served at `/pages/<handle>`                                                           | true     |
| Text in the theme, a product or a collection is not in a page's `body`, so SYB refuses those by name          | true     |

## Bundles (`create_bundle`)

| Fact                                                                                                                                         | verified |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `productBundleCreate(input: ProductBundleCreateInput!)` is asynchronous and returns `productBundleOperation { id status }` and `userErrors`   | true     |
| Each component is `{ productId, quantity, optionSelections: [{ componentOptionId, name, values }] }`                                          | true     |
| `productOperation(id:)` reports a status of CREATED, ACTIVE or COMPLETE, and gives `product { id }` once complete                             | true     |
| The bundle is one product, priced by the parent product (SYB sets its variant to the two components' full price)                              | true     |
| The bundle product's status when created (SYB sets it to ACTIVE, or DRAFT, as approved)                                                       | false    |
| A product created through the API is published to the Online Store channel by itself (if not, the owner adds the channel in Shopify)          | false    |
| `productUpdate(product: ProductUpdateInput!)` with `{ id, status }` archives a product. `ARCHIVED` is reversible, unlike `productDelete`       | false    |

## Prices (`set_variant_price`)

| Fact                                                                                                                       | verified |
| -------------------------------------------------------------------------------------------------------------------------- | -------- |
| `productVariantsBulkUpdate(productId:, variants: [{ id, price, compareAtPrice }])` changes prices. `productUpdate` can't    | true     |
| Prices are decimal strings with no currency, in the shop's default currency                                                | true     |
| `compareAtPrice: null` clears the compare-at price                                                                         | false    |
| `inventoryItem.unitCost { amount currencyCode }` is the variant's unit cost, readable under `read_products`                | true     |

## Not used, on purpose

- No order, checkout, customer, shipping, tax, discount, gift card, fulfilment or payment field, query or mutation. The executor's document scan refuses that vocabulary (rule 18).
- No `productDelete` or `pageDelete`. Undo archives a product and puts a page's old words back.
- No theme files (`write_themes`). Theme text stays the owner's to change, with the site-change card's before and after.
