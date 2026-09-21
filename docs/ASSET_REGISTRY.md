# Basic on-chain asset registry

The registry records **issuer approval of exact asset IDs**. One authenticated
UTxO holds a version counter and up to 50 `(policy_id, asset_name)` entries.
It is independent of the older registry/oracle marketplace contracts.

## Trust and contract rules

`contracts/marketplace/validators/asset_registry.ak` takes two immutable
parameters: a registry identity asset and the issuer payment key hash.
The existing `one_shot` policy mints exactly one identity token by consuming a
seed UTxO. The `/registry` initialization transaction sends that token directly
to the parameterized registry script with an empty version-0 datum.

The deployment configuration is the trust anchor. Only configure a deployment
after confirming its identity token, issuer, script address, and initial datum.
An arbitrary token with the same name or an arbitrary datum at the script
address does not authenticate a registry. The one-shot minting policy by itself
does not require the initial output to be a registry; the initialization builder
creates that output, and configured readers check it.

For each update, the validator requires:

- The configured issuer signature and the configured identity token in its input.
- Exactly one output holding that identity token at the same address.
- The same native assets and no decrease in locked ADA (topups are allowed).
- No minting or burning in the update transaction.
- A version increment of exactly one.
- Exactly one registration or revocation, preserving all other entries.
- Valid native asset IDs, no duplicates, and at most 50 entries.

There is no close action, issuer rotation, automatic expiry, or policy-wide
approval. The registry identity token and its ADA remain locked. Registration
and revocation require fees, and a larger datum can require additional ADA.
A single state UTxO serializes updates; concurrent submissions must refresh and
retry after one wins. Sharded registries are a future scaling option.

## Asset-addition requests

The basic registry supports RegisterMany: one issuer-approved transition can
add a non-empty, duplicate-free batch of valid exact asset IDs. This permits
a user request to name one or more assets without partial approval.

The separate validators/asset_registry_request.ak validator is a permissionless
ADA-only request escrow. Its inline datum stores the requester address and
payment-key hash plus one to fifty exact asset IDs. The UI locks 3 tADA; the
validator requires at least 2 tADA.

| Action | Required signer | Required result |
| --- | --- | --- |
| Approve | Registry issuer | Consume the request and authenticated registry UTxOs together; create the exact next registry datum with every requested asset, then refund the full request deposit to its stored requester address. |
| Reject | Registry issuer | Refund the full request deposit to its stored requester address. |
| Cancel | Stored requester key | Refund the full request deposit to its stored requester address. |

Approval is atomic. The request validator checks the registry identity,
address, version increment, capacity, and entire batched transition while the
registry validator independently requires the issuer signature and matching
RegisterMany action. A request cannot be used to add only a subset of assets.

The request is an intake record, not proof of mint provenance, legal
ownership, compliance, or suitability. The Team UI verifies supported
original-NFT mint provenance before approval as an operational control.

This protocol changes the basic registry script hash. Existing basic
registries must be redeployed with reviewed entries migrated before request
approvals are enabled; a deployed legacy registry cannot be upgraded in place.

## Mint origin versus approval

The management page checks an NFT's initial mint against the current
`multi_nft_policy.multi_oneshot.mint` blueprint before asking the issuer to sign.
It reconstructs the policy with each consumed input as a candidate seed and
compares the resulting policy ID to the requested asset. Reference inputs and
collateral are excluded. Lookup failures stop registration.

This provenance check runs in the app. **The registry validator enforces issuer
approval, not the original minting policy.** An issuer using another transaction
builder can approve any valid asset ID. A registry entry does not prove legal
ownership, underlying asset quality, or that the issuer used this UI. Public
reads and provenance lookup trust the configured Blockfrost service for chain
data; this is not a light-client proof.

Only the current NFT blueprint is supported by the registration UI. Contract
upgrades need explicit version support. Fraction tokens are separate asset IDs;
approving an original NFT does not approve its fractions. Fraction provenance
verification is not implemented in this basic version.

The marketplace checkbox filters exact registered asset IDs at the time of the
last successful refresh. It fails closed when registry reads fail. This is a
browsing and Team-admission filter; the existing registry-free orderbook and
current shared-pool settlement validators still permit unregistered assets at
the validator level. Other applications can consume the registry UTxO as a
reference input and enforce membership on-chain in future changes.

## Preprod deployment

1. Install dependencies and a compatible Aiken compiler (the marketplace pins
   v1.1.21). Run `aiken build` from `contracts/marketplace`.
2. Set `NEXT_PUBLIC_CARDANO_NETWORK=preprod` and the server-only
   `BLOCKFROST_PROJECT_ID`. The existing transaction provider uses Preprod.
3. Open `/registry`, connect the intended issuer Eternl wallet on Preprod, and
   choose **Create registry**. Have an ADA-only UTxO containing at least 10 tADA
   and collateral available. The initial registry receives 5 tADA plus its NFT.
4. Sign the initialization transaction and wait for confirmation. Save its hash
   and the displayed configuration. Do not create another registry while that
   transaction is pending.
5. Copy the public `NEXT_PUBLIC_ASSET_REGISTRY_TOKEN` and
   `NEXT_PUBLIC_ASSET_REGISTRY_ISSUER` values into `.env.local`, then restart the
   development server (or rebuild a deployed app). Never put a signing key in
   either setting. The registry address is derived rather than independently
   configured.
6. Reopen `/registry` and verify the authenticated empty registry. Connect the
   issuer, paste an NFT asset ID minted with our current contract, and register
   it. Confirmation updates the list; revoke removes approval without moving
   or burning the NFT itself.
7. Inspect the asset in `/assets` for its registration status and use
   **CSWAP-registered assets only** in `/marketplace`.

A confirmation timeout keeps the submitted transaction hash visible and blocks
additional writes on that page until **Check confirmation** succeeds. Preserve
that hash before leaving/reloading the page: pending state is not persisted
across reloads. A failed or dropped transaction needs independent verification
before retrying.

## Validation

```sh
# From contracts/marketplace
 aiken check
 aiken build

# From the repository root (Node 22.6+ for native TypeScript stripping)
 npm run test:registry
 npm run lint
 npm run build
```

There are 16 registry validator tests covering authorization, state identity,
exact transitions, invalid/duplicate assets, ADA preservation, and capacity.
The Lucid emulator tests submit initialization/register/revoke transactions,
reject unauthorized and duplicate updates, exercise the 50-entry boundary with
maximum-length asset names, and check authenticated reads and mint provenance.
They do not replace a wallet-signed Preprod smoke test. No live registry is
created by the automated tests.
