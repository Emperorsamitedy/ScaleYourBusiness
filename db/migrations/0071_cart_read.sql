-- Idea 47, review 2026-10-30: how a store's last abandoned-cart reads went
-- (connections.cart_read), so /carts never headlines a stale figure and can
-- say when the store holds too many checkouts to read in full. Additive,
-- nullable, forward-only; state only, no shopper data.
ALTER TABLE "connections" ADD COLUMN "cart_read" jsonb;
