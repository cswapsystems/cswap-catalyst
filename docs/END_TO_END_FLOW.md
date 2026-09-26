# CSWAP end-to-end flow map

This is the end-to-end Preprod flow for original RWA minting, fractional ownership, asset-registry admission, shared-pool liquidity, Instant Sell, direct listings, pool-owned inventory, and the separate three-party FT DEX bootstrap.

Current deployment identities and verification boundaries are recorded in the [2026-09-25 redeployment report](PREPROD_REDEPLOYMENT_2026-09-25.md). Diagrams describe protocol flows, not live balances or proof of hosted publication. Indexer deployment is deferred.

## Legend

~~~text
[Wallet]       Payment-key wallet that signs a transaction and holds assets.
{Contract}     Validator/script address that holds UTxOs with a datum.
<Policy>       Minting or burning policy for a native asset.
(State UTxO)   Continuing authenticated state, normally identified by an NFT.
-->            On-chain asset or state transition.
==>            Off-chain review, operator decision, or UI safety check.
~~~

## 1. System overview

~~~text
                             ORIGINATION

[Issuer wallet] -- mint --> <one-shot NFT policy> --> [Original RWA NFT]
                                                        |
       +------------------------------------------------+--------------------------------------+
       |                                                |                                      |
       v                                                v                                      v
Direct listing / purchase                    Fractional ownership                 Shared-pool admission
       |                                                |                                      |
       |                                  [Owner holds original NFT]            [Asset holder]
       |                                                |                                      |
       |                                    -- Fractionalize --> {Fraction vault} -- Request support -->
       |                                                |                                  {asset_registry_request}
       |                                      original NFT + datum                         |
       |                                                |                              [Registry admin]
       |                                      <fraction policy>                         ==> review
       |                                                |                                  |
       |                                      [fraction tokens]                 -- approve --> {Asset registry}
       |                                                |                                  |
       +------------------------- list / buy -----------+----------------------> [Approved exact asset unit]
~~~

An asset is always the exact policy ID plus asset name. A ticker or display name is not an asset identity.

## 2. Mint and fractionalize

~~~text
[Issuer wallet]
   |
   | 1. Choose a one-shot seed, name, and CIP-25 metadata.
   v
<multi_nft_policy> -- mints one original RWA NFT --> [Issuer or owner wallet]
   |
   | 2. Optional: My assets > Fractionalize.
   v
<ft_policy> -- mints declared fraction supply --> [Owner holds fraction tokens]
   |
   v
{Fraction vault}
  value: original RWA NFT + ADA buffer
  datum: original NFT, fraction asset, full supply, owner/admin, policy seed

[Fraction holder with full required supply]
   |
   | Combine: spend vault + burn the entire required fraction supply
   v
[Original RWA NFT returned to a payment-key wallet]
~~~

The vault preserves the link between the original NFT and its fractions. Combining requires the validator to see the full-supply burn before it releases the original NFT.

## 3. Request an asset for the shared pool, then approve it

~~~text
[Asset holder]
   |
   | 1. Asset controls > Request asset support.
   |    The picker chooses known original RWA assets in the connected wallet.
   v
{asset_registry_request}
  request UTxO datum:
    requester address + payment key hash
    exact requested asset units
  value:
    refundable ADA deposit
   |
   | 2. The request is visible in Asset Registry / Asset controls.
   v
[Team registry administrator]
   |
   | ==> Verify legal status, valuation, custody, and the exact asset unit.
   |
   +-- reject or requester cancel --> [Refund ADA deposit]
   |
   └-- approve --> {Asset registry}
                    registry identity NFT + approved exact-unit list
                         |
                         └--> [Refund ADA deposit]
~~~

Registry approval is an independent issuer approval record, not the acquisition gate. The current Team acquisition builder and validators use the pool's on-chain exact-asset prices, not registry membership. Approval does not automatically post prices; off-chain quantity/activity limits add separate operator controls.

## 4. Create the reserve pool and add reserves

~~~text
[Team deployment wallet]
   |
   | 1. Deploy marketplace scripts and mint identity assets.
   v
<pool identity policy>          --> pool NFT
<pool share policy>             --> LP-token policy
<pool inventory receipt policy> --> inventory-receipt policy
   |
   | 2. Lock the initial quote reserve and pool NFT.
   v
{shared_reserve_pool}
  (authenticated pool UTxO)
  value: quote-asset reserve + pool NFT
  datum: admin, batcher, pool token, LP token, inventory token, quote asset,
         prices, total LP supply, min cash reserve, paused,
         inventory cost, inventory value, inventory count, closing LP
   |
   +------------------------------------+
   |                                    |
   v                                    v
[LP wallet]                         [Team / Reserves pages]
Add quote reserve                   read current pool state
   |                                    |
   v                                    |
<pool share policy> -- mint proportional LP tokens --> [LP wallet]
~~~

ADA is stored in lovelace. As an illustrative example, 120,000,000 lovelace is 120 ADA; with a 20 ADA floor, 100 ADA is available for bids. The fresh deployment actually started with 20 tADA, all protected, zero LP supply and no prices. It needs separate funding and pricing before acquisitions.

Deposits mint LP shares against cash plus inventory acquisition cost and allow open inventory, but not paused/closing pools. Partial withdrawal pays only the burned share of cash above the protected reserve, including with open inventory or while paused; it gives up inventory exposure and can round to zero. The final LP records an exit, recovers each inventory listing, then burns the pool identity and receives remaining reserve assets. The current identity supports burning; old identities are not upgraded.

## 5. Price and settle an Instant Sell request

~~~text
[Seller of an asset with a posted pool price]
   |
   | 1. Portfolio > Sell / List > Instant Sell to pool.
   |    Review the operator bid and request it as the minimum payout.
   v
{marketplace listing escrow · InstantSell listing}
  value: seller RWA + ADA buffer
  datum: pool identity, exact RWA, quantity, quote asset, minimum payout
   |
   | Seller may cancel before acceptance.
   v
[Authorized batcher / Team wallet]
   |
   | ==> Check posted price, exact unit, current UTxOs,
   |     seller minimum, valuation, bid, resale ask, inventory risk,
   |     and post-settlement protected reserve.
   |
   | 2. One transaction consumes request + pool UTxO.
   +---------------------------+------------------------------+-------------------------------+
   |                           |                              |                               |
   v                           v                              v                               v
[Seller receives bid       {shared_reserve_pool continues} <pool inventory receipt> {marketplace listing escrow}
 + returned ADA buffer]    reduced by settlement       mints inventory receipt     pool-owned RWA listing
                            cost += bid, value += ask, count += 1                  at the posted ask
~~~

The seller accepts a minimum payout, not a completed sale. At `/team/inventory`, the operator posts on-chain buy/sell ratios in quote-asset base units and separately publishes off-chain quantity caps and active status. `/team` rechecks prices, limits, inventory and cash before acquisition. The seller receives the posted bid plus its original ADA buffer; pool cash falls by the bid only, while the batcher funds the new inventory ADA. Archive the limits revision, approval, input references, prices and confirmed hash. Prices and reserve accounting are validator-enforced; quantity/activity limits are off-chain controls.

### Reserve-protection boundary

The quote-pool validator enforces the post-settlement floor: `BatcherAcquire` fails unless cash stays at or above `min_cash_reserve` after the payout, and the Team UI checks the same rule before signing. Prices, however, are posted by the batcher without on-chain bands; price discipline remains an operator control.

## 6. Buy pool-owned inventory

~~~text
[Buyer wallet]
   |
   | 1. Select a pool-owned listing in Marketplace.
   | 2. Pay its declared ask in the quote asset.
   v
{marketplace listing escrow} + inventory receipt
   |
   | 3. Purchase consumes the listing and burns the receipt.
   +--------------------------+----------------------------+----------------------+
   |                          |                            |                      |
   v                          v                            v                      v
[Buyer receives RWA]    {shared_reserve_pool continues} <pool inventory receipt> inventory value falls
                         receives quote payment    burns receipt
~~~

The inventory receipt binds a pool-owned listing to its settlement path. A direct listing cannot be treated as pool inventory merely because it has the same asset name.

## 7. Direct listing and direct purchase

~~~text
[Seller wallet]
   |
   | 1. Portfolio > Sell / List > List at my price.
   v
{simple_orderbook}
  datum: seller, exact RWA, quantity, requested asset/ADA price, seller key
  value: listed RWA + ADA buffer
   |
   +-- seller cancels --> [Seller receives RWA + returned ADA buffer]
   |
   └-- [Buyer wallet] pays listed price --> [Seller receives payment]
                                            [Buyer receives RWA]
~~~

This route never uses the shared quote pool. ADA prices display as ADA while their on-chain datum keeps an integer lovelace amount. Native-token prices display in the asset's smallest units because a universal decimal scale is not safe to assume.

## 8. Three-party FT DEX bootstrap (separate from the shared pool)

~~~text
[FT provider wallet]
   |
   | 1. DEX > Create bootstrap offer.
   |    Lock FT quantity, fixed quote reserve, ADA buffer, and LP-share split.
   v
{bootstrap_offer}
   |
   | 2. A different liquidity-provider wallet reviews immutable terms,
   |    funds the tADA or USDCx quote side, and signs the complete transaction.
   v
[LP wallet] -- prepares and signs quote-side settlement --> [Team creator/admin]
                                                           |
                                                           | 3. Reviews the same immutable transaction
                                                           |    and adds the required Team witness.
                                                           v
                                                       fully signed transaction
                                                           |
                                                           +--> {factory_state} advances pool ID
                                                           +--> <pool factory> mints pool NFT
                                                           +--> <LP policy> mints LP supply
                                                           +--> {AMM pool} receives both reserves
                                                           +--> [FT provider receives provider LP share]
                                                           └--> [LP receives provider LP share]
~~~

The DEX price follows its constant-product reserves. Shared-pool Instant Sell is an RFQ-style process whose price is set by the authorized batcher, so these systems are not interchangeable.

## Roles and signing boundaries

| Role | Wallet or contract | Can do | Must not do |
| --- | --- | --- | --- |
| Issuer | Issuer wallet and minting policy | Mint original RWA NFTs | Reuse a consumed one-shot seed |
| Asset holder | User wallet | Request support, list, Instant Sell, fractionalize owned original | Self-approve unless separately authorized |
| Registry administrator | Registry admin wallet and asset_registry_request | Approve/reject requests and update registry | Use ticker instead of exact asset unit |
| LP | LP wallet and LP policy | Add reserves, burn shares for cash, complete final exit | Treat inventory ask value as withdrawable cash |
| DEX Team creator | Configured `factory_state` admin wallet | Review and co-sign an FT bootstrap acceptance | Substitute the FT provider or liquidity provider role |
| Batcher | Authorized batcher wallet | Post buy/sell ratios and acquire Instant Sell listings | Bypass posted prices, quantity limits or the reserve floor |
| Buyer | Buyer wallet | Buy direct or pool-owned inventory | Sign a transaction built from stale UTxOs |

## Read before signing

Refresh immediately before signing. A state-changing action consumes a specific UTxO, so another confirmed transaction makes the old input stale. Confirm the exact asset unit, script address, inline datum, signer role, quote amount, returned ADA buffer, and final transaction hash.
