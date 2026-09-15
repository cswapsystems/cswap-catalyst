# Asset Registry Architecture

## Decision

Use a **sharded on-chain registry**: multiple authenticated registry UTxOs, each containing a bounded list of supported assets in its inline datum.

This is the production compromise between:

1. one asset per UTxO, which creates excessive UTxO and min-ADA overhead;
2. bounded lists across several UTxOs, which retain simple on-chain membership checks and permit parallel updates; and
3. a single Merkle-root UTxO, which reduces on-chain storage but introduces proof-generation and data-availability dependencies.

Cardano remains the authority. The off-chain database indexes registry state for discovery and proof-free UI queries, but it does not determine whether an asset is supported.

## Proposed layout

```text
Registry address
├── Shard 0 UTxO + REGISTRY_SHARD_0 NFT
│   └── [entry, entry, ...]
├── Shard 1 UTxO + REGISTRY_SHARD_1 NFT
│   └── [entry, entry, ...]
├── Shard 2 UTxO + REGISTRY_SHARD_2 NFT
│   └── [entry, entry, ...]
└── ...
```

Each shard has a unique authentication NFT. Marketplace and shared-pool validators authenticate the referenced shard by this token before trusting its datum.

## Datum model

```aiken
type RegistryEntry {
  asset: AssetClass,
  buy_enabled: Bool,
  sell_enabled: Bool,
}

type RegistryShardDatum {
  shard_id: Int,
  version: Int,
  entries: List<RegistryEntry>,
}
```

The registry controls only whether an asset may be bought or sold. Team-controlled buy and sell prices belong in shared-pool state. DEX prices remain derived from pool reserves. Keeping these responsibilities separate prevents conflicting price authorities.

## Asset identity

Use the complete asset unit by default:

```text
policy_id + asset_name
```

Allowlisting only a policy ID also approves every asset name that policy can mint in the future. Policy-wide approval should therefore be an explicit, exceptional rule for issuers whose entire policy is trusted.

If both modes are required later, represent the distinction explicitly:

```aiken
type RegistryRule {
  ExactAsset(AssetClass)
  TrustedPolicy(ByteArray)
}
```

## Deterministic sharding

Start with a fixed shard count of 16 or 32. Both the client and validator calculate the required shard from the complete asset unit:

```text
shard_id = blake2b_256(asset_unit)[0] mod SHARD_COUNT
```

Entries in each datum must be sorted by complete asset unit and contain no duplicates. Begin with a conservative limit of approximately 32 entries per shard, then finalize it using transaction-size and Aiken execution-budget benchmarks rather than treating 32 as a protocol constant.

## Membership validation

A marketplace or instant-sell transaction references the applicable shard UTxO without consuming it. The validator checks that:

1. the reference input contains the expected shard authentication NFT;
2. the asset hashes to the shard ID in the datum;
3. the exact asset unit occurs in the sorted entry list; and
4. the applicable `buy_enabled` or `sell_enabled` flag is true.

Reference-input reads do not contend with each other. If the team spends a shard to update it while a user transaction references the previous output, the user transaction must be rebuilt against the new registry state. This makes revocation atomic relative to marketplace execution.

## Registry updates

An update consumes and recreates only the affected shard. The registry validator must enforce:

- authorization by the configured team key;
- preservation of exactly one correct shard NFT;
- an unchanged shard ID;
- deterministic assignment of every entry to that shard;
- sorted entries with no duplicates;
- the maximum entry count;
- an exact one-step version increment;
- the requested register, revoke, or flag change without unrelated mutations; and
- no unauthorized minting or burning of registry authentication tokens.

Updates to different shards may execute concurrently.

## Alternatives considered

### One asset per UTxO

This provides independent updates and very simple entry datums, but requires a UTxO, min-ADA deposit, authentication mechanism, and indexer record for every supported asset. It is better suited to permissionless registration by independent issuers than to a team-administered marketplace.

### Single UTxO containing the complete list

This is acceptable for a small prototype but grows datum size and linear membership-checking cost. All administrative changes also contend for the same UTxO. The current unsharded registry should be treated as a migration source rather than the final scaling model.

### Single Merkle-root UTxO

Merkle membership reduces the on-chain registry to one root and logarithmic membership proofs. However, the root cannot reconstruct the asset list or generate proofs. Production use would require a rollback-aware proof service, replicated full-tree snapshots, an independently retrievable manifest, and client proof verification.

Integrity without proof availability is insufficient: users could be unable to produce valid membership transactions even though the root remains on-chain.

## Merkle migration threshold

Remain with bounded direct-list shards while the measured datum size and execution cost stay comfortably within protocol limits. Consider a Merkle design when the registry grows into thousands or tens of thousands of assets, or benchmarks show that sharded direct membership materially restricts transaction composition.

The migration should publish the complete sorted leaf manifest to durable replicated storage and bind its content hash to the on-chain root. Exit and cancellation paths must never depend on registry membership or proof-service availability.

## Implementation checklist

- Parameterize the registry validator with shard count and team key.
- Define and mint one immutable authentication NFT per shard.
- Add deterministic shard calculation to the browser transaction builder.
- Require registry reference inputs only for gated entry operations, not exits.
- Implement register, revoke, enable-buy, and enable-sell transitions.
- Add property tests for shard assignment, uniqueness, ordering, token preservation, and unauthorized updates.
- Benchmark datum sizes and execution units before selecting the final per-shard capacity.
- Extend the off-chain indexer and API to expose shard version and buy/sell flags.
- Provide a migration transaction or controlled staged migration from the current registry state.
