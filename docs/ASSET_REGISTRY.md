# Basic on-chain asset registry

The registry records **issuer approval of exact asset IDs**. Owners create, view, and cancel their own pending requests at `/portfolio/asset-requests`; issuer review and direct registration are at operator-gated `/registry`. One authenticated UTxO holds a version counter and up to 50 `(policy_id, asset_name)` entries.
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
- Exactly the selected registration, batched registration (`RegisterMany`) or revocation transition, preserving all other entries.
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

Adding requests changed the earlier basic registry script hash; a deployed legacy registry cannot be upgraded in place. The current Preprod manifest already contains a request-enabled registry, reused unchanged in the [2026-09-25 deployment](PREPROD_REDEPLOYMENT_2026-09-25.md). Do not create another registry as a routine setup step.

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

Public approval status is available at `/asset-registry`. The Marketplace no longer has a registered-assets-only checkbox. Registry approval is separate from shared-pool admission: the current acquisition builder and validators use on-chain posted prices, not registry membership. There is no off-chain operator quantity/activity control. An original NFT's approval does not approve its fraction token. Other applications may choose to enforce authenticated membership through a reference input. See the [current architecture](ASSET_REGISTRY_ARCHITECTURE.md) and separate [future sharding proposal](FUTURE_SHARDED_REGISTRY.md).

## Future registry initialization — only if an approved replacement is needed

Normal operation uses the registry in `marketplace-deployment.preprod.json`. The following initialization flow is not a migration and does not discover old requests. Obtain approval before spending test ADA on a replacement, preserve the intended issuer and review any entries to copy. Use [Shared-pool operations](SHARED_POOL_OPERATIONS.md) for a coordinated CLI replacement.

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
5. Record the confirmed public token, issuer and derived address in the reviewed deployment configuration. Local development can use `NEXT_PUBLIC_ASSET_REGISTRY_TOKEN` and `NEXT_PUBLIC_ASSET_REGISTRY_ISSUER` in `.env.local`, but `build:preprod` takes its canonical identities from the committed manifest. Local overrides alone do not update hosting. Never put a signing key in these settings.
6. Reopen `/registry` and verify the authenticated empty registry. Connect the
   issuer, paste an NFT asset ID minted with our current contract, and register
   it. Confirmation updates the list; revoke removes approval without moving
   or burning the NFT itself.
7. Verify the authenticated asset list at `/asset-registry`. Confirm the configured deployment and hosted build separately; there is no Marketplace registration filter.

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
