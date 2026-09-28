# Future sharded asset registry plan

> **Proposal only.** The current registry is a single authenticated UTxO, and
> Marketplace validators do not require registry membership. See the
> [current architecture](ASSET_REGISTRY_ARCHITECTURE.md) for deployed behavior.

## Candidate decision

If the current 50-entry, single-UTxO registry becomes a measured bottleneck, evaluate a **sharded on-chain registry**: multiple authenticated registry UTxOs, each containing a bounded list of supported assets in its inline datum. Sharding has not been approved for implementation or deployment.

The candidate should be compared with:

1. one asset per UTxO, which creates excessive UTxO and min-ADA overhead;
2. bounded lists across several UTxOs, which retain simple on-chain membership checks and permit parallel updates; and
3. a single Merkle-root UTxO, which reduces on-chain storage but introduces proof-generation and data-availability dependencies.

Cardano would remain the authority. An off-chain database could index registry state for discovery, but it would not determine approval. The project's indexer deployment is currently deferred.

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

Each proposed shard would have a unique authentication NFT. Current Marketplace and shared-pool validators do **not** authenticate or reference registry state; adding that rule would require a separately reviewed validator and transaction-builder upgrade.

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

The proposed buy/sell flags do not exist in the current registry. Their meaning and need must be decided before implementation. Team-controlled buy and sell prices already live in shared-pool state; DEX prices follow reserves. Adding a second admission authority could create conflicting expectations.

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

Evaluate a fixed shard count such as 16 or 32. The client and validator would calculate the required shard from the complete asset unit. This formula is illustrative; the exact byte encoding, hash interpretation, and count must be specified before implementation:

```text
shard_id = blake2b_256(asset_unit)[0] mod SHARD_COUNT
```

Entries in each datum must be sorted by complete asset unit and contain no duplicates. Begin with a conservative limit of approximately 32 entries per shard, then finalize it using transaction-size and Aiken execution-budget benchmarks rather than treating 32 as a protocol constant.

## Membership validation

If future Marketplace entry operations are deliberately gated on registry membership, they could reference the applicable shard UTxO without consuming it. A revised validator would need to check that:

1. the reference input contains the expected shard authentication NFT;
2. the asset hashes to the shard ID in the datum;
3. the exact asset unit occurs in the sorted entry list; and
4. the applicable `buy_enabled` or `sell_enabled` flag is true.

Reference-input reads would not contend with each other. If the team spends a shard while a user transaction references its old output, the user transaction must be rebuilt. Exit, cancellation, and recovery paths must remain available without registry membership or proof-service availability.

## Registry updates

An update would consume and recreate only the affected shard. A future validator would need to enforce:

- authorization by the configured team key;
- preservation of exactly one correct shard NFT;
- an unchanged shard ID;
- deterministic assignment of every entry to that shard;
- sorted entries with no duplicates;
- the maximum entry count;
- an exact one-step version increment;
- the requested register, revoke, or flag change without unrelated mutations; and
- no unauthorized minting or burning of registry authentication tokens.

Updates to different shards could execute concurrently. Today's `RegisterMany` request escrow cannot simply be redirected to shards; cross-shard approvals and refunds need a separate atomicity design.

## Alternatives considered

### One asset per UTxO

This provides independent updates and very simple entry datums, but requires a UTxO, min-ADA deposit, authentication mechanism, and indexer record for every supported asset. It is better suited to permissionless registration by independent issuers than to a team-administered marketplace.

### Single UTxO containing the complete list

This is the **current implementation**, not merely a prototype. It has a 50-entry cap and serialized administrative updates. Treat it as the source of truth unless measurements and review justify migration.

### Single Merkle-root UTxO

Merkle membership reduces the on-chain registry to one root and logarithmic membership proofs. However, the root cannot reconstruct the asset list or generate proofs. Production use would require a rollback-aware proof service, replicated full-tree snapshots, an independently retrievable manifest, and client proof verification.

Integrity without proof availability is insufficient: users could be unable to produce valid membership transactions even though the root remains on-chain.

## Merkle migration threshold

Only if sharding is first adopted, remain with bounded direct-list shards while measured datum size and execution cost stay within protocol limits. Consider a Merkle design if the registry grows into thousands of assets or measured costs make direct membership impractical.

A Merkle migration would need to publish the complete sorted leaf manifest to durable replicated storage and bind its content hash to the on-chain root. Exit and cancellation paths must never depend on registry membership or proof-service availability.

## Prerequisites before implementation

- Measure current registry growth, datum size, execution units, update contention, and user impact. Decide whether sharding and Marketplace gating are actually needed.
- Design treatment of outstanding request UTxOs and approved entries. Old scripts and outputs cannot be upgraded in place; a new registry identity and frontend switch require reviewed migration and deployment.
- Obtain contract/security review and a testnet acceptance plan before choosing this design for production.

- Parameterize the registry validator with shard count and team key.
- Define and mint one immutable authentication NFT per shard.
- Add deterministic shard calculation to the browser transaction builder.
- Require registry reference inputs only for gated entry operations, not exits.
- Implement register, revoke, enable-buy, and enable-sell transitions.
- Add property tests for shard assignment, uniqueness, ordering, token preservation, and unauthorized updates.
- Benchmark datum sizes and execution units before selecting the final per-shard capacity.
- Extend the off-chain indexer and API to expose shard version and buy/sell flags.
- Provide a migration transaction or controlled staged migration from the current registry state and its pending requests.
