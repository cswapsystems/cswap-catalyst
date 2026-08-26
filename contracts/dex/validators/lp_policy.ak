use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{PolicyId, tokens}
use cardano/transaction.{InlineDatum, Transaction}
use ebecca/amm_helpers.{factory_reference, has_one, valid_pool_config}
use ebecca/dex_types.{
  AssetId, Bootstrap, BurnLp, CloseLp, FactoryDatum, LpAction, MintLp, PoolDatum,
}

/// Shared LP-token policy for all pools.
///
/// LP token names match the deterministic pool-NFT name. The policy validates
/// bootstrap, add-liquidity, remove-liquidity, and factory-admin close flows.
validator lp_policy(factory_state_token: AssetId, amm_address: Address) {
  mint(action: LpAction, policy_id: PolicyId, tx: Transaction) {
    when action is {
      Bootstrap { pool_nft } ->
        bootstrap(factory_state_token, amm_address, policy_id, pool_nft, tx)
      MintLp { pool_nft } ->
        update_lp(
          factory_state_token,
          amm_address,
          policy_id,
          pool_nft,
          True,
          tx,
        )
      BurnLp { pool_nft } ->
        update_lp(
          factory_state_token,
          amm_address,
          policy_id,
          pool_nft,
          False,
          tx,
        )
      CloseLp { pool_nft } ->
        close_lp(factory_state_token, amm_address, policy_id, pool_nft, tx)
    }
  }

  else(_) {
    False
  }
}

fn bootstrap(
  factory_state_token: AssetId,
  amm_address: Address,
  policy_id: PolicyId,
  pool_nft: AssetId,
  tx: Transaction,
) -> Bool {
  expect [state_input] =
    list.filter(
      tx.inputs,
      fn(input) { has_one(input.output.value, factory_state_token) },
    )
  expect InlineDatum(raw_factory) = state_input.output.datum
  expect factory: FactoryDatum = raw_factory
  expect [Pair(name, amount)] = tx.mint |> tokens(policy_id) |> dict.to_pairs()
  expect [pool_output] =
    list.filter(
      tx.outputs,
      fn(output) {
        output.address == amm_address && has_one(output.value, pool_nft)
      },
    )
  expect InlineDatum(raw_pool) = pool_output.datum
  expect pool: PoolDatum = raw_pool

  and {
    !factory.paused,
    factory.factory_token == factory_state_token,
    pool.pool_nft == pool_nft,
    pool.pool_nft.policy_id == factory.pool_nft_policy,
    pool.lp_token.policy_id == policy_id,
    pool.lp_token.asset_name == name,
    name == bytearray.from_int_big_endian(factory.next_pool_id, 8),
    amount == pool.total_liquidity,
    valid_pool_config(factory, pool),
  }
}

fn update_lp(
  factory_state_token: AssetId,
  amm_address: Address,
  policy_id: PolicyId,
  pool_nft: AssetId,
  is_mint: Bool,
  tx: Transaction,
) -> Bool {
  let factory = factory_reference(tx, factory_state_token)
  expect [pool_input] =
    list.filter(
      tx.inputs,
      fn(input) {
        input.output.address == amm_address && has_one(
          input.output.value,
          pool_nft,
        )
      },
    )
  expect InlineDatum(raw_before) = pool_input.output.datum
  expect before: PoolDatum = raw_before
  expect [pool_output] =
    list.filter(
      tx.outputs,
      fn(output) {
        output.address == amm_address && has_one(output.value, pool_nft)
      },
    )
  expect InlineDatum(raw_after) = pool_output.datum
  expect after: PoolDatum = raw_after
  expect [Pair(name, amount)] = tx.mint |> tokens(policy_id) |> dict.to_pairs()

  and {
    !factory.paused,
    valid_pool_config(factory, before),
    before.pool_nft == pool_nft,
    before.lp_token.policy_id == policy_id,
    before.lp_token.asset_name == name,
    after.pool_nft == before.pool_nft,
    after.lp_token == before.lp_token,
    if is_mint {
      amount > 0 && amount == after.total_liquidity - before.total_liquidity
    } else {
      amount < 0 && amount == after.total_liquidity - before.total_liquidity
    },
  }
}

fn close_lp(
  factory_state_token: AssetId,
  amm_address: Address,
  policy_id: PolicyId,
  pool_nft: AssetId,
  tx: Transaction,
) -> Bool {
  let factory = factory_reference(tx, factory_state_token)
  expect [pool_input] =
    list.filter(
      tx.inputs,
      fn(input) {
        input.output.address == amm_address && has_one(
          input.output.value,
          pool_nft,
        )
      },
    )
  expect InlineDatum(raw_pool) = pool_input.output.datum
  expect pool: PoolDatum = raw_pool
  expect [Pair(name, amount)] = tx.mint |> tokens(policy_id) |> dict.to_pairs()

  and {
    list.has(tx.extra_signatories, factory.admin),
    valid_pool_config(factory, pool),
    pool.pool_nft == pool_nft,
    pool.lp_token.policy_id == policy_id,
    pool.lp_token.asset_name == name,
    amount == -pool.total_liquidity,
    !list.any(tx.outputs, fn(output) { has_one(output.value, pool_nft) }),
  }
}
