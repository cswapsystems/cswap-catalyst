# Cardano Asset Fractionalization Platform — Technical Specification

| | |
|---|---|
| **Document** | Platform Technical Specification |
| **Version** | 0.1 (Draft — for review) |
| **Status** | Open decisions outstanding (see §3) |
| **Target chain** | Cardano, Plutus V3 |
| **Audience** | Engineering, security review, external audit |

---

## 1. Scope

This document specifies a platform providing five capabilities:

| # | Capability | Component |
|---|---|---|
| 1 | Mint tokens on Cardano | Minting Service (§5) |
| 2 | Fractionalize a token | Vault (§6) |
| 3 | Recombine fractions into the original token | Vault (§6, §7) |
| 4 | Buy and sell whole tokens | Marketplace (§8) |
| 5 | Trade fractions | DEX (§9) |

### 1.1 Out of scope for v1

- Cross-chain bridging of assets or fractions.
- Fiat on/off ramps.
- Lending or collateralization against fractions.
- Governance token and protocol DAO.
- Mobile-native applications (responsive web only).

### 1.2 Design principles

1. **Trust-minimized custody.** No platform-controlled key may unilaterally move a user's asset or funds. The vault is the only custodian, and it is a script.
2. **Fractions are ordinary native assets.** No transfer hooks, no allowlists by default. This makes them composable with every wallet and DEX on Cardano at zero integration cost. (Constrained by decision **D5**.)
3. **Deterministic derivation.** Given an original asset, any third party must be able to compute its fraction policy ID and vault address offline, without querying platform infrastructure.
4. **No liveness dependency for user exit.** Users must be able to redeem, cancel listings, and withdraw liquidity even if all platform-operated off-chain services are permanently offline.
5. **Immutable validators.** Deployed scripts are never upgraded in place. New versions deploy alongside; migration is opt-in per user. See §13.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Original Asset** | The indivisible native asset (quantity 1) that is locked to create fractions. |
| **Vault** | A script UTxO holding exactly one Original Asset plus its state datum. |
| **Fraction Token (FT)** | The fungible native asset representing partial claim on a Vault. |
| **Total Supply (S)** | The fixed integer quantity of FT minted for a Vault. |
| **Curator** | The party who created a Vault. Holds limited configuration rights only. |
| **Buyout** | The forced-exit auction mechanism allowing an Original Asset to leave a Vault without 100% of FT being assembled (§7). |
| **Batcher** | Off-chain agent that aggregates DEX orders into a single pool-touching transaction (§9.4). |
| **Index Vault** | A Vault holding multiple Original Assets which all mint the *same* FT (per decision **D1**). |

---

## 3. Open Decisions Requiring Sign-Off

These are architectural forks. Each has a recommended default so implementation can begin, but each must be confirmed before the corresponding validator is frozen for audit.

### D1 — Vault topology: per-asset, index, or hybrid

| Option | Liquidity outcome | Complexity |
|---|---|---|
| **Per-asset** — one Vault, one FT per Original Asset | Poor. One shallow pool per asset; N assets means N illiquid pairs. | Low |
| **Index** — many similar assets in one Vault, one shared FT | Strong. One deep pool per collection. Holders lose their link to a specific asset; redemption becomes random or premium-priced. | High |
| **Hybrid** — per-asset for high-value assets, index for commoditized inventory | Best, but two user mental models to explain. | Medium |

**Recommendation:** Build the Vault validator with a `topology` discriminant in the datum (§6.2) so both are supported by one audited codebase. Launch with per-asset only; enable index vaults in v1.1 once trading volume justifies it.

**Blocking dependency:** §9 (DEX) pool seeding strategy differs materially between the two.

### D2 — Forced exit mechanism

If FT disperses to thousands of holders, assembling 100% of supply becomes practically impossible and the Original Asset is locked forever. A forced exit path is mandatory, not optional.

| Option | Description | Risk |
|---|---|---|
| **Buyout auction** | Anyone bids above reserve; timed auction; winner takes asset, FT holders claim pro-rata proceeds. | Bidder can win below fair value in a thin market. |
| **Supermajority threshold** | Holders of ≥ *T*% (e.g. 95%) trigger redemption; remainder's share escrowed permanently claimable. | Whale holding *T*% can force exit against minority. |
| **Curator reserve, holder-adjustable** | Curator sets reserve at mint; FT holders vote to change it. | Voting requires on-chain tallying infrastructure. |

**Recommendation:** Buyout auction (§7) with a curator-set initial reserve and a hard minimum reserve floor that cannot be lowered. Simplest to reason about, no vote-tallying validator required for v1.

### D3 — Build the DEX, or route to an existing one

Fraction tokens are plain native assets. They can trade on Minswap, SundaeSwap, or WingRiders **today**, with existing liquidity, existing batcher infrastructure, and existing audits.

| Option | Cost | Justification required |
|---|---|---|
| **Route to existing DEX** — ship a "create pool" flow that deploys to a third-party DEX, embed their widget | Weeks | Default choice. |
| **Build own DEX** (§9) | Months, plus batcher ops and a fresh audit of the highest-risk component in the system | Only if NAV-aware pricing, index-vault-specific mechanics, or bonding-curve launches are core to the product thesis. |

**Recommendation:** Route to an existing DEX for v1. Specify our own DEX (§9) as v2, gated on demonstrated volume. §9 is written as a full specification so the option stays open, but it should not be built first.

### D4 — Royalty enforcement

Enforce CIP-27 royalties on-chain in the Marketplace validator, or honour them off-chain as the broader market does?

**Recommendation:** Enforce on-chain for assets minted through our own Minting Service (where we control the policy); honour-but-don't-enforce for externally minted assets, matching prevailing market behaviour. Document the asymmetry prominently in the UI.

### D5 — Transfer restrictions and compliance posture

Fractionalized ownership of a real-world asset is a security in most jurisdictions, and fractionalized art frequently is as well. This affects whether the DEX requires KYC gating, whether US users can be served, and whether the Vault needs a transfer-restriction hook.

Retrofitting permissioned transfers into a plain-native-token design is expensive and breaks principle 2. **A legal opinion on the target asset class is required before the FT policy is frozen.** If restrictions are needed, the likely mechanism is a *stake-credential allowlist* checked at the Vault and DEX boundary rather than on every transfer — enforcement at the venue, not at the token.

**Note:** This is not legal advice. It varies substantially by jurisdiction and asset class and requires a qualified opinion.

---

## 4. System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Web client (CIP-30 / CIP-45 wallet connection)              │
└───────────────┬──────────────────────────────┬───────────────┘
                │ read                         │ build & submit
                ▼                              ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│  API + Indexer projection     │   │  Tx Builder (client-side)│
│  (Kupo + Ogmios, Postgres)    │   │  no custody of keys      │
└───────────────┬───────────────┘   └──────────┬───────────────┘
                │                              │
                │           ┌──────────────────┴───┐
                │           │  Batcher (DEX only)  │
                │           │  §9.4 — optional/D3  │
                │           └──────────────────┬───┘
                ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│  Cardano L1                                                  │
│  ┌────────────┐ ┌──────────┐ ┌─────────────┐ ┌────────────┐ │
│  │ Mint Policy│ │  Vault   │ │ Marketplace │ │  DEX Pool  │ │
│  │   §5       │ │ §6 / §7  │ │     §8      │ │    §9      │ │
│  └────────────┘ └──────────┘ └─────────────┘ └────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Ledger primitives used

| CIP | Use |
|---|---|
| **CIP-25** | Metadata for externally compatible NFTs. |
| **CIP-27** | Royalty token (asset label 777). Subject to **D4**. |
| **CIP-30 / CIP-45** | Wallet connection (browser extension / mobile peer-connect). |
| **CIP-31** | Reference inputs — read Vault state without spending it. |
| **CIP-32** | Inline datums — Vault and listing state readable without datum resolution. |
| **CIP-33** | Reference scripts — validators stored once on-chain, referenced by every transaction. Essential given transaction size limits. |
| **CIP-67** | Asset name label prefixes. |
| **CIP-68** | Datum metadata standard. Reference NFT `(100)`, user token `(222)` NFT / `(444)` RFT. |

Label hex encodings (`(100)` → `000643b0`, `(222)` → `000de140`, `(333)` → `0014df10`, `(444)` → `001bc280`) must be verified against CIP-67 at implementation time rather than trusted from this document.

### 4.2 Protocol parameter constraints

| Constraint | Current value | Consequence |
|---|---|---|
| Max transaction size | 16,384 bytes | All validators must be attached as reference scripts (CIP-33). Inlining two or more validators will exceed this. |
| Max tx execution memory | 14,000,000 units | Limits validators per transaction. Buyout settlement (§7.4) is the tightest case and must be budgeted explicitly. |
| Max tx execution steps | 10,000,000,000 units | As above. |
| `coinsPerUTxOByte` | 4,310 lovelace | Every UTxO carries ~1–2 ADA minimum. See §11.1. |
| Max value size | 5,000 bytes | Caps assets per Index Vault UTxO. See §6.5. |

These are consensus parameters and may change. Validators must not hardcode them; the client must read current values from the node at build time.

---

## 5. Component: Minting Service

### 5.1 Requirements

- **MINT-1** Supply of an Original Asset MUST be provably 1, verifiable from the policy script alone without reference to off-chain history.
- **MINT-2** Metadata MUST be updatable by the Curator if and only if the asset is configured as mutable at mint time.
- **MINT-3** The service MUST support minting collections in batches without one failure invalidating the batch.

### 5.2 One-shot policy

Supply-of-1 is guaranteed by parameterizing the minting policy on a specific UTxO reference and requiring that UTxO be spent in the minting transaction. Since a UTxO can be spent exactly once, the policy can never mint again.

```aiken
validator one_shot(utxo_ref: OutputReference, asset_name: ByteArray) {
  mint(_redeemer: Void, policy_id: PolicyId, self: Transaction) {
    let minted = assets.tokens(self.mint, policy_id) |> dict.to_pairs()
    and {
      // the parameterized UTxO must be consumed
      list.any(self.inputs, fn(i) { i.output_reference == utxo_ref }),
      // exactly the reference NFT and the user NFT, quantity 1 each
      minted == [
        Pair(cip68.prefix_100(asset_name), 1),
        Pair(cip68.prefix_222(asset_name), 1),
      ],
    }
  }
}
```

Burning is handled by a separate redeemer branch permitting negative quantities with no other constraints.

### 5.3 CIP-68 structure

Two tokens are minted per Original Asset:

- **`(100)` Reference NFT** — sent to a metadata-holding script address with the metadata as an inline datum. Spendable only by the Curator, and only if the asset was declared mutable.
- **`(222)` User NFT** — sent to the Curator's wallet. This is the tradable Original Asset.

The metadata datum follows the CIP-68 shape:

```
datum = {
  metadata: Map<ByteArray, Data>,   // name, image, description, ...
  version: 1,
  extra: PlatformExtra,             // our fields: asset_class, curator, valuation_ref
}
```

`extra` is where platform-specific fields live. CIP-68 reserves it for exactly this, so we get custom fields without breaking third-party metadata parsers.

### 5.4 Immutability flag

If an asset is minted immutable, the `(100)` Reference NFT is sent to an always-fails script address rather than the metadata script. This makes immutability provable on-chain rather than a platform promise.

---

## 6. Component: Vault (Fractionalize & Recombine)

### 6.1 Requirements

- **VLT-1** A Vault MUST hold its Original Asset(s) such that no key, including the Curator's, can withdraw them except via `Redeem` (§6.6) or `Buyout` (§7).
- **VLT-2** The FT policy ID MUST be deterministically derivable from the Original Asset identifier.
- **VLT-3** Total Supply MUST be fixed at fractionalization and MUST NOT be mintable thereafter.
- **VLT-4** `Redeem` MUST require burning exactly Total Supply of FT.
- **VLT-5** The Vault MUST be spendable by any party satisfying the validator, with no dependency on platform infrastructure.

### 6.2 Vault datum

```aiken
type VaultTopology {
  PerAsset { asset: AssetId }
  Index { collection_policy: PolicyId, count: Int }
}

type BuyoutState {
  Inactive
  Active { leader: Address, bid: Int, deadline: PosixTime, epoch: Int }
  Settled { payout_per_fraction: Int }
}

type VaultDatum {
  topology: VaultTopology,
  fraction_policy: PolicyId,
  fraction_name: AssetName,
  total_supply: Int,
  decimals: Int,
  curator: Address,
  reserve_price: Int,        // lovelace, floor for a valid opening bid
  reserve_floor: Int,        // immutable; reserve_price may never go below this
  buyout: BuyoutState,
}
```

`decimals` is essential. On-chain quantities are integers only; the decimal point is a metadata convention. Without it, a supply of 1,000,000 displays as 1,000,000 rather than 1.000000 in every wallet.

### 6.3 Deterministic derivation (VLT-2)

The Vault validator is parameterized on the Original Asset. The FT asset name is derived:

```
fraction_name = (444) ++ blake2b_224(orig_policy_id ++ orig_asset_name)
```

`blake2b_224` yields 28 bytes; with the 4-byte CIP-67 label this gives 32 bytes, exactly the maximum asset name length. Anyone can compute which fractions belong to which asset with no indexer.

Because the Vault validator is parameterized, each Vault gets a distinct script address and each FT a distinct policy ID, while all Vaults share one audited script body.

### 6.4 Redeemers

| Redeemer | Effect | Guard |
|---|---|---|
| `Fractionalize` | Lock Original Asset, mint `total_supply` FT | Original Asset present in Vault output; mint quantity == `total_supply`; `buyout == Inactive` |
| `Redeem` | Burn full supply, release Original Asset | Mint quantity == `-total_supply`; `buyout == Inactive`; Vault UTxO fully consumed |
| `SetReserve` | Adjust `reserve_price` | Signed by `curator`; new value ≥ `reserve_floor`; `buyout == Inactive` |
| `StartBuyout` | Open auction | §7.2 |
| `Outbid` | Replace leader | §7.3 |
| `SettleBuyout` | Release asset to winner | §7.4 |
| `ClaimProceeds` | FT holder claims pro-rata | §7.5 |

### 6.5 Index Vault value-size limit

An Index Vault holding many Original Assets in one UTxO will approach the 5,000-byte max value size. Each distinct asset costs roughly 40–70 bytes of value representation, capping a single Index Vault UTxO at low hundreds of assets.

Mitigation: shard an Index Vault across multiple UTxOs sharing the same FT policy, with the datum recording `shard_index` and `shard_count`. Deposits target the least-full shard. Random redemption selects a shard first, then an asset within it. This is deferred to v1.1 alongside **D1**.

### 6.6 Fractionalization flow

```
Inputs:  Curator UTxO holding Original Asset + collateral
         (reference input: Vault reference script)
Mint:    +total_supply  FT
Outputs: Vault script UTxO  { Original Asset, min-ADA }  inline VaultDatum
         Curator UTxO       { total_supply FT - pool_seed }
         [DEX pool UTxO     { pool_seed FT, seed_ADA }]   // §9.5, optional
```

The optional pool seed in the same transaction is the single most effective mitigation for the cold-start liquidity problem — a new Vault should not be born with a zero-liquidity market.

### 6.7 Recombination flow

```
Inputs:  Vault script UTxO (redeemer: Redeem)
         User UTxO holding exactly total_supply FT
Mint:    -total_supply  FT
Outputs: User UTxO { Original Asset, returned min-ADA }
```

The validator MUST verify the mint field shows exactly `-total_supply`, not merely "at least". A permissive check allows partial burns that permanently desynchronize supply from the datum.

---

## 7. Component: Buyout (Forced Exit)

Per **D2**. This section assumes the auction mechanism.

### 7.1 Rationale

Without this, a single lost wallet holding one FT locks an Original Asset forever. Every fractionalization platform that omitted a forced exit has accumulated permanently stranded assets.

### 7.2 `StartBuyout`

- Bid MUST be ≥ `reserve_price`.
- Bidder's lovelace is deposited into the Vault UTxO.
- Sets `buyout = Active { leader, bid, deadline = now + AUCTION_WINDOW, epoch }`.
- MUST reject if `buyout` is already `Active` or `Settled`.
- `AUCTION_WINDOW`: **72 hours** (proposed — long enough for holders to organize a counter-bid, short enough to be a usable exit).

### 7.3 `Outbid`

- New bid MUST be ≥ `leader_bid * (100 + MIN_INCREMENT_PCT) / 100`. Proposed `MIN_INCREMENT_PCT = 5`.
- Previous leader's deposit MUST be returned in full in the same transaction, to an output paying `leader`.
- `deadline` extends to `now + ANTI_SNIPE_WINDOW` if less than that remains. Proposed `ANTI_SNIPE_WINDOW = 6 hours`.
- `epoch` increments — this is a **replay guard**; a stale `Outbid` transaction built against an earlier state must not validate.

**Anti-griefing:** if the previous leader's address is a script that always fails, the refund cannot be paid and the auction deadlocks. The Vault MUST therefore restrict `leader` to a public-key-hash-only address (no script credential) at `StartBuyout`.

### 7.4 `SettleBuyout`

Valid only when `now > deadline`.

```
Inputs:  Vault UTxO (Active)
Outputs: Winner UTxO { Original Asset }
         Proceeds UTxO { bid lovelace }  inline ProceedsDatum
```

`SettleBuyout` MUST be callable by **anyone**, not only the winner. If only the winner can settle, a winner who loses interest deadlocks the Vault.

### 7.5 `ClaimProceeds`

The Proceeds UTxO is long-lived and separate from the Vault by design. FT holders burn FT and withdraw `bid * held / total_supply` lovelace. Unclaimed shares never block anything, because the Vault UTxO is already gone.

```aiken
type ProceedsDatum {
  fraction_policy: PolicyId,
  fraction_name: AssetName,
  total_supply: Int,
  remaining_lovelace: Int,
  remaining_supply: Int,
}
```

Partial claims produce a continuing Proceeds UTxO with decremented fields. Integer division MUST round **down** in the holder's payout, with the remainder staying in the UTxO — rounding up allows the final claimant to be under-paid, or worse, drains min-ADA and makes the UTxO unspendable.

---

## 8. Component: Marketplace (Whole Tokens)

### 8.1 Requirements

- **MKT-1** A seller MUST be able to cancel a listing unilaterally at any time.
- **MKT-2** A listing MUST NOT be fillable at a price below the datum price.
- **MKT-3** Listings MUST be resistant to the double-satisfaction attack (§8.5).
- **MKT-4** Listing datums SHOULD be structurally compatible with major Cardano marketplaces so platform assets are discoverable outside our storefront.

### 8.2 Listing datum

```aiken
type ListingDatum {
  seller: Address,
  asset: AssetId,
  price: Int,                  // lovelace
  payouts: List<Payout>,       // seller, royalty, protocol fee
  created_at: PosixTime,
  nonce: OutputReference,      // uniqueness tag, see §8.5
}

type Payout { address: Address, amount: Int }
```

Encoding payouts as an explicit list rather than computing fees inside the validator keeps the validator simple and makes royalty and fee routing auditable from the datum alone.

### 8.3 Redeemers

| Redeemer | Guard |
|---|---|
| `Buy` | Every `Payout` satisfied by a corresponding transaction output; asset paid to buyer; exactly one marketplace input |
| `Cancel` | Signed by `seller` |
| `AcceptOffer` | Signed by `seller`; matching Offer UTxO consumed in same tx |

### 8.4 Offers

An Offer is the mirror image: a buyer locks lovelace at the marketplace script with a datum naming the desired asset. Collection-level offers (any asset under a given policy) are supported by making `asset` an `Either<AssetId, PolicyId>`.

### 8.5 Double satisfaction

**This is the canonical Cardano marketplace vulnerability.** Two listings for 100 ADA each are consumed in one transaction with a single 100-ADA output to a seller who happens to be the same party; both validators see a satisfying output and both pass. The attacker takes two assets for one payment.

Mandatory mitigations, applied together:

1. **Single-input rule.** The validator counts inputs at its own script address and fails if the count exceeds 1. Cheap, effective, and rules out batched purchases as a side effect.
2. **Output tagging.** Each payout output carries an inline datum containing the listing's `nonce` (the consumed UTxO's `OutputReference`, which is globally unique). The validator requires the tag to match. This permits safe batching, at the cost of a slightly larger transaction.

Implement (2), and assert (1) as a defense-in-depth check in the same validator. The same class of attack applies to `ClaimProceeds` (§7.5) and DEX order execution (§9.3); apply the same tagging discipline there.

### 8.6 Interoperability (MKT-4)

Publishing listings in a format that existing storefronts index means platform assets are visible in the largest venue on day one. That distribution is worth more in the early phase than fee capture from an exclusive storefront. Confirm the current listing datum shape against each target marketplace's published standard before freezing `ListingDatum`.

---

## 9. Component: DEX for Fractions

**Gated on D3.** Specified fully so the option remains open; recommended for v2, not v1.

### 9.1 The eUTxO contention problem

A liquidity pool is a single UTxO. Two users swapping against it in the same block both reference the same input; one transaction fails. A naive AMM on Cardano is unusable at any real volume.

### 9.2 Order-then-batch architecture

Every production Cardano DEX solves this the same way:

1. The user submits an **order** — an intent UTxO at an order script address, holding their input assets and a datum with their terms.
2. An off-chain **batcher** collects pending orders.
3. The batcher builds **one** transaction consuming the pool UTxO plus *n* orders, folding all of them into a single pool state transition.

The pool is touched once per block by one agent. Contention disappears. Users get eventual rather than atomic execution, and the UI must communicate that honestly ("order submitted", not "swapped").

### 9.3 Order datum

```aiken
type OrderStep {
  Swap { offered: AssetId, min_received: Int }
  Deposit { min_lp: Int }
  Withdraw { min_a: Int, min_b: Int }
}

type OrderDatum {
  owner: Address,             // refund and receive address
  step: OrderStep,
  batcher_fee: Int,
  output_min_ada: Int,
  nonce: OutputReference,     // output tagging, per §8.5
}
```

Two redeemers:

- `Execute` — requires a valid pool input in the same transaction and an output to `owner` satisfying the step's minimum. The order validator does **not** recompute AMM math; it checks only the user's slippage bound. The pool validator owns the invariant.
- `Cancel` — signed by `owner`. Available at any time, with no batcher involvement. This satisfies design principle 5: if every batcher disappears, funds are still recoverable.

### 9.4 Batcher and decentralization

| Model | Trade-off |
|---|---|
| **Single operated batcher** | Simple; a liveness single point of failure; extractable MEV concentrated in one party. |
| **Licensed batchers** | Batcher must present a license NFT. Controlled set, known parties, still permissioned. |
| **Permissionless** | Anyone may batch. Censorship-resistant, but open front-running and reordering. |

**Recommendation:** launch licensed, with the pool validator enforcing only that *some* valid license NFT is present. This lets the licensed set expand toward permissionless without a validator change. Order execution MUST be constrained to first-come-first-served by `nonce` ordering where feasible, to limit reordering MEV.

### 9.5 Pool and pricing

Constant-product AMM (`x * y = k`) for the general case. Pool UTxO holds both reserves plus an inline datum with the LP token policy, fee basis points, and total LP issuance.

Fee split, proposed: **30 bps total** — 25 to LPs, 3 to protocol, 2 to batcher, plus a flat batcher fee in lovelace to cover transaction costs.

Cold start is the acute risk. Two mitigations, both recommended:

- **Seed at fractionalization** (§6.6). The Curator contributes ADA and a slice of supply directly into a pool in the fractionalization transaction, so no Vault launches with a zero-liquidity market.
- **NAV reference.** Because the whole-token Marketplace (§8) produces real sale prices for comparable assets, the UI can display an implied net asset value alongside the DEX price. See §10.3.

---

## 10. Off-Chain Services

### 10.1 Indexer

None of the state above is queryable from a node. Required from day one:

- **Chain sync:** Kupo + Ogmios against an owned node, or a managed provider (Maestro, Blockfrost) for the first phase.
- **Projection store:** Postgres tables for vaults, listings, offers, orders, pools, and proceeds.
- **Rollback handling:** Cardano rolls back. Every projection MUST be keyed by slot and support rewind. This is the single most common source of production bugs in Cardano applications and is frequently underestimated.

Budget realistically: indexing and projection is usually **more** engineering effort than the validators.

### 10.2 Transaction builder

Runs client-side. The platform never holds user keys. Builds transactions, attaches reference scripts, computes exact redeemers, and hands the unsigned transaction to the wallet via CIP-30. Protocol parameters are read live, never hardcoded.

### 10.3 Valuation and spread surfacing

The platform holds two independent price signals for the same underlying asset:

- **Implied NAV** = FT price on the DEX × `total_supply`
- **Observed price** = comparable whole-asset sales on the Marketplace

Surfacing the spread between them is a genuinely differentiated product feature, not just a chart. It creates a visible arbitrage incentive — buy fractions and redeem when the implied NAV trades below observed price, fractionalize and sell when above — which keeps the two markets mutually honest. This deserves first-class placement in the UI rather than being buried in an analytics tab.

---

## 11. Economics

### 11.1 Min-ADA accounting

Every UTxO locks roughly 1–2 ADA. This is not a fee; it is refundable when the UTxO is consumed. But it must be surfaced clearly:

| UTxO | Who funds it | Recovered when |
|---|---|---|
| Vault | Curator at fractionalization | Redeem or buyout settlement |
| Metadata `(100)` | Curator at mint | Never (immutable assets) |
| Listing | Seller | Buy or cancel |
| Order | Trader | Execution or cancel |
| Proceeds | Buyout winner | Last claim |

Users holding fractions across many Vaults accumulate meaningful ADA dust across many small UTxOs. The wallet view SHOULD show recoverable min-ADA as a distinct figure so this does not read as lost funds.

### 11.2 Supply selection

Choose Total Supply as a power of ten paired with a matching CIP-68 `decimals` value. Arbitrary supplies (e.g. 777,777) produce permanently ugly rounding in every UI and every integer-division payout. Proposed default: **`total_supply = 1_000_000`, `decimals = 6`**, presenting as 1.000000 whole units.

### 11.3 Protocol fees

| Action | Proposed fee |
|---|---|
| Mint | Flat lovelace, covers indexing cost |
| Fractionalize | Flat lovelace |
| Redeem | Zero — never tax the exit path |
| Marketplace sale | Basis points on sale price |
| DEX swap | 3 bps of the 30 bps total (§9.5) |

Exit paths (`Redeem`, `Cancel`, `ClaimProceeds`) should carry no protocol fee. A fee on exit is a reputational liability far exceeding its revenue.

---

## 12. Security Considerations

| # | Risk | Mitigation | Section |
|---|---|---|---|
| S1 | Double satisfaction across listings, orders, or proceeds claims | Output tagging by `nonce` + single-script-input assertion | §8.5 |
| S2 | Permanent asset lock (100% of FT unobtainable) | Buyout auction | §7 |
| S3 | Buyout refund griefing via failing script address | Restrict `leader` to PKH-only addresses | §7.3 |
| S4 | Buyout deadlock if winner abandons settlement | `SettleBuyout` callable by anyone | §7.4 |
| S5 | Stale-state replay on `Outbid` | `epoch` counter in datum | §7.3 |
| S6 | Partial FT burn desynchronizing supply from datum | Exact-equality mint check, never "at least" | §6.7 |
| S7 | Unauthorized FT inflation | FT policy is the parameterized Vault script; mint permitted only in the `Fractionalize` branch | §6.3 |
| S8 | Rounding drain of Proceeds min-ADA | Round payouts down; remainder stays in UTxO | §7.5 |
| S9 | Datum hijacking (attacker supplies a forged Vault datum) | Validator authenticates state via the token it holds, not the datum alone | §6 |
| S10 | Batcher censorship or MEV extraction | Licensed set with expansion path; user-side `Cancel` always available | §9.4 |
| S11 | Indexer rollback corrupting displayed state | Slot-keyed projections with rewind support | §10.1 |
| S12 | Unregistered securities offering | Legal opinion before FT policy is frozen | **D5** |

S1, S2, and S7 are the three that have historically caused real losses on comparable platforms. They warrant dedicated audit attention and property-based test coverage rather than example-based tests alone.

---

## 13. Versioning and Upgrades

Validators are immutable once deployed. Upgrades follow a parallel-deployment model:

1. New validator versions deploy to new addresses.
2. A **registry** (an on-chain UTxO or a signed off-chain manifest) maps version identifiers to script hashes and addresses.
3. Migration is **opt-in per user**: redeem from v1, fractionalize into v2. The platform MUST NOT be able to migrate a user's position without their signature.
4. v1 remains indexed and functional indefinitely. Support is never withdrawn from a deployed version, because users cannot be compelled to migrate.

This implies indexer support for every version ever deployed. Keep the number of versions low.

---

## 14. Testing and Assurance

| Layer | Approach |
|---|---|
| Validator unit | Aiken test suite covering every redeemer branch, including every failure path |
| Property-based | Supply conservation (Σ FT + burned == `total_supply` always); payout conservation across partial claims; AMM invariant monotonicity |
| Adversarial | Explicit test for each row in §12, written as an attack that must fail |
| Integration | Full flows on a private devnet, then preprod |
| Load | Batcher throughput at target orders/block; indexer under rollback storms |
| External audit | Mandatory before mainnet. Vault (§6/§7) and DEX pool (§9.5) are the highest-value targets. |

Test coverage of failure paths matters more than coverage of success paths. A validator that accepts valid transactions is table stakes; a validator that rejects every invalid one is the actual product.

---

## 15. Proposed Phasing

| Phase | Contents | Rationale |
|---|---|---|
| **P0** | Minting Service (§5), indexer foundation (§10.1) | Lowest risk, establishes infrastructure, independently useful |
| **P1** | Marketplace (§8) | Standard, well-understood patterns; revenue from day one |
| **P2** | Vault: fractionalize + recombine (§6) | Core differentiator |
| **P3** | Buyout (§7) | MUST ship with or before P2 reaches meaningful volume — see S2 |
| **P4** | Route fractions to an existing DEX (**D3**) | Trading capability at a fraction of the cost of building |
| **P5** | NAV/spread surfacing (§10.3) | Differentiated feature, no new on-chain risk |
| **P6** | Own DEX (§9) — conditional | Only on demonstrated volume |
| **P7** | Index vaults (§6.5, **D1**) — conditional | Only if per-asset liquidity proves inadequate |

P3 is not optional and must not be deferred past P2's growth. Shipping fractionalization without a forced exit path creates permanently stranded assets and an unfixable support burden.

---

## Appendix A — Decision Register

| ID | Decision | Recommendation | Owner | Status |
|---|---|---|---|---|
| D1 | Vault topology | Datum-discriminated; launch per-asset | Product | Open |
| D2 | Forced exit mechanism | Buyout auction | Product / Legal | Open |
| D3 | Build vs. route DEX | Route in v1 | Engineering / Product | Open |
| D4 | Royalty enforcement | Enforce on own policies only | Product | Open |
| D5 | Transfer restrictions | Legal opinion required before FT policy freeze | Legal | **Blocking** |

## Appendix B — Open Parameters

| Parameter | Proposed | Section |
|---|---|---|
| `AUCTION_WINDOW` | 72 hours | §7.2 |
| `ANTI_SNIPE_WINDOW` | 6 hours | §7.3 |
| `MIN_INCREMENT_PCT` | 5 | §7.3 |
| `total_supply` default | 1,000,000 | §11.2 |
| `decimals` default | 6 | §11.2 |
| DEX total fee | 30 bps | §9.5 |
| Marketplace fee | TBD bps | §11.3 |
| Supermajority threshold *T* | N/A unless D2 changes | §3 |
