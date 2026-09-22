# CSWAP end-to-end flow map

This is the end-to-end Preprod flow for original RWA minting, fractional ownership, asset-registry admission, shared-pool liquidity, Instant Sell, direct listings, pool-owned inventory, and the separate three-party FT DEX bootstrap.

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

Registry approval is an operator admission record. The current Team UI reads the authenticated registry before it builds an Instant Sell settlement. The deployed shared-pool validators do not yet consume a registry reference, so this must not be bypassed.

## 4. Create the reserve pool and add reserves

~~~text
[Team deployment wallet]
   |
   | 1. Deploy marketplace scripts and mint identity assets.
   v
<pool identity policy> --> pool NFT
<LP policy>            --> LP-token policy
<inventory policy>     --> inventory-receipt policy
   |
   | 2. Lock the initial quote reserve and pool NFT.
   v
{quote_pool}
  (authenticated pool UTxO)
  value: quote-asset reserve + pool NFT
  datum: admin, batcher, LP token, inventory token, quote asset,
         total LP supply, min cash reserve, paused, inventory value
   |
   +------------------------------------+
   |                                    |
   v                                    v
[LP wallet]                         [Team / Reserves pages]
Add quote reserve                   read current pool state
   |                                    |
   v                                    |
<LP policy> -- mint proportional LP tokens --> [LP wallet]
~~~

ADA is stored on Cardano in lovelace but displayed in the application as ADA. For example, 120,000,000 lovelace is 120 ADA. With a 20,000,000-lovelace protected reserve, 20 ADA is protected and 100 ADA is initially available for bids.

LP removal burns LP tokens and only withdraws quote liquidity above the protected reserve. The application intentionally disables liquidity changes while the pool has open inventory.

## 5. Price and settle an Instant Sell request

~~~text
[Approved-asset seller]
   |
   | 1. Marketplace > Instant sell to pool.
   |    Set a minimum acceptable payout in the pool quote asset.
   v
{pool_sell_request}
  value: seller RWA + ADA buffer
  datum: pool identity, exact RWA, quantity, quote asset, minimum payout
   |
   | Seller may cancel before acceptance.
   v
[Authorized batcher / Team wallet]
   |
   | ==> Check registry admission, exact unit, current UTxOs,
   |     seller minimum, valuation, bid, resale ask, inventory risk,
   |     and post-settlement protected reserve.
   |
   | 2. One transaction consumes request + pool UTxO.
   +---------------------------+------------------------------+-------------------------------+
   |                           |                              |                               |
   v                           v                              v                               v
[Seller receives bid       {quote_pool continues}      <inventory policy>          {simple_orderbook}
 + returned ADA buffer]    reduced by settlement       mints inventory receipt     pool-owned RWA listing
                            inventory value += ask                                 at the selected ask
~~~

The seller chooses a floor, not a final sale price. The batcher chooses the bid and resale ask. Record the valuation source, approval, request out-reference, bid, ask, and resulting transaction hash.

### Reserve-protection boundary

The Team UI refuses a settlement that would take the configured ADA pool below min_cash_reserve. The existing quote-pool validator does not enforce that post-settlement floor for the batcher-acquire/Instant Sell path. This is therefore an operational guard, not sufficient on-chain protection. Do not use custom batcher transactions to bypass it. On-chain price bands and reserve-floor enforcement require an upgraded validator and a deliberate replacement-pool deployment.

## 6. Buy pool-owned inventory

~~~text
[Buyer wallet]
   |
   | 1. Select a pool-owned listing in Marketplace.
   | 2. Pay its declared ask in the quote asset.
   v
{simple_orderbook} + inventory receipt
   |
   | 3. Purchase consumes the listing and burns the receipt.
   +--------------------------+----------------------------+----------------------+
   |                          |                            |                      |
   v                          v                            v                      v
[Buyer receives RWA]    {quote_pool continues}    <inventory policy>       inventory value falls
                         receives quote payment    burns receipt
~~~

The inventory receipt binds a pool-owned listing to its settlement path. A direct listing cannot be treated as pool inventory merely because it has the same asset name.

## 7. Direct listing and direct purchase

~~~text
[Seller wallet]
   |
   | 1. Marketplace > List at my price.
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
| LP | LP wallet and LP policy | Add reserves, hold/burn LP shares | Remove liquidity while inventory is open |
| DEX Team creator | Configured `factory_state` admin wallet | Review and co-sign an FT bootstrap acceptance | Substitute the FT provider or liquidity provider role |
| Batcher | Authorized batcher wallet | Set bid/ask and settle approved Instant Sell | Bypass registry/risk/reserve controls |
| Buyer | Buyer wallet | Buy direct or pool-owned inventory | Sign a transaction built from stale UTxOs |

## Read before signing

Refresh immediately before signing. A state-changing action consumes a specific UTxO, so another confirmed transaction makes the old input stale. Confirm the exact asset unit, script address, inline datum, signer role, quote amount, returned ADA buffer, and final transaction hash.
