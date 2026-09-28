# Asset registry architecture — current implementation

The current Preprod registry is a **single issuer-managed, authenticated UTxO** containing an approved list of exact Cardano asset IDs. A separate request validator holds refundable, permissionless proposals until the issuer approves or rejects them, or the requester cancels. This is the implemented design. See [Basic on-chain asset registry](ASSET_REGISTRY.md) for operating details, [Validator inventory](VALIDATOR_INVENTORY.md) for active sources, and [Future sharded registry plan](FUTURE_SHARDED_REGISTRY.md) for a possible scaling path.

## Boundary and authority

```text
requester ──► asset_registry_request UTxO ──► issuer approval + refund
                  │ cancel or reject ─────────► requester refund
                  ▼ approval consumes both request and registry
issuer ─────► asset_registry UTxO (identity NFT + inline version/list datum)
public UI ◄── authenticated registry read

Marketplace shared pool ── its own on-chain prices, NOT registry membership
DEX pools ──────────────── AMM reserves, NOT registry membership
```

The registry records issuer approval of an exact `(policy_id, asset_name)` pair. It does **not** prove ownership, asset quality, legal compliance, or supported mint provenance on-chain. Approval does not create a shared-pool price, authorize Instant Sell settlement, or gate direct Marketplace listings. Current `shared_reserve_pool` and `marketplace_listing_escrow` validators do not require a registry reference input; settlement uses posted on-chain pool prices. DEX pricing follows pool reserves. There is no current per-asset buy/sell flag, policy-wide approval, quantity cap, or off-chain operator price book.

## State and deployment identity

The active `asset_registry` Plutus V3 validator is parameterized by the registry identity asset and issuer payment verification-key hash. One state UTxO at its derived script address holds exactly one identity NFT and an inline datum:

```aiken
RegistryDatum {
  version: Int,
  entries: List<AssetClass>, // exact policy ID and asset name pairs
}
```

The one-shot identity policy consumes a deployment seed UTxO to mint the singleton NFT. The initialization builder places it in an empty version-0 registry UTxO. The identity token and issuer are public deployment configuration, recorded for Preprod in `marketplace-deployment.preprod.json`. The client rebuilds the script from the current blueprint and those parameters, locates the token, then checks the expected address, singleton quantity, and inline datum. An arbitrary output at the same address or a same-named token is not sufficient. The current request-enabled registry was reused in the [2026-09-25 Preprod deployment](PREPROD_REDEPLOYMENT_2026-09-25.md); creating another registry is **not** a routine setup step.

Each entry has a 28-byte policy ID and an asset name of at most 32 bytes. The list permits at most 50 distinct exact assets. Entries are not sorted by a protocol requirement: new approvals are prepended, and the validator checks uniqueness and the exact transition. A policy ID alone does not approve every token under that policy; an original NFT's approval does not approve its fraction token.

## Issuer-controlled transitions

Every update spends the current registry UTxO and recreates exactly one continuing UTxO with the same identity NFT at the same address. The validator requires the configured issuer signature, no transaction mint/burn, unchanged non-ADA value, no decrease in locked ADA, valid old/new lists, and an exact one-step version increment. It accepts only these redeemers:

| Action | Required list change |
| --- | --- |
| `Register(asset)` | Prepend one valid asset not already present. |
| `RegisterMany(assets)` | Prepend a nonempty, unique batch whose assets are not already present. |
| `Revoke(asset)` | Remove one currently present asset. |

There is no close action, issuer rotation, automatic expiry, or on-chain price update in this validator. The one state UTxO serializes changes: after a competing update confirms, a transaction built from the old UTxO must be rebuilt. Locked ADA may need a top-up as the datum grows. Revocation changes the registry record only; it does not burn or move an asset or cancel existing Marketplace positions.

## Permissionless request escrow

`asset_registry_request` is a separate Plutus V3 spending validator parameterized by the registry address, identity token, and issuer key. A request UTxO contains ADA only and an inline datum with the requester address, requester payment-key hash, and a nonempty list of up to 50 unique exact asset IDs. The validator requires at least 2 tADA locked; the current browser UI deposits 3 tADA.

| Request action | Signer and enforced outcome |
| --- | --- |
| `Approve` | The issuer signs. The same transaction consumes the authenticated registry UTxO, recreates it with version + 1 and **all** requested assets prepended, and refunds at least the full request deposit to the stored requester address. The registry validator independently checks the matching `RegisterMany` transition. |
| `Reject` | The issuer signs and refunds at least the full locked ADA to the requester. The registry need not change. |
| `Cancel` | The stored requester key signs and receives at least the full locked ADA back. The registry need not change. |

Approval is all-or-nothing: the request validator checks registry identity/address, capacity, version, and the exact batch transition. A request does not auto-approve an asset and cannot approve only a subset. A request containing an already registered asset cannot be approved as-is; reject it and submit a corrected request. Transaction fees must be accounted for separately from the refund rule.

## Browser and trust boundaries

`/registry` exposes requests, issuer review, direct registration/revocation, and authenticated state. `/asset-registry` exposes public approval status. Before offering direct registration or request approval, the UI checks that an original NFT was minted by the currently supported CSWAP policy, using chain data from the configured provider. This provenance check is **off-chain**. The validator authorizes the issuer and valid exact asset IDs, so a different builder can register any valid ID if the issuer signs. The check cannot establish legal ownership or document authenticity. UI operator gating likewise does not replace validator authorization.

The registry reader depends on the configured chain provider for UTxO discovery and mint-history lookup; it is not a light-client proof. Provider/indexer delays can affect display after confirmation without changing ledger state. The project's indexer cloud deployment remains deferred. On-chain confirmation, blueprint compatibility, and public deployment identities must be verified separately from a website build.

## Limits and future evolution

The 50-entry cap and single mutable UTxO limit capacity and concurrent writes. Changing validator parameters or schema changes script addresses; existing UTxOs are not upgraded in place. Any replacement needs a reviewed deployment and migration plan for approved entries **and outstanding request UTxOs**, plus a controlled frontend configuration switch. Do not deploy a replacement merely to address temporary provider lag.

For a possible multi-UTxO registry and benchmark/migration questions, see [Future sharded registry plan](FUTURE_SHARDED_REGISTRY.md). That proposal is not implemented or a deployment instruction.
