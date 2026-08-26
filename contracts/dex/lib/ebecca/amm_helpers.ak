use aiken/collection/list
use cardano/assets
use cardano/transaction.{InlineDatum, Output, Transaction}
use ebecca/dex_types.{AssetId, FactoryDatum, PoolDatum}

pub const ada: AssetId = AssetId { policy_id: "", asset_name: "" }

pub fn unit(asset: AssetId) -> (assets.PolicyId, assets.AssetName) {
  (asset.policy_id, asset.asset_name)
}

pub fn quantity_of(value: assets.Value, asset: AssetId) -> Int {
  assets.quantity_of(value, asset.policy_id, asset.asset_name)
}

pub fn has_one(value: assets.Value, asset: AssetId) -> Bool {
  quantity_of(value, asset) == 1
}

pub fn is_ada(asset: AssetId) -> Bool {
  asset == ada
}

pub fn valid_pool_config(factory: FactoryDatum, pool: PoolDatum) -> Bool {
  and {
    pool.pool_nft.policy_id == factory.pool_nft_policy,
    pool.asset_a != pool.asset_b,
    pool.fee_numerator > 0,
    pool.fee_numerator <= pool.fee_denominator,
    pool.fee_denominator > 0,
    pool.reserve_a > 0,
    pool.reserve_b > 0,
    pool.total_liquidity > 0,
    pool.pool_lovelace > 0,
    pool.pool_nft != pool.asset_a,
    pool.pool_nft != pool.asset_b,
    pool.pool_nft != pool.lp_token,
    pool.asset_a != pool.lp_token,
    pool.asset_b != pool.lp_token,
    pool.pool_nft.policy_id != "" || pool.pool_nft.asset_name != "",
    if is_ada(pool.asset_a) {
      pool.pool_lovelace == pool.reserve_a
    } else if is_ada(pool.asset_b) {
      pool.pool_lovelace == pool.reserve_b
    } else {
      True
    },
  }
}

pub fn expected_pool_value(pool: PoolDatum) -> assets.Value {
  let value =
    assets.zero
      |> assets.add(
          pool.asset_a.policy_id,
          pool.asset_a.asset_name,
          pool.reserve_a,
        )
      |> assets.add(
          pool.asset_b.policy_id,
          pool.asset_b.asset_name,
          pool.reserve_b,
        )
      |> assets.add(pool.pool_nft.policy_id, pool.pool_nft.asset_name, 1)

  if is_ada(pool.asset_a) || is_ada(pool.asset_b) {
    value
  } else {
    value |> assets.add("", "", pool.pool_lovelace)
  }
}

pub fn pool_value_matches(value: assets.Value, pool: PoolDatum) -> Bool {
  value == expected_pool_value(pool)
}

test token_pool_value_requires_exact_locked_lovelace() {
  let pool =
    PoolDatum {
      pool_nft: AssetId { policy_id: "pool", asset_name: "nft" },
      asset_a: AssetId { policy_id: "policy", asset_name: "DXA" },
      asset_b: AssetId { policy_id: "policy", asset_name: "DXB" },
      lp_token: AssetId { policy_id: "lp", asset_name: "LP" },
      fee_numerator: 997,
      fee_denominator: 1000,
      reserve_a: 500_000,
      reserve_b: 1_000_000,
      total_liquidity: 707_106,
      pool_lovelace: 2_090_350,
    }
  let expected = expected_pool_value(pool)

  and {
    pool_value_matches(expected, pool),
    pool_value_matches(expected |> assets.add("", "", 1), pool) == False,
  }
}

pub fn same_pool_config(before: PoolDatum, after: PoolDatum) -> Bool {
  and {
    after.pool_nft == before.pool_nft,
    after.asset_a == before.asset_a,
    after.asset_b == before.asset_b,
    after.lp_token == before.lp_token,
    after.fee_numerator == before.fee_numerator,
    after.fee_denominator == before.fee_denominator,
    if is_ada(before.asset_a) || is_ada(before.asset_b) {
      True
    } else {
      after.pool_lovelace == before.pool_lovelace
    },
  }
}

pub fn total_paid(outputs: List<Output>, recipient, asset: AssetId) -> Int {
  outputs
    |> list.filter(fn(output) { output.address == recipient })
    |> list.foldl(
        0,
        fn(output, total) { total + quantity_of(output.value, asset) },
      )
}

pub fn factory_reference(
  tx: Transaction,
  factory_token: AssetId,
) -> FactoryDatum {
  expect [reference] =
    list.filter(
      tx.reference_inputs,
      fn(input) { has_one(input.output.value, factory_token) },
    )
  expect InlineDatum(raw) = reference.output.datum
  expect factory: FactoryDatum = raw
  expect factory.factory_token == factory_token
  factory
}
