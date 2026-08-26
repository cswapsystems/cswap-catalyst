use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use cardano/address.{Address}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use ebecca/types.{
  AssetClass, AssetConfig, OracleDatum, PolicyConfig, Quote, RegistryDatum,
  VaultDatum, add, asset_config_for, asset_exposure_of, has_at_least, has_one,
  policy_config_for, policy_exposure_of, quantity_of, quote_is_sane,
  quote_trade_cap, ratio_value, resolve_quote, stricter_positive_cap,
}

const basis_points: Int = 10_000

pub type MarketplaceRedeemer {
  AddLiquidity {
    amount: Int,
    lp_minted: Int,
    provider: Address,
    next: VaultDatum,
  }
  RemoveLiquidity {
    amount: Int,
    lp_burned: Int,
    provider: Address,
    next: VaultDatum,
  }
  SellRwa {
    rwa: AssetClass,
    quantity: Int,
    seller: Address,
    min_payout: Int,
    next: VaultDatum,
  }
  BuyRwa {
    rwa: AssetClass,
    quantity: Int,
    buyer: Address,
    max_payment: Int,
    next: VaultDatum,
  }
  OperatorSettle {
    rwa: AssetClass,
    quantity: Int,
    operator: Address,
    next: VaultDatum,
  }
  AdminUpdate { next: VaultDatum }
  AdminClose
}

fn paid_at_least(
  outputs: List<Output>,
  recipient: Address,
  asset: AssetClass,
  amount: Int,
) -> Bool {
  list.any(
    outputs,
    fn(output) {
      output.address == recipient && (
        output.value |> has_at_least(asset, amount)
      )
    },
  )
}

fn paid_if_required(
  outputs: List<Output>,
  recipient: Address,
  asset: AssetClass,
  amount: Int,
) -> Bool {
  if amount <= 0 {
    True
  } else {
    paid_at_least(outputs, recipient, asset, amount)
  }
}

fn output_datum_is(output: Output, datum: VaultDatum) -> Bool {
  when output.datum is {
    InlineDatum(data) -> {
      expect output_datum: VaultDatum = data
      output_datum == datum
    }
    _ -> False
  }
}

fn find_vault_output(
  outputs: List<Output>,
  address: Address,
  datum: VaultDatum,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      and {
        output.address == address,
        output.value |> has_one(datum.vault_token),
        output |> output_datum_is(datum),
      }
    },
  )
}

fn registry_from_reference(
  reference_inputs: List<Input>,
  registry_token: AssetClass,
) -> Option<RegistryDatum> {
  list.find_map(
    reference_inputs,
    fn(input) {
      if input.output.value |> has_one(registry_token) {
        when input.output.datum is {
          InlineDatum(data) -> {
            expect datum: RegistryDatum = data
            Some(datum)
          }
          _ -> None
        }
      } else {
        None
      }
    },
  )
}

fn oracle_from_reference(
  reference_inputs: List<Input>,
  oracle_token: AssetClass,
) -> Option<OracleDatum> {
  list.find_map(
    reference_inputs,
    fn(input) {
      if input.output.value |> has_one(oracle_token) {
        when input.output.datum is {
          InlineDatum(data) -> {
            expect datum: OracleDatum = data
            Some(datum)
          }
          _ -> None
        }
      } else {
        None
      }
    },
  )
}

fn quote_is_supported(registry: RegistryDatum, quote: AssetClass) -> Bool {
  list.has(registry.quote_assets, quote)
}

fn asset_config_allows_sell(config: Option<AssetConfig>) -> Bool {
  when config is {
    Some(asset_config) -> and {
        asset_config.active,
        !asset_config.frozen,
        !asset_config.defaulted,
        !asset_config.redeemed,
        asset_config.sell_enabled,
      }
    None -> True
  }
}

fn asset_config_allows_buy(config: Option<AssetConfig>) -> Bool {
  when config is {
    Some(asset_config) -> and {
        asset_config.active,
        !asset_config.frozen,
        !asset_config.defaulted,
        !asset_config.redeemed,
        asset_config.buy_enabled,
      }
    None -> True
  }
}

fn asset_trade_cap(config: Option<AssetConfig>) -> Int {
  when config is {
    Some(asset_config) -> asset_config.max_trade_value
    None -> 0
  }
}

fn asset_exposure_cap(config: Option<AssetConfig>) -> Int {
  when config is {
    Some(asset_config) -> asset_config.max_asset_exposure_value
    None -> 0
  }
}

fn cap_allows(value: Int, cap: Int) -> Bool {
  if cap <= 0 {
    True
  } else {
    value <= cap
  }
}

fn same_pool_config(current: VaultDatum, next: VaultDatum) -> Bool {
  and {
    next.admin == current.admin,
    next.vault_token == current.vault_token,
    next.registry_token == current.registry_token,
    next.oracle_token == current.oracle_token,
    next.lp_token == current.lp_token,
    next.settlement_asset == current.settlement_asset,
    next.fee_bps == current.fee_bps,
    next.protocol_fee_bps == current.protocol_fee_bps,
    next.min_cash_reserve == current.min_cash_reserve,
    next.max_total_rwa_exposure == current.max_total_rwa_exposure,
    next.treasury == current.treasury,
    next.paused == current.paused,
  }
}

fn admin_update_preserves_state(current: VaultDatum, next: VaultDatum) -> Bool {
  and {
    next.admin == current.admin,
    next.vault_token == current.vault_token,
    next.registry_token == current.registry_token,
    next.oracle_token == current.oracle_token,
    next.lp_token == current.lp_token,
    next.settlement_asset == current.settlement_asset,
    next.total_lp_supply == current.total_lp_supply,
    next.total_rwa_exposure == current.total_rwa_exposure,
    next.policy_exposures == current.policy_exposures,
    next.asset_exposures == current.asset_exposures,
    next.fee_bps >= 0,
    next.protocol_fee_bps >= 0,
    next.fee_bps + next.protocol_fee_bps < basis_points,
    next.min_cash_reserve >= 0,
    next.max_total_rwa_exposure >= 0,
  }
}

fn unchanged_exposures(current: VaultDatum, next: VaultDatum) -> Bool {
  and {
    next.total_rwa_exposure == current.total_rwa_exposure,
    next.policy_exposures == current.policy_exposures,
    next.asset_exposures == current.asset_exposures,
  }
}

fn oracle_is_valid(
  tx: Transaction,
  oracle: OracleDatum,
  oracle_token: AssetClass,
  settlement: AssetClass,
) -> Bool {
  and {
    oracle.oracle_token == oracle_token,
    oracle.quote == settlement,
    tx.validity_range |> interval.is_entirely_before(oracle.valid_until),
  }
}

fn fee_amount(amount: Int, fee_bps: Int) -> Int {
  amount * fee_bps / basis_points
}

fn minted_lp_amount(tx: Transaction, lp_token: AssetClass) -> Int {
  tx.mint |> quantity_of(lp_token)
}

fn no_lp_mint_or_burn(tx: Transaction, lp_token: AssetClass) -> Bool {
  minted_lp_amount(tx, lp_token) == 0
}

fn pool_cash(output: Output, vault: VaultDatum) -> Int {
  output.value |> quantity_of(vault.settlement_asset)
}

fn expected_lp_mint(vault: VaultDatum, own_input: Output, amount: Int) -> Int {
  if vault.total_lp_supply == 0 {
    amount
  } else {
    amount * vault.total_lp_supply / (
      pool_cash(own_input, vault) + vault.total_rwa_exposure
    )
  }
}

fn expected_withdraw_amount(
  vault: VaultDatum,
  own_input: Output,
  lp_burned: Int,
) -> Int {
  lp_burned * ( pool_cash(own_input, vault) - vault.min_cash_reserve ) / vault.total_lp_supply
}

fn sell_controls(
  registry: RegistryDatum,
  policy: PolicyConfig,
  config: Option<AssetConfig>,
) -> Bool {
  and {
    !registry.paused,
    policy.active,
    policy.sell_enabled,
    asset_config_allows_sell(config),
  }
}

fn buy_controls(
  registry: RegistryDatum,
  policy: PolicyConfig,
  config: Option<AssetConfig>,
) -> Bool {
  and {
    !registry.paused,
    policy.active,
    policy.buy_enabled,
    asset_config_allows_buy(config),
  }
}

fn check_exposure_increase(
  current: VaultDatum,
  next: VaultDatum,
  policy: PolicyConfig,
  config: Option<AssetConfig>,
  rwa: AssetClass,
  delta: Int,
) -> Bool {
  let policy_after = policy_exposure_of(next.policy_exposures, rwa.policy_id)
  let asset_after = asset_exposure_of(next.asset_exposures, rwa)
  let policy_cap = policy.max_policy_exposure_value
  let asset_cap = asset_exposure_cap(config)

  and {
    policy_after == policy_exposure_of(current.policy_exposures, rwa.policy_id) + delta,
    asset_after == asset_exposure_of(current.asset_exposures, rwa) + delta,
    next.total_rwa_exposure == current.total_rwa_exposure + delta,
    cap_allows(policy_after, policy_cap),
    cap_allows(asset_after, asset_cap),
    cap_allows(next.total_rwa_exposure, current.max_total_rwa_exposure),
  }
}

fn check_exposure_decrease(
  current: VaultDatum,
  next: VaultDatum,
  rwa: AssetClass,
  delta: Int,
) -> Bool {
  let policy_before =
    policy_exposure_of(current.policy_exposures, rwa.policy_id)
  let asset_before = asset_exposure_of(current.asset_exposures, rwa)

  and {
    policy_before >= delta,
    asset_before >= delta,
    current.total_rwa_exposure >= delta,
    policy_exposure_of(next.policy_exposures, rwa.policy_id) == policy_before - delta,
    asset_exposure_of(next.asset_exposures, rwa) == asset_before - delta,
    next.total_rwa_exposure == current.total_rwa_exposure - delta,
  }
}

validator marketplace {
  spend(
    datum: Option<VaultDatum>,
    redeemer: MarketplaceRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(vault) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    let admin: VerificationKeyHash = vault.admin
    let signed_by_admin = list.has(tx.extra_signatories, admin)
    let input_has_vault_token =
      own_input.output.value |> has_one(vault.vault_token)

    when redeemer is {
      AddLiquidity { amount, lp_minted, provider, next } -> {
        expect Some(registry) =
          registry_from_reference(tx.reference_inputs, vault.registry_token)
        expect Some(own_output) =
          find_vault_output(tx.outputs, own_input.output.address, next)

        let expected_mint = expected_lp_mint(vault, own_input.output, amount)

        and {
          input_has_vault_token,
          !vault.paused,
          !registry.paused,
          amount > 0,
          pool_cash(own_input.output, vault) + vault.total_rwa_exposure > 0 || vault.total_lp_supply == 0,
          same_pool_config(vault, next),
          unchanged_exposures(vault, next),
          next.total_lp_supply == vault.total_lp_supply + lp_minted,
          lp_minted == expected_mint,
          quote_is_supported(registry, vault.settlement_asset),
          own_output.value == add(
            own_input.output.value,
            vault.settlement_asset,
            amount,
          ),
          minted_lp_amount(tx, vault.lp_token) == lp_minted,
          paid_at_least(tx.outputs, provider, vault.lp_token, lp_minted),
        }
      }

      RemoveLiquidity { amount, lp_burned, provider, next } -> {
        expect Some(registry) =
          registry_from_reference(tx.reference_inputs, vault.registry_token)
        expect Some(own_output) =
          find_vault_output(tx.outputs, own_input.output.address, next)

        let withdrawable =
          pool_cash(own_input.output, vault) - vault.min_cash_reserve
        let expected_amount =
          expected_withdraw_amount(vault, own_input.output, lp_burned)

        and {
          input_has_vault_token,
          !vault.paused,
          !registry.paused,
          amount > 0,
          lp_burned > 0,
          withdrawable >= amount,
          vault.total_lp_supply > 0,
          lp_burned <= vault.total_lp_supply,
          same_pool_config(vault, next),
          unchanged_exposures(vault, next),
          next.total_lp_supply == vault.total_lp_supply - lp_burned,
          amount == expected_amount,
          quote_is_supported(registry, vault.settlement_asset),
          own_output.value == add(
            own_input.output.value,
            vault.settlement_asset,
            -amount,
          ),
          pool_cash(own_output, vault) >= vault.min_cash_reserve,
          minted_lp_amount(tx, vault.lp_token) == -lp_burned,
          paid_at_least(tx.outputs, provider, vault.settlement_asset, amount),
        }
      }

      SellRwa { rwa, quantity, seller, min_payout, next } -> {
        expect Some(registry) =
          registry_from_reference(tx.reference_inputs, vault.registry_token)
        expect Some(oracle) =
          oracle_from_reference(tx.reference_inputs, vault.oracle_token)
        expect Some(policy) =
          policy_config_for(rwa.policy_id, registry.policies)
        expect Some(quote) = resolve_quote(oracle, rwa)
        expect Some(own_output) =
          find_vault_output(tx.outputs, own_input.output.address, next)

        let config = asset_config_for(rwa, registry.asset_configs)
        let gross = ratio_value(quote.bid, quantity)
        let nav_delta = ratio_value(quote.nav, quantity)
        let lp_fee = fee_amount(gross, vault.fee_bps)
        let protocol_fee = fee_amount(gross, vault.protocol_fee_bps)
        let net = gross - lp_fee - protocol_fee
        let trade_cap =
          quote_trade_cap(
            quote,
            stricter_positive_cap(
              policy.max_trade_value,
              asset_trade_cap(config),
            ),
          )

        and {
          input_has_vault_token,
          !vault.paused,
          quantity > 0,
          net >= min_payout,
          vault.fee_bps >= 0,
          vault.protocol_fee_bps >= 0,
          vault.fee_bps + vault.protocol_fee_bps < basis_points,
          quote_is_supported(registry, vault.settlement_asset),
          sell_controls(registry, policy, config),
          oracle_is_valid(
            tx,
            oracle,
            vault.oracle_token,
            vault.settlement_asset,
          ),
          quote_is_sane(quote),
          cap_allows(gross, trade_cap),
          check_exposure_increase(vault, next, policy, config, rwa, nav_delta),
          same_pool_config(vault, next),
          next.total_lp_supply == vault.total_lp_supply,
          own_input.output.value
            |> has_at_least(vault.settlement_asset, net + protocol_fee),
          own_output.value == add(
            add(own_input.output.value, rwa, quantity),
            vault.settlement_asset,
            -(net + protocol_fee),
          ),
          pool_cash(own_output, vault) >= vault.min_cash_reserve,
          paid_at_least(tx.outputs, seller, vault.settlement_asset, net),
          paid_if_required(
            tx.outputs,
            vault.treasury,
            vault.settlement_asset,
            protocol_fee,
          ),
          no_lp_mint_or_burn(tx, vault.lp_token),
        }
      }

      BuyRwa { rwa, quantity, buyer, max_payment, next } -> {
        expect Some(registry) =
          registry_from_reference(tx.reference_inputs, vault.registry_token)
        expect Some(oracle) =
          oracle_from_reference(tx.reference_inputs, vault.oracle_token)
        expect Some(policy) =
          policy_config_for(rwa.policy_id, registry.policies)
        expect Some(quote) = resolve_quote(oracle, rwa)
        expect Some(own_output) =
          find_vault_output(tx.outputs, own_input.output.address, next)

        let config = asset_config_for(rwa, registry.asset_configs)
        let gross = ratio_value(quote.ask, quantity)
        let nav_delta = ratio_value(quote.nav, quantity)
        let lp_fee = fee_amount(gross, vault.fee_bps)
        let protocol_fee = fee_amount(gross, vault.protocol_fee_bps)
        let total = gross + lp_fee + protocol_fee
        let pool_payment = gross + lp_fee
        let trade_cap =
          quote_trade_cap(
            quote,
            stricter_positive_cap(
              policy.max_trade_value,
              asset_trade_cap(config),
            ),
          )

        and {
          input_has_vault_token,
          !vault.paused,
          quantity > 0,
          total <= max_payment,
          quote_is_supported(registry, vault.settlement_asset),
          buy_controls(registry, policy, config),
          oracle_is_valid(
            tx,
            oracle,
            vault.oracle_token,
            vault.settlement_asset,
          ),
          quote_is_sane(quote),
          cap_allows(gross, trade_cap),
          check_exposure_decrease(vault, next, rwa, nav_delta),
          same_pool_config(vault, next),
          next.total_lp_supply == vault.total_lp_supply,
          own_input.output.value |> has_at_least(rwa, quantity),
          own_output.value == add(
            add(own_input.output.value, vault.settlement_asset, pool_payment),
            rwa,
            -quantity,
          ),
          paid_at_least(tx.outputs, buyer, rwa, quantity),
          paid_if_required(
            tx.outputs,
            vault.treasury,
            vault.settlement_asset,
            protocol_fee,
          ),
          no_lp_mint_or_burn(tx, vault.lp_token),
        }
      }

      OperatorSettle { rwa, quantity, operator, next } -> {
        expect Some(registry) =
          registry_from_reference(tx.reference_inputs, vault.registry_token)
        expect Some(oracle) =
          oracle_from_reference(tx.reference_inputs, vault.oracle_token)
        expect Some(policy) =
          policy_config_for(rwa.policy_id, registry.policies)
        expect Some(quote) = resolve_quote(oracle, rwa)
        expect Some(own_output) =
          find_vault_output(tx.outputs, own_input.output.address, next)

        let config = asset_config_for(rwa, registry.asset_configs)
        let settlement = ratio_value(quote.nav, quantity)

        and {
          signed_by_admin,
          input_has_vault_token,
          !vault.paused,
          quantity > 0,
          quote_is_supported(registry, vault.settlement_asset),
          buy_controls(registry, policy, config),
          oracle_is_valid(
            tx,
            oracle,
            vault.oracle_token,
            vault.settlement_asset,
          ),
          quote_is_sane(quote),
          check_exposure_decrease(vault, next, rwa, settlement),
          same_pool_config(vault, next),
          next.total_lp_supply == vault.total_lp_supply,
          own_input.output.value |> has_at_least(rwa, quantity),
          own_output.value == add(
            add(own_input.output.value, vault.settlement_asset, settlement),
            rwa,
            -quantity,
          ),
          paid_at_least(tx.outputs, operator, rwa, quantity),
          no_lp_mint_or_burn(tx, vault.lp_token),
        }
      }

      AdminUpdate { next } -> {
        expect Some(own_output) =
          find_vault_output(tx.outputs, own_input.output.address, next)

        and {
          signed_by_admin,
          input_has_vault_token,
          admin_update_preserves_state(vault, next),
          pool_cash(own_output, next) >= next.min_cash_reserve,
          no_lp_mint_or_burn(tx, vault.lp_token),
        }
      }

      AdminClose -> and {
          input_has_vault_token,
          signed_by_admin,
          no_lp_mint_or_burn(tx, vault.lp_token),
        }
    }
  }

  else(_) {
    fail
  }
}
