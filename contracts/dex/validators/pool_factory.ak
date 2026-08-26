use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets.{PolicyId, quantity_of, tokens}
use cardano/transaction.{InlineDatum, Transaction}
use ebecca/amm_helpers.{has_one, pool_value_matches, valid_pool_config}
use ebecca/dex_types.{
  AssetId, BurnPool, CreatePool, FactoryAction, FactoryDatum, PoolDatum,
}

/// Mints deterministic pool NFTs under one policy.
///
/// A factory-state transition creates exactly one pool NFT and one initial AMM
/// UTxO at the shared AMM address. A burn requires the factory administrator,
/// full LP redemption, and the authenticated AMM input.
validator pool_factory(
  factory_state_token: AssetId,
  amm_address: Address,
  lp_policy: PolicyId,
) {
  mint(action: FactoryAction, policy_id: PolicyId, tx: Transaction) {
    when action is {
      CreatePool ->
        create_pool(factory_state_token, amm_address, lp_policy, policy_id, tx)
      BurnPool ->
        burn_pool(factory_state_token, amm_address, lp_policy, policy_id, tx)
    }
  }

  else(_) {
    False
  }
}

fn create_pool(
  factory_state_token: AssetId,
  amm_address: Address,
  lp_policy: PolicyId,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  expect [state_input] =
    list.filter(
      tx.inputs,
      fn(input) { has_one(input.output.value, factory_state_token) },
    )
  expect InlineDatum(raw_state) = state_input.output.datum
  expect state: FactoryDatum = raw_state
  expect [state_output] =
    list.filter(
      tx.outputs,
      fn(output) {
        output.address == state_input.output.address && has_one(
          output.value,
          factory_state_token,
        )
      },
    )
  expect InlineDatum(raw_next_state) = state_output.datum
  expect next_state: FactoryDatum = raw_next_state
  expect [Pair(name, amount)] = tx.mint |> tokens(policy_id) |> dict.to_pairs()
  expect [pool_output] =
    list.filter(
      tx.outputs,
      fn(output) {
        has_one(output.value, AssetId { policy_id, asset_name: name })
      },
    )
  expect InlineDatum(raw_pool) = pool_output.datum
  expect pool: PoolDatum = raw_pool

  and {
    !state.paused,
    state.factory_token == factory_state_token,
    state.pool_nft_policy == policy_id,
    next_state.factory_token == state.factory_token,
    next_state.admin == state.admin,
    next_state.pool_nft_policy == state.pool_nft_policy,
    next_state.paused == state.paused,
    next_state.next_pool_id == state.next_pool_id + 1,
    name == bytearray.from_int_big_endian(state.next_pool_id, 8),
    amount == 1,
    pool_output.address == amm_address,
    pool.pool_nft == AssetId { policy_id, asset_name: name },
    pool.lp_token == AssetId { policy_id: lp_policy, asset_name: name },
    valid_pool_config(state, pool),
    pool_value_matches(pool_output.value, pool),
    quantity_of(tx.mint, lp_policy, name) == pool.total_liquidity,
  }
}

fn burn_pool(
  factory_state_token: AssetId,
  amm_address: Address,
  lp_policy: PolicyId,
  policy_id: PolicyId,
  tx: Transaction,
) -> Bool {
  expect [factory_ref] =
    list.filter(
      tx.reference_inputs,
      fn(input) { has_one(input.output.value, factory_state_token) },
    )
  expect InlineDatum(raw_factory) = factory_ref.output.datum
  expect factory: FactoryDatum = raw_factory
  expect [Pair(name, amount)] = tx.mint |> tokens(policy_id) |> dict.to_pairs()
  let pool_nft = AssetId { policy_id, asset_name: name }
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

  and {
    list.has(tx.extra_signatories, factory.admin),
    factory.factory_token == factory_state_token,
    factory.pool_nft_policy == policy_id,
    pool.pool_nft == pool_nft,
    pool.lp_token.policy_id == lp_policy,
    amount == -1,
    quantity_of(tx.mint, pool.lp_token.policy_id, pool.lp_token.asset_name) == -pool.total_liquidity,
    !list.any(tx.outputs, fn(output) { has_one(output.value, pool_nft) }),
  }
}
