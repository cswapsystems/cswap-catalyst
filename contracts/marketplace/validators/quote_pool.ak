use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, find_input}
use ebecca/types.{
  AssetClass, Direct, InstantSell, PoolAssetPrice, PoolExit, QuotePool, QuotePoolDatum, Ratio,
  SimpleListingDatum, ada, has_one, quantity_of, ratio_value,
}

/// Actions for reserve funding, LP accounting, listing settlement, and closure.
pub type QuotePoolRedeemer {
  AddLiquidity {
    amount: Int,
    lp_minted: Int,
    provider: Address,
    provider_key: VerificationKeyHash,
    next: QuotePoolDatum,
  }
  AddFunds { amount: Int, next: QuotePoolDatum }
  RemoveLiquidity {
    amount: Int,
    lp_burned: Int,
    provider: Address,
    provider_key: VerificationKeyHash,
    next: QuotePoolDatum,
  }
  StartLpExit {
    amount: Int,
    provider: Address,
    provider_key: VerificationKeyHash,
    next: QuotePoolDatum,
  }
  ReturnClosingInventory {
    listing: SimpleListingDatum,
    next: QuotePoolDatum,
  }
  CompleteLpExit
  BatcherAcquire {
    inventory: SimpleListingDatum,
    next: QuotePoolDatum,
  }
  InventorySale {
    buyer: Address,
    next: QuotePoolDatum,
  }
  Reprice { listing: SimpleListingDatum, next: QuotePoolDatum }
  UpdatePrices { next: QuotePoolDatum }
  AdminUpdate { next: QuotePoolDatum }
  AdminClose
}

fn signed(tx: Transaction, key: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, key)
}

fn paid_to_key(address: Address, key: VerificationKeyHash) -> Bool {
  when address.payment_credential is {
    address.VerificationKey(payment_key) -> payment_key == key
    _ -> False
  }
}

fn minted(tx: Transaction, asset: AssetClass) -> Int {
  tx.mint |> quantity_of(asset)
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
      output.address == recipient && (output.value |> quantity_of(asset)) >= amount
    },
  )
}

fn pool_datum(output: Output) -> Option<QuotePoolDatum> {
  when output.datum is {
    InlineDatum(data) -> {
      expect pool: QuotePoolDatum = data
      Some(pool)
    }
    _ -> None
  }
}

fn output_has_pool_datum(output: Output, datum: QuotePoolDatum) -> Bool {
  and {
    output.value |> has_one(datum.pool_token),
    when pool_datum(output) is {
      Some(found) -> found == datum
      None -> False
    },
  }
}

fn find_pool_output(
  outputs: List<Output>,
  address: Address,
  datum: QuotePoolDatum,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      output.address == address && output_has_pool_datum(output, datum)
    },
  )
}

fn listing_datum(output: Output) -> Option<SimpleListingDatum> {
  when output.datum is {
    InlineDatum(data) -> {
      expect listing: SimpleListingDatum = data
      Some(listing)
    }
    _ -> None
  }
}

/// Orderbook inputs settling against this pool: pool-owned inventory
/// (`inventory == True`) or Instant Sell requests. Sale, acquisition and
/// closure transitions require exactly one so the pool's accounting and
/// payment checks cannot be shared across several listings.
fn pool_orderbook_inputs(
  inputs: List<Input>,
  address: Address,
  pool_token: AssetClass,
  inventory: Bool,
) -> List<Input> {
  list.filter(
    inputs,
    fn(input) {
      input.output.address == address && when listing_datum(input.output) is {
        Some(found) ->
          when found.settlement is {
            QuotePool { pool_token: listed, inventory_token: _, acquisition_cost: _ } ->
              inventory && listed == pool_token
            InstantSell { pool_token: listed } -> !inventory && listed == pool_token
            Direct -> False
          }
        None -> False
      }
    },
  )
}

fn find_orderbook_output(
  outputs: List<Output>,
  address: Address,
  datum: SimpleListingDatum,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      output.address == address
        && when listing_datum(output) is {
          Some(listing) -> listing == datum
          None -> False
        }
    },
  )
}

fn listing_value(listing: SimpleListingDatum, locked_lovelace: Int) -> assets.Value {
  let value =
    assets.from_lovelace(locked_lovelace)
      |> assets.add(listing.rwa.policy_id, listing.rwa.asset_name, listing.quantity)

  when listing.settlement is {
    Direct -> value
    InstantSell { pool_token: _ } -> value
    QuotePool { pool_token: _, inventory_token, acquisition_cost: _ } ->
      value
        |> assets.add(
          inventory_token.policy_id,
          inventory_token.asset_name,
          1,
        )
  }
}

fn quote_for(asset: AssetClass, prices: List<PoolAssetPrice>) -> Option<PoolAssetPrice> {
  list.find(prices, fn(price) { price.asset == asset })
}

fn valid_ratio(ratio: Ratio) -> Bool {
  ratio.numerator > 0 && ratio.denominator > 0
}

fn valid_prices(prices: List<PoolAssetPrice>) -> Bool {
  and {
    list.length(prices) <= 50,
    list.length(list.unique(list.map(prices, fn(price) { price.asset }))) == list.length(prices),
    list.all(
      prices,
      fn(price) {
        price.asset != ada()
          && valid_ratio(price.buy_price)
          && valid_ratio(price.sell_price)
      },
    ),
  }
}

fn pool_cash(output: Output, pool: QuotePoolDatum) -> Int {
  output.value |> quantity_of(pool.quote_asset)
}

fn pool_equity_cost_basis(output: Output, pool: QuotePoolDatum) -> Int {
  pool_cash(output, pool) + pool.inventory_cost
}

fn prices_unchanged(current: QuotePoolDatum, next: QuotePoolDatum) -> Bool {
  next.prices == current.prices
}

fn accounting_unchanged(current: QuotePoolDatum, next: QuotePoolDatum) -> Bool {
  and {
    next.inventory_cost == current.inventory_cost,
    next.inventory_value == current.inventory_value,
    next.inventory_count == current.inventory_count,
  }
}

fn identity_unchanged(current: QuotePoolDatum, next: QuotePoolDatum) -> Bool {
  and {
    next.admin == current.admin,
    next.batcher == current.batcher,
    next.pool_token == current.pool_token,
    next.lp_token == current.lp_token,
    next.inventory_token == current.inventory_token,
    next.quote_asset == current.quote_asset,
  }
}

fn pool_can_pay(input: Output, pool: QuotePoolDatum, amount: Int) -> Bool {
  pool_cash(input, pool) >= amount + pool.min_cash_reserve
}

fn inventory_listing_is_bound(
  listing: SimpleListingDatum,
  pool: QuotePoolDatum,
  pool_address: Address,
) -> Bool {
  when listing.settlement is {
    QuotePool { pool_token, inventory_token, acquisition_cost } -> and {
      pool_token == pool.pool_token,
      inventory_token == pool.inventory_token,
      acquisition_cost > 0,
      listing.seller == pool_address,
      listing.seller_key == pool.batcher,
      listing.price_asset == pool.quote_asset,
    }
    _ -> False
  }
}

fn expected_lp_mint(pool: QuotePoolDatum, input: Output, amount: Int) -> Int {
  if pool.total_lp_supply == 0 {
    amount + pool_equity_cost_basis(input, pool)
  } else {
    amount * pool.total_lp_supply / pool_equity_cost_basis(input, pool)
  }
}

fn has_no_pool_continuation(
  outputs: List<Output>,
  address: Address,
  pool_token: AssetClass,
) -> Bool {
  list.all(
    outputs,
    fn(output) {
      !(output.address == address && (output.value |> has_one(pool_token)))
    },
  )
}

/// Shared quote reserve, LP ledger, and pool-owned listing accounting.
/// The orderbook address is fixed so pool transitions can authenticate the
/// corresponding listing inputs and outputs.
validator quote_pool(orderbook_address: Address) {
  spend(
    datum: Option<QuotePoolDatum>,
    redeemer: QuotePoolRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(pool) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)
    let pool_address = own_input.output.address
    let pool_token_is_held = own_input.output.value |> has_one(pool.pool_token)

    when redeemer is {
      AddLiquidity { amount, lp_minted, provider, provider_key, next } -> {
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        let equity = pool_equity_cost_basis(own_input.output, pool)
        let expected_mint = expected_lp_mint(pool, own_input.output, amount)

        and {
          pool_token_is_held,
          !pool.paused,
          pool.closing == None,
          amount > 0,
          pool.total_lp_supply == 0 || equity > 0,
          pool.total_lp_supply != 0 || and {
            pool.inventory_count == 0,
            pool.inventory_cost == 0,
            pool.inventory_value == 0,
          },
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          accounting_unchanged(pool, next),
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          next.total_lp_supply == pool.total_lp_supply + lp_minted,
          lp_minted == expected_mint,
          lp_minted > 0,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            amount,
          ),
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.lp_token) == lp_minted,
          paid_to_key(provider, provider_key),
          signed(tx, provider_key),
          paid_at_least(tx.outputs, provider, pool.lp_token, lp_minted),
        }
      }

      AddFunds { amount, next } -> {
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)

        and {
          pool_token_is_held,
          pool.closing == None,
          amount > 0,
          minted(tx, pool.lp_token) == 0,
          minted(tx, pool.inventory_token) == 0,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          accounting_unchanged(pool, next),
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            amount,
          ),
        }
      }

      RemoveLiquidity { amount, lp_burned, provider, provider_key, next } -> {
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        let withdrawable = pool_cash(own_input.output, pool) - pool.min_cash_reserve
        let expected_amount = lp_burned * withdrawable / pool.total_lp_supply

        and {
          pool_token_is_held,
          pool.closing == None,
          pool.total_lp_supply > 0,
          lp_burned > 0,
          lp_burned < pool.total_lp_supply,
          withdrawable >= 0,
          amount == expected_amount,
          amount >= 0,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          accounting_unchanged(pool, next),
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          next.total_lp_supply == pool.total_lp_supply - lp_burned,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            -amount,
          ),
          minted(tx, pool.lp_token) == -lp_burned,
          minted(tx, pool.inventory_token) == 0,
          paid_to_key(provider, provider_key),
          signed(tx, provider_key),
          if amount == 0 {
            True
          } else {
            paid_at_least(tx.outputs, provider, pool.quote_asset, amount)
          },
        }
      }

      StartLpExit { amount, provider, provider_key, next } -> {
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        let withdrawable = pool_cash(own_input.output, pool) - pool.min_cash_reserve

        and {
          pool_token_is_held,
          pool.closing == None,
          pool.total_lp_supply > 0,
          withdrawable >= 0,
          amount == withdrawable,
          next.closing == Some(PoolExit { recipient: provider, provider_key }),
          next.total_lp_supply == 0,
          next.inventory_cost == pool.inventory_cost,
          next.inventory_value == pool.inventory_value,
          next.inventory_count == pool.inventory_count,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            -amount,
          ),
          paid_to_key(provider, provider_key),
          signed(tx, provider_key),
          minted(tx, pool.lp_token) == -pool.total_lp_supply,
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.pool_token) == 0,
          if amount == 0 {
            True
          } else {
            paid_at_least(tx.outputs, provider, pool.quote_asset, amount)
          },
        }
      }

      ReturnClosingInventory { listing, next } -> {
        expect [listing_input] =
          pool_orderbook_inputs(tx.inputs, orderbook_address, pool.pool_token, True)
        expect Some(current_listing) = listing_datum(listing_input.output)
        expect QuotePool {
          pool_token: listing_pool_token,
          inventory_token: listing_inventory_token,
          acquisition_cost,
        } = current_listing.settlement
        expect Some(exit) = pool.closing
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        let locked_lovelace = listing_input.output.value |> quantity_of(ada())

        and {
          pool_token_is_held,
          pool.closing == Some(exit),
          pool.total_lp_supply == 0,
          inventory_listing_is_bound(current_listing, pool, pool_address),
          listing_pool_token == pool.pool_token,
          listing_inventory_token == pool.inventory_token,
          current_listing.price > 0,
          acquisition_cost > 0,
          listing_input.output.value == listing_value(current_listing, locked_lovelace),
          listing.settlement == current_listing.settlement,
          listing.seller == current_listing.seller,
          listing.seller_key == current_listing.seller_key,
          listing.rwa == current_listing.rwa,
          listing.quantity == current_listing.quantity,
          listing.price_asset == current_listing.price_asset,
          listing.price == current_listing.price,
          next.closing == pool.closing,
          next.total_lp_supply == 0,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          next.inventory_cost == pool.inventory_cost - acquisition_cost,
          next.inventory_value == pool.inventory_value - current_listing.price,
          next.inventory_count == pool.inventory_count - 1,
          pool.inventory_count > 0,
          pool.inventory_cost >= acquisition_cost,
          pool.inventory_value >= current_listing.price,
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next_output.value == own_input.output.value,
          minted(tx, pool.inventory_token) == -1,
          minted(tx, pool.lp_token) == 0,
          list.all(tx.outputs, fn(output) {
            quantity_of(output.value, pool.inventory_token) == 0
          }),
          paid_at_least(tx.outputs, exit.recipient, listing.rwa, listing.quantity),
          paid_at_least(tx.outputs, exit.recipient, ada(), locked_lovelace),
        }
      }

      CompleteLpExit -> {
        expect Some(exit) = pool.closing

        and {
          pool_token_is_held,
          pool.total_lp_supply == 0,
          pool.inventory_count == 0,
          pool.inventory_cost == 0,
          pool.inventory_value == 0,
          list.all(tx.outputs, fn(output) {
            quantity_of(output.value, pool.inventory_token) == 0
          }),
          paid_to_key(exit.recipient, exit.provider_key),
          signed(tx, exit.provider_key),
          minted(tx, pool.lp_token) == 0,
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.pool_token) == -1,
          has_no_pool_continuation(tx.outputs, pool_address, pool.pool_token),
          paid_at_least(
            tx.outputs,
            exit.recipient,
            pool.quote_asset,
            pool_cash(own_input.output, pool),
          ),
          if pool.quote_asset == ada() {
            True
          } else {
            paid_at_least(
              tx.outputs,
              exit.recipient,
              ada(),
              own_input.output.value |> quantity_of(ada()),
            )
          },
        }
      }

      BatcherAcquire { inventory, next } -> {
        expect [listing_input] =
          pool_orderbook_inputs(tx.inputs, orderbook_address, pool.pool_token, False)
        expect Some(listing) = listing_datum(listing_input.output)
        expect InstantSell { pool_token } = listing.settlement
        expect Some(price) = quote_for(listing.rwa, pool.prices)
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        expect Some(inventory_output) = find_orderbook_output(
          tx.outputs,
          orderbook_address,
          inventory,
        )
        let listing_locked_lovelace = listing_input.output.value |> quantity_of(ada())
        let inventory_locked_lovelace = inventory_output.value |> quantity_of(ada())
        let payout = ratio_value(price.buy_price, listing.quantity)
        let ask = ratio_value(price.sell_price, listing.quantity)

        and {
          pool_token_is_held,
          !pool.paused,
          pool.closing == None,
          signed(tx, pool.batcher),
          listing.quantity > 0,
          listing.rwa != ada(),
          pool_token == pool.pool_token,
          listing.price_asset == pool.quote_asset,
          listing.price > 0,
          listing_input.output.value == (assets.from_lovelace(listing_locked_lovelace)
            |> assets.add(listing.rwa.policy_id, listing.rwa.asset_name, listing.quantity)),
          payout >= listing.price,
          payout > 0,
          pool_can_pay(own_input.output, pool, payout),
          inventory_listing_is_bound(inventory, pool, pool_address),
          inventory.rwa == listing.rwa,
          inventory.quantity == listing.quantity,
          inventory.price == ask,
          inventory.price > 0,
          inventory_locked_lovelace > 0,
          inventory_output.value == listing_value(inventory, inventory_locked_lovelace),
          inventory.settlement == QuotePool {
            pool_token: pool.pool_token,
            inventory_token: pool.inventory_token,
            acquisition_cost: payout,
          },
          valid_prices(pool.prices),
          minted(tx, pool.lp_token) == 0,
          minted(tx, pool.inventory_token) == 1,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          next.inventory_cost == pool.inventory_cost + payout,
          next.inventory_value == pool.inventory_value + inventory.price,
          next.inventory_count == pool.inventory_count + 1,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            -payout,
          ),
        }
      }

      InventorySale { buyer, next } -> {
        expect [listing_input] =
          pool_orderbook_inputs(tx.inputs, orderbook_address, pool.pool_token, True)
        expect Some(listing) = listing_datum(listing_input.output)
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        let locked_lovelace = listing_input.output.value |> quantity_of(ada())
        expect QuotePool { acquisition_cost, .. } = listing.settlement

        and {
          pool_token_is_held,
          !pool.paused,
          pool.closing == None,
          inventory_listing_is_bound(listing, pool, pool_address),
          listing.quantity > 0,
          listing.price > 0,
          listing_input.output.value == listing_value(listing, locked_lovelace),
          minted(tx, pool.inventory_token) == -1,
          minted(tx, pool.lp_token) == 0,
          paid_at_least(tx.outputs, buyer, listing.rwa, listing.quantity),
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          pool.inventory_count > 0,
          pool.inventory_cost >= acquisition_cost,
          pool.inventory_value >= listing.price,
          next.inventory_cost == pool.inventory_cost - acquisition_cost,
          next.inventory_value == pool.inventory_value - listing.price,
          next.inventory_count == pool.inventory_count - 1,
          next_output.value == assets.add(
            assets.add(
              own_input.output.value,
              pool.quote_asset.policy_id,
              pool.quote_asset.asset_name,
              listing.price,
            ),
            assets.ada_policy_id,
            assets.ada_asset_name,
            locked_lovelace,
          ),
          paid_at_least(tx.outputs, pool_address, pool.quote_asset, listing.price),
          quantity_of(next_output.value, pool.quote_asset) >= pool.min_cash_reserve,
        }
      }

      Reprice { listing, next } -> {
        expect [listing_input] =
          pool_orderbook_inputs(tx.inputs, orderbook_address, pool.pool_token, True)
        expect Some(current_listing) = listing_datum(listing_input.output)
        expect QuotePool {
          pool_token: listing_pool_token,
          inventory_token: _inventory_token,
          acquisition_cost,
        } = current_listing.settlement
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)
        expect Some(next_listing_output) = find_orderbook_output(
          tx.outputs,
          orderbook_address,
          listing,
        )
        let locked_lovelace = listing_input.output.value |> quantity_of(ada())

        and {
          pool_token_is_held,
          !pool.paused,
          pool.closing == None,
          signed(tx, pool.batcher),
          inventory_listing_is_bound(current_listing, pool, pool_address),
          listing_pool_token == pool.pool_token,
          acquisition_cost > 0,
          current_listing.price > 0,
          listing.price > 0,
          listing.settlement == current_listing.settlement,
          listing.seller == current_listing.seller,
          listing.seller_key == current_listing.seller_key,
          listing.rwa == current_listing.rwa,
          listing.quantity == current_listing.quantity,
          listing.price_asset == current_listing.price_asset,
          listing_input.output.value == listing_value(current_listing, locked_lovelace),
          next_listing_output.value == listing_value(listing, locked_lovelace),
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          next.inventory_cost == pool.inventory_cost,
          pool.inventory_value >= current_listing.price,
          next.inventory_value == pool.inventory_value - current_listing.price
            + listing.price,
          next.inventory_count == pool.inventory_count,
          next_output.value == own_input.output.value,
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.lp_token) == 0,
        }
      }

      UpdatePrices { next } -> {
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)

        and {
          pool_token_is_held,
          pool.closing == None,
          signed(tx, pool.batcher),
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.lp_token) == 0,
          identity_unchanged(pool, next),
          valid_prices(next.prices),
          accounting_unchanged(pool, next),
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve == pool.min_cash_reserve,
          next.paused == pool.paused,
          next.closing == None,
          next_output.value == own_input.output.value,
        }
      }

      AdminUpdate { next } -> {
        expect Some(next_output) = find_pool_output(tx.outputs, pool_address, next)

        and {
          pool_token_is_held,
          pool.closing == None,
          signed(tx, pool.admin),
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.lp_token) == 0,
          identity_unchanged(pool, next),
          prices_unchanged(pool, next),
          accounting_unchanged(pool, next),
          next.total_lp_supply == pool.total_lp_supply,
          next.min_cash_reserve >= 0,
          next.closing == None,
          next_output.value == own_input.output.value,
        }
      }

      AdminClose -> {
        and {
          pool_token_is_held,
          signed(tx, pool.admin),
          pool.closing == None,
          pool.total_lp_supply == 0,
          pool.inventory_count == 0,
          pool.inventory_cost == 0,
          pool.inventory_value == 0,
          minted(tx, pool.lp_token) == 0,
          minted(tx, pool.inventory_token) == 0,
          minted(tx, pool.pool_token) == -1,
          has_no_pool_continuation(tx.outputs, pool_address, pool.pool_token),
        }
      }
    }
  }

  else(_) {
    fail
  }
}

// Regression fixtures: InventorySale settles exactly one pool-owned listing.
const reg_pool_address: Address =
  address.Address {
    payment_credential: address.Script(
      #"11111111111111111111111111111111111111111111111111111111",
    ),
    stake_credential: None,
  }

const reg_orderbook_address: Address =
  address.Address {
    payment_credential: address.Script(
      #"22222222222222222222222222222222222222222222222222222222",
    ),
    stake_credential: None,
  }

const reg_buyer: Address =
  address.Address {
    payment_credential: address.VerificationKey(
      #"33333333333333333333333333333333333333333333333333333333",
    ),
    stake_credential: None,
  }

const reg_batcher: VerificationKeyHash =
  #"99999999999999999999999999999999999999999999999999999999"

const reg_pool_token: AssetClass =
  AssetClass {
    policy_id: #"55555555555555555555555555555555555555555555555555555555",
    asset_name: "POOL",
  }

const reg_inventory_token: AssetClass =
  AssetClass {
    policy_id: #"77777777777777777777777777777777777777777777777777777777",
    asset_name: "INV",
  }

const reg_rwa: AssetClass =
  AssetClass {
    policy_id: #"88888888888888888888888888888888888888888888888888888888",
    asset_name: "RWA",
  }

fn reg_ref(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: index,
  }
}

fn reg_pool(inventory_count: Int) -> QuotePoolDatum {
  QuotePoolDatum {
    admin: reg_batcher,
    batcher: reg_batcher,
    pool_token: reg_pool_token,
    lp_token: AssetClass {
      policy_id: #"66666666666666666666666666666666666666666666666666666666",
      asset_name: "LP",
    },
    inventory_token: reg_inventory_token,
    quote_asset: ada(),
    prices: [],
    total_lp_supply: 100_000_000,
    min_cash_reserve: 5_000_000,
    paused: False,
    inventory_cost: 40_000_000 * inventory_count,
    inventory_value: 50_000_000 * inventory_count,
    inventory_count,
    closing: None,
  }
}

fn reg_listing() -> SimpleListingDatum {
  SimpleListingDatum {
    seller: reg_pool_address,
    seller_key: reg_batcher,
    settlement: QuotePool {
      pool_token: reg_pool_token,
      inventory_token: reg_inventory_token,
      acquisition_cost: 40_000_000,
    },
    rwa: reg_rwa,
    quantity: 1,
    price_asset: ada(),
    price: 50_000_000,
  }
}

fn reg_pool_value(lovelace: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.add(reg_pool_token.policy_id, reg_pool_token.asset_name, 1)
}

fn reg_listing_input(index: Int) -> Input {
  Input {
    output_reference: reg_ref(index),
    output: Output {
      address: reg_orderbook_address,
      value: listing_value(reg_listing(), 2_000_000),
      datum: InlineDatum(reg_listing()),
      reference_script: None,
    },
  }
}

fn reg_sale(listing_count: Int) -> (QuotePoolDatum, QuotePoolDatum, Transaction) {
  let pool = reg_pool(listing_count)
  let next =
    QuotePoolDatum {
      ..pool,
      inventory_cost: pool.inventory_cost - 40_000_000,
      inventory_value: pool.inventory_value - 50_000_000,
      inventory_count: pool.inventory_count - 1,
    }
  let listings =
    list.map(list.range(1, listing_count), fn(index) { reg_listing_input(index) })
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: reg_ref(0),
          output: Output {
            address: reg_pool_address,
            value: reg_pool_value(100_000_000),
            datum: InlineDatum(pool),
            reference_script: None,
          },
        },
        ..listings
      ],
      outputs: [
        Output {
          address: reg_pool_address,
          value: reg_pool_value(152_000_000),
          datum: InlineDatum(next),
          reference_script: None,
        },
        Output {
          address: reg_buyer,
          value: assets.from_asset(reg_rwa.policy_id, reg_rwa.asset_name, 1),
          datum: transaction.NoDatum,
          reference_script: None,
        },
      ],
      mint: assets.from_asset(
        reg_inventory_token.policy_id,
        reg_inventory_token.asset_name,
        -1,
      ),
    }
  (pool, next, tx)
}

test inventory_sale_accepts_single_listing() {
  let (pool, next, tx) = reg_sale(1)
  quote_pool.spend(reg_orderbook_address, Some(pool), InventorySale { buyer: reg_buyer, next }, reg_ref(0), tx)
}

test inventory_sale_rejects_several_pool_listings() fail {
  let (pool, next, tx) = reg_sale(2)
  quote_pool.spend(reg_orderbook_address, Some(pool), InventorySale { buyer: reg_buyer, next }, reg_ref(0), tx)
}
