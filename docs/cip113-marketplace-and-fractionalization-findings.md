# CIP-113 Fractionalization, Registry, and Marketplace Findings

## Executive summary

CIP-113 tokens are not ordinary native assets. Every registered token unit must remain under the shared `programmable_logic_base` (PLB) payment credential. Ownership is represented by the stake credential in the address.

This has three direct consequences:

1. An existing vault that sends a CIP-113 token to a normal vault spending address is incompatible with the current custody invariant.
2. A marketplace must hold CIP-113 assets at a PLB address owned by a marketplace stake validator.
3. Marketplace orders, prices, and loan offers should normally live in separate marketplace state UTxOs, not in the CIP-113 registry.

The analysis is based on the checked-out CIP-113 implementation at `/home/franklin/CSwap/cip113-programmable-tokens`. The Aiken source and generated `plutus.json` should be treated as authoritative where prose documentation differs from the current contract surface.

## 1. CIP-113 custody model

A CIP-113 holding address has this shape:

```text
addr(
  programmable_logic_base,
  owner_credential
)
```

The payment credential is shared by all programmable tokens. The stake credential identifies the owner and can be either:

- a verification-key credential;
- a payment key credential placed in the stake slot; or
- a script credential invoked through a zero-ADA withdrawal.

The PLB validator is a dispatcher. For each spent PLB input it reads the current dispatcher credential from the protocol-parameters UTxO and requires the appropriate delegate. The transaction then uses one of the action delegates:

- `transfer` for ordinary transfers;
- `third_party` for administrative seizure/freeze operations;
- `unfracking` for same-owner restructuring.

The transfer path verifies owner authorization, registry proofs, token-specific transfer logic, and that programmable assets remain at PLB addresses.

The issuance path also rejects a minted token at a non-PLB output. The relevant implementation is `issuance_mint.no_escape`.

## 2. How the registry works

The registry is a sorted linked list of registry-node UTxOs. A node contains:

```text
key                           token policy ID
next                          next policy ID in sorted order
minting_logic_script          issuance and lifecycle authority
transfer_logic_script         ordinary transfer rules
third_party_transfer_logic    seizure/freeze rules
unfracking_logic_script       same-owner restructuring hook
global_state_cs               optional state-policy ID
```

Each node carries one registry NFT. The NFT asset name equals the node's `key`, which authenticates the node for reference-input lookups.

### Initialization

Initialization consumes a one-shot UTxO and creates the origin node with an empty key and a sentinel successor. The origin node is locked at the registry validator address.

### Registration

To register policy `P`, the registry transaction:

1. Finds the covering node whose sorted range contains `P`.
2. Spends that covering node.
3. Mints exactly one registry NFT named `P`.
4. Emits the updated covering node and the new node.

The ordering invariant is:

```text
covering.key < P < covering.next
```

Registration requires the issuance credential's zero-ADA withdrawal. It also reads the `IssuanceCborHex` reference input and verifies that the policy ID was derived from the issuance template and the supplied issuance credential. This prevents a registry node from claiming that a different issuance or transfer logic governs the policy.

### Lookup during transfers

For every non-ADA policy in PLB inputs, the transfer redeemer supplies one registry proof:

```text
TokenExists { node_idx }
```

for a registered policy, or:

```text
TokenDoesNotExist { node_idx }
```

for an ordinary asset proven by a covering node.

For `TokenExists`, the core checks that the node key equals the policy ID and requires the node's `transfer_logic_script` withdrawal.

The registry is therefore a directory and authenticity mechanism. It is not an order book, price oracle, marketplace state store, or trade authorization by itself.

### Registry updates

The current source freezes:

```text
key
next
minting_logic_script
```

The current source allows updates to:

```text
transfer_logic_script
third_party_transfer_logic_script
unfracking_logic_script
global_state_cs
```

Updates are authorized by the existing `minting_logic_script` withdrawal. Marketplace and wallet software must resolve the current registry node at transaction-build time instead of permanently caching token logic credentials.

## 3. Supporting fractionalization

### Recommended design: vault-owned PLB address

Do not place the original CIP-113 NFT at:

```text
addr(vault_spending_validator, no_stake_credential)
```

Instead, make the vault contract the owner of a PLB UTxO:

```text
addr(
  programmable_logic_base,
  Script(vault_owner_stake_validator)
)
```

The existing vault spending validator should be refactored into a stake/owner authorization validator. It is invoked through a zero-ADA withdrawal when the vault-owned PLB UTxO is spent.

### Fractionalize transaction

The transaction should:

1. Spend the original NFT from the user's PLB address.
2. Invoke the original token's transfer logic.
3. Pay the NFT to the vault-owned PLB address.
4. Attach a compact inline vault datum.
5. Mint the fraction token using a CIP-113 `issuance_mint` policy.
6. Pay the fractions to the user's PLB address.

The vault datum can contain:

```text
original policy ID and asset name
fraction policy ID and asset name
total fraction supply
vault configuration/version
```

The original token's transfer logic must permit transfer to the vault's script stake credential. The vault owner validator must verify that the transaction is an authorized fractionalization operation.

The fraction token's issuance logic must verify the same transaction shape and exact mint quantity. It should not use the existing standalone `ft_policy` unchanged, because that policy expects an ordinary vault output and is not the CIP-113 `issuance_mint` policy.

### Combine transaction

The combine transaction should:

1. Spend the vault-owned PLB UTxO.
2. Invoke the vault owner stake validator.
3. Collect the complete fraction supply.
4. Burn exactly that supply.
5. Invoke the original token's transfer logic.
6. Pay the original NFT to the user's PLB address.

The original NFT remains a CIP-113 token. It must not be paid to a normal wallet payment address unless it is intentionally being converted into a different, non-CIP-113 asset.

### Required safety fixes

The existing vault `Update` action can change `total_fractions` without a matching mint or burn. This can make redemption terms inconsistent with the actual fraction supply. The safer choices are:

- make the total supply immutable; or
- allow updates only when the same transaction proves the corresponding fraction mint/burn.

The fraction burn path must also require the correct vault input and exact fraction quantity. A policy that merely accepts any negative mint is insufficient for redemption authorization.

### Alternative: tokens outside PLB

Allowing the original token to leave PLB would require a protocol extension. The core would need explicit escrow exceptions, registry binding for escrow validators, new transfer/seizure semantics, and ecosystem support. This is a new CIP-113 variant rather than a substandard-level change.

The PLB payment credential plus vault stake credential preserves the existing custody model.

## 4. Where marketplace and loan datums live

The registry should not contain asking prices, orders, loan offers, or loan status.

Use a separate marketplace state UTxO:

```text
Order UTxO
  address: marketplace spending validator
  value:   ADA + order/offer NFT
  datum:   price and order terms

Escrow UTxO
  address: addr(PLB, Script(marketplace_owner_stake_validator))
  value:   CIP-113 token + ADA
  datum:   compact escrow metadata
```

The order datum might contain:

```text
order_id
seller
token policy ID
token asset name
token quantity
payment policy ID
payment asset name
asking amount
escrow output reference
expiry
fee information
```

A loan offer can additionally contain lender, borrower constraints, principal, interest, collateral terms, duration, expiry, and a reference to the collateral PLB UTxO.

The order/loan validator consumes or updates the state UTxO. The marketplace stake validator authorizes spending the CIP-113 escrow UTxO. Both validators can inspect the full transaction and cross-check the order NFT, output reference, asset quantities, participants, and payment amounts.

A compact inline datum can be placed directly on a PLB output, but a separate state UTxO is generally cleaner. PLB outputs must avoid datum hashes and reference scripts, and holder-created inline datums are size-bounded.

## 5. Marketplace trading models

### Signed off-chain order

The seller keeps the asset in their own PLB UTxO and signs an order or partially signed settlement transaction. Settlement pays:

```text
token   → addr(PLB, buyer_credential)
payment → seller address
fee     → marketplace address
```

The seller's owner authorization is still required. If the seller's UTxO changes, the order must be rebuilt or invalidated.

### Escrow marketplace

The seller first transfers the token to the marketplace-owned PLB address. The marketplace stake validator then authorizes settlement according to the order datum.

The settlement transaction includes:

```text
order UTxO
marketplace-owned PLB UTxO
buyer payment inputs
```

It also includes the PLB dispatcher, transfer delegate, token transfer-logic withdrawal, protocol-params reference input, and registry-node reference input.

### AMM or lending pool

Pool reserves and CIP-113 collateral are held at:

```text
addr(PLB, Script(pool_stake_validator))
```

The pool stake validator checks pricing, collateral, repayment, liquidation, or state-transition rules. The CIP-113 transfer delegate and each token's transfer logic still run independently.

If a transaction spends multiple registered programmable policies, every policy's transfer logic must approve the transaction. A token's transfer logic may reject script-owned destinations or particular marketplace credentials, so marketplace compatibility must be designed into the token substandard.

## 6. CIP-113 minter setup

### Shared infrastructure

The deployment must have the shared protocol components available as reference scripts and reference UTxOs:

- `programmable_logic_base`
- `programmable_logic_global`
- `transfer`
- `third_party`
- `unfracking`
- `registry`
- `issuance_cbor_hex_mint`
- `protocol_params_mint`
- `protocol_params_spend`
- protocol-parameters UTxO
- registry origin/node UTxOs

### Token-specific components

Implement or deploy:

1. **Issuance logic** — authorizes minting and burning. This credential is also the registry lifecycle authority.
2. **Transfer logic** — validates holder transfers.
3. **Third-party logic** — validates seizure/freeze actions.
4. **Optional unfracking hook** — controls same-owner restructuring.
5. **Optional state policy and state validator** — provides blacklist, whitelist, oracle, or configuration state.

### Derive and register the token policy

Apply the current `issuance_mint` parameters:

```text
programmable_logic_base: Credential
registry_node_cs: PolicyId
minting_logic_cred: Credential
params_policy: PolicyId
```

The resulting script hash is the token policy ID. Do not parameterize issuance logic with its own policy ID; that is circular.

Register the resulting policy using a registry node and:

```text
RegistryInsert {
  key: policy_id,
  minting_logic_script: issuance_logic_credential
}
```

The issuance logic zero-ADA withdrawal must be present during registration, even if the transaction does not mint the first supply.

### Mint

For a registered policy, use:

```text
issuance_mint redeemer = RefInput { index: registry_node_index }
```

For registration plus first mint, use:

```text
issuance_mint redeemer = OutputIndex { index: registry_node_output_index }
```

The issuance logic withdrawal authorizes the operation and enforces token-specific rules. Every minted unit must be paid to a PLB address:

```text
addr(programmable_logic_base, owner_credential)
```

Pure mint transactions can be validated by the issuance path. Transactions that also spend existing PLB tokens need the protocol-params reference input, PLB dispatcher, transfer delegate, registry proofs, and relevant token transfer-logic withdrawals.

## 7. Marketplace implementation checklist

- Index registry nodes continuously.
- Resolve the current registry node immediately before building each transaction.
- Derive PLB addresses for both key owners and script owners.
- Register marketplace and pool stake credentials before zero-ADA invocation.
- Store order and loan datums in marketplace/lending state UTxOs.
- Keep CIP-113 assets in PLB-owned escrow outputs.
- Include the current protocol-params and registry-node reference inputs.
- Include every required zero-ADA withdrawal.
- Calculate reference-input and withdrawal indices in ledger-canonical order.
- Invoke every registered policy's transfer logic for policies present in PLB inputs.
- Preserve the PLB output shape: no datum hash and no reference script.
- Treat third-party actions separately from ordinary trades.
- Handle registry-node contention by re-resolving the covering/current node and rebuilding the transaction if necessary.

## Source references

- Core issuance custody: `validators/issuance_mint.ak`
- PLB dispatch: `validators/programmable_logic_base.ak`
- Transfer invariants: `validators/programmable_logic/transfer.ak`
- Owner authorization: `validators/programmable_logic/owner.ak`
- Registry: `validators/registry.ak`
- Registry node type: `lib/registry_node.ak`
- Shared redeemers: `lib/types.ak`
- PLB output shape: `lib/assets.ak`
- Existing non-CIP-113 vault: `/home/franklin/CSwap/aiken-ebecca/validators/vault.ak`
- Existing standalone fraction policy: `/home/franklin/CSwap/aiken-ebecca/validators/ft_policy.ak`
