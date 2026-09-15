# CSWAP production architecture

## User protocols

- **RWA minting** (`contracts/minter`, `/mint`) creates uniquely seeded native assets.
- **Fraction vaults** (`ft_policy.ak`, `vault.ak`, `/fractionalize`) lock one original RWA and issue its fixed fraction supply. Normal combine burns the entire supply. Emergency recovery burns an available partial supply, requires the team recovery signature, and always returns the RWA to the owner recorded at vault creation. Unburned fractions become non-redeemable and must be removed from supported venues.
- **P2P marketplace** (`p2p_listing_simple.ak`, `/marketplace`) lets owners choose direct escrow terms.
- **Fraction DEX** (`contracts/dex`, `/dex`) provides create, destroy, add liquidity, remove liquidity, and swaps in both directions.

## Team-operated instant settlement

- **Exact-asset registry** (`asset_registry.ak`, `/registry`) is the on-chain allowlist. Entries are complete asset units, not policy-only approvals.
- **Shared quote pool** (`quote_pool.ak`, `/reserves`) holds settlement cash and issues LP shares, with a protected minimum reserve.
- **Sell requests** (`pool_sell_request.ak`, `/marketplace`) escrow assets with a cancellable minimum payout.
- **Team console** (`/team`) verifies the connected key against the batcher key, admits only registered assets, chooses the actual buy price and inventory ask, pays the seller, and creates receipt-bound inventory atomically.
- Any user may buy pool inventory at the team-set ask. Payment returns to the pool and the inventory receipt burns atomically.

The team controls prices for the shared instant-sell service. Direct P2P sellers retain control of their own listing terms.

## Deployment

`marketplace-deployment.preprod.json` is the public Preprod manifest consumed by the UI. `scripts/marketplace-preprod.mjs` atomically deploys the registry and pool, funds liquidity, and registers exact assets. Seed phrases and provider credentials remain operator secrets in `.env.local`; they must never enter client bundles or source control.

Production should run the batcher through an isolated signer with monitoring, idempotent transaction retries, registry audit logs, and multisig controls for admin and recovery roles.
