use aiken/collection/list
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use ebecca/amm_helpers.{
  ada, factory_reference, has_one, pool_value_matches, same_pool_config,
  total_paid, valid_pool_config,
}
use ebecca/dex_types.{
  AddLiquidity, AssetId, Close, FactoryDatum, PoolAction, PoolDatum,
  RemoveLiquidity, Swap,
}

/// Shared-address constant-product AMM.
///
/// Every live pool is a distinct UTxO at this one script address. The
/// factory-state NFT is a stable parameter and is supplied as a reference
/// input for all pool transitions.
validator amm_pool(factory_state_token: AssetId) {
  spend(
    datum_opt: Option<PoolDatum>,
    action: PoolAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(before) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    let factory = factory_reference(self, factory_state_token)

    when action is {
      Close { recipient } ->
        valid_close(factory, before, own_input.output.value, recipient, self)
      _ -> {
        expect [continuing] =
          list.filter(
            self.outputs,
            fn(output) {
              output.address == own_input.output.address && has_one(
                output.value,
                before.pool_nft,
              )
            },
          )
        expect InlineDatum(raw_after) = continuing.datum
        expect after: PoolDatum = raw_after
        and {
          factory.paused == False,
          valid_pool_config(factory, before),
          pool_value_matches(own_input.output.value, before),
          valid_pool_config(factory, after),
          same_pool_config(before, after),
          pool_value_matches(continuing.value, after),
          valid_transition(action, before, after, self.mint),
        }
      }
    }
  }

  else(_) {
    False
  }
}

fn valid_transition(
  action: PoolAction,
  before: PoolDatum,
  after: PoolDatum,
  minted: assets.Value,
) -> Bool {
  when action is {
    Swap { minimum_amount_out } -> valid_swap(before, after, minimum_amount_out)
    AddLiquidity { minimum_lp_out } ->
      valid_add_liquidity(before, after, minimum_lp_out, minted)
    RemoveLiquidity { minimum_a_out, minimum_b_out } ->
      valid_remove_liquidity(
        before,
        after,
        minimum_a_out,
        minimum_b_out,
        minted,
      )
    Close { .. } -> False
  }
}

fn valid_swap(
  before: PoolDatum,
  after: PoolDatum,
  minimum_amount_out: Int,
) -> Bool {
  let in_a = after.reserve_a - before.reserve_a
  let in_b = after.reserve_b - before.reserve_b
  let out_a = before.reserve_a - after.reserve_a
  let out_b = before.reserve_b - after.reserve_b
  and {
    after.total_liquidity == before.total_liquidity,
    minimum_amount_out >= 0,
    or {
      and {
        in_a > 0,
        out_b > 0,
        out_b >= minimum_amount_out,
        out_b * (
          before.reserve_a * before.fee_denominator + in_a * before.fee_numerator
        ) <= in_a * before.fee_numerator * before.reserve_b,
      },
      and {
        in_b > 0,
        out_a > 0,
        out_a >= minimum_amount_out,
        out_a * (
          before.reserve_b * before.fee_denominator + in_b * before.fee_numerator
        ) <= in_b * before.fee_numerator * before.reserve_a,
      },
    },
  }
}

fn valid_add_liquidity(
  before: PoolDatum,
  after: PoolDatum,
  minimum_lp_out: Int,
  minted: assets.Value,
) -> Bool {
  let added_a = after.reserve_a - before.reserve_a
  let added_b = after.reserve_b - before.reserve_b
  let minted_lp = after.total_liquidity - before.total_liquidity
  and {
    minimum_lp_out >= 0,
    added_a > 0,
    added_b > 0,
    minted_lp > 0,
    minted_lp >= minimum_lp_out,
    added_a * before.reserve_b == added_b * before.reserve_a,
    minted_lp * before.reserve_a <= added_a * before.total_liquidity,
    minted_lp * before.reserve_b <= added_b * before.total_liquidity,
    assets.quantity_of(
      minted,
      before.lp_token.policy_id,
      before.lp_token.asset_name,
    ) == minted_lp,
  }
}

fn valid_remove_liquidity(
  before: PoolDatum,
  after: PoolDatum,
  minimum_a_out: Int,
  minimum_b_out: Int,
  minted: assets.Value,
) -> Bool {
  let removed_a = before.reserve_a - after.reserve_a
  let removed_b = before.reserve_b - after.reserve_b
  let burned_lp = before.total_liquidity - after.total_liquidity
  and {
    minimum_a_out >= 0,
    minimum_b_out >= 0,
    removed_a > 0,
    removed_b > 0,
    burned_lp > 0,
    removed_a >= minimum_a_out,
    removed_b >= minimum_b_out,
    removed_a * before.total_liquidity <= burned_lp * before.reserve_a,
    removed_b * before.total_liquidity <= burned_lp * before.reserve_b,
    assets.quantity_of(
      minted,
      before.lp_token.policy_id,
      before.lp_token.asset_name,
    ) == -burned_lp,
  }
}

fn valid_close(
  factory: FactoryDatum,
  before: PoolDatum,
  input_value: assets.Value,
  recipient: Address,
  self: Transaction,
) -> Bool {
  and {
    list.has(self.extra_signatories, factory.admin),
    valid_pool_config(factory, before),
    pool_value_matches(input_value, before),
    assets.quantity_of(
      self.mint,
      before.pool_nft.policy_id,
      before.pool_nft.asset_name,
    ) == -1,
    assets.quantity_of(
      self.mint,
      before.lp_token.policy_id,
      before.lp_token.asset_name,
    ) == -before.total_liquidity,
    list.any(
      self.outputs,
      fn(output) { has_one(output.value, before.pool_nft) },
    ) == False,
    total_paid(self.outputs, recipient, before.asset_a) >= before.reserve_a,
    total_paid(self.outputs, recipient, before.asset_b) >= before.reserve_b,
    total_paid(self.outputs, recipient, ada) >= before.pool_lovelace,
  }
}

fn test_pool(reserve_a: Int, reserve_b: Int) -> PoolDatum {
  PoolDatum {
    pool_nft: AssetId { policy_id: "pool", asset_name: "nft" },
    asset_a: AssetId { policy_id: "", asset_name: "" },
    asset_b: AssetId { policy_id: "token", asset_name: "B" },
    lp_token: AssetId { policy_id: "lp", asset_name: "LP" },
    fee_numerator: 997,
    fee_denominator: 1000,
    reserve_a,
    reserve_b,
    total_liquidity: 1_000_000,
    pool_lovelace: reserve_a,
  }
}

test swap_a_for_b_respects_fee_adjusted_bound() {
  valid_swap(
    test_pool(1_000_000, 1_000_000),
    test_pool(1_100_000, 910_000),
    90_000,
  )
}

test swap_rejects_excessive_output() {
  valid_swap(
    test_pool(1_000_000, 1_000_000),
    test_pool(1_100_000, 900_000),
    90_000,
  ) == False
}

test remove_liquidity_requires_matching_lp_burn() {
  valid_remove_liquidity(
    test_pool(1_000_000, 1_000_000),
    PoolDatum {
      pool_nft: AssetId { policy_id: "pool", asset_name: "nft" },
      asset_a: AssetId { policy_id: "", asset_name: "" },
      asset_b: AssetId { policy_id: "token", asset_name: "B" },
      lp_token: AssetId { policy_id: "lp", asset_name: "LP" },
      fee_numerator: 997,
      fee_denominator: 1000,
      reserve_a: 900_000,
      reserve_b: 900_000,
      total_liquidity: 900_000,
      pool_lovelace: 900_000,
    },
    100_000,
    100_000,
    assets.zero |> assets.add("lp", "LP", -100_000),
  )
}

test add_liquidity_rejects_excessive_lp_mint() {
  valid_add_liquidity(
    test_pool(1_000_000, 1_000_000),
    PoolDatum {
      pool_nft: AssetId { policy_id: "pool", asset_name: "nft" },
      asset_a: AssetId { policy_id: "", asset_name: "" },
      asset_b: AssetId { policy_id: "token", asset_name: "B" },
      lp_token: AssetId { policy_id: "lp", asset_name: "LP" },
      fee_numerator: 997,
      fee_denominator: 1000,
      reserve_a: 1_100_000,
      reserve_b: 1_100_000,
      total_liquidity: 1_100_001,
      pool_lovelace: 1_100_000,
    },
    100_001,
    assets.zero |> assets.add("lp", "LP", 100_001),
  ) == False
}
