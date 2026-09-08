use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, find_input}
use ebecca/types.{
  AssetClass, Direct, QuotePool, QuotePoolDatum, SimpleListingDatum, ada,
  has_one, quantity_of,
}

pub type QuotePoolRedeemer {
  AddLiquidity {
    amount: Int,
    lp_minted: Int,
    provider: Address,
    provider_key: VerificationKeyHash,
    next: QuotePoolDatum,
  }
  RemoveLiquidity {
    amount: Int,
    lp_burned: Int,
    provider: Address,
    provider_key: VerificationKeyHash,
    next: QuotePoolDatum,
  }
  BatcherAcquire {
    amount: Int,
    inventory: SimpleListingDatum,
    next: QuotePoolDatum,
  }
  InventorySale {
    amount: Int,
    buyer: Address,
    next: QuotePoolDatum,
  }
  AdminUpdate { next: QuotePoolDatum }
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
      output.address == recipient && (output.value |> quantity_of(asset)) >= amount
    },
  )
}

fn signed(tx: Transaction, key: VerificationKeyHash) -> Bool {
  list.has(tx.extra_signatories, key)
}

fn minted(tx: Transaction, asset: AssetClass) -> Int {
  tx.mint |> quantity_of(asset)
}

fn output_has_pool_datum(output: Output, datum: QuotePoolDatum) -> Bool {
  and {
    output.value |> has_one(datum.pool_token),
    when output.datum is {
      InlineDatum(data) -> {
        expect output_datum: QuotePoolDatum = data
        output_datum == datum
      }
      _ -> False
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

fn listing_from_output(output: Output) -> Option<SimpleListingDatum> {
  when output.datum is {
    InlineDatum(data) -> {
      expect listing: SimpleListingDatum = data
      Some(listing)
    }
    _ -> None
  }
}

fn find_listing_input(
  inputs: List<Input>,
  orderbook_address: Address,
) -> Option<Input> {
  list.find(
    inputs,
    fn(input) { input.output.address == orderbook_address },
  )
}

fn output_is_listing(
  output: Output,
  address: Address,
  listing: SimpleListingDatum,
) -> Bool {
  let locked_lovelace = output.value |> quantity_of(ada())
  and {
    output.address == address,
    output.value == listing_value(listing, locked_lovelace),
    when output.datum is {
      InlineDatum(data) -> {
        expect output_listing: SimpleListingDatum = data
        output_listing == listing
      }
      _ -> False
    },
  }
}

fn find_listing_output(
  outputs: List<Output>,
  address: Address,
  listing: SimpleListingDatum,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) { output_is_listing(output, address, listing) },
  )
}

fn listing_value(
  listing: SimpleListingDatum,
  locked_lovelace: Int,
) -> assets.Value {
  let value =
    assets.from_lovelace(locked_lovelace)
      |> assets.add(listing.rwa.policy_id, listing.rwa.asset_name, listing.quantity)

  when listing.settlement is {
    Direct -> value
    QuotePool { inventory_token, pool_token: _ } ->
      value
        |> assets.add(
          inventory_token.policy_id,
          inventory_token.asset_name,
          1,
        )
  }
}

fn listing_is_valid(listing: SimpleListingDatum) -> Bool {
  and {
    listing.quantity > 0,
    listing.price > 0,
    listing.rwa != ada(),
    listing.price_asset != listing.rwa,
  }
}

fn pool_payment(
  value: assets.Value,
  pool: QuotePoolDatum,
  amount: Int,
  locked_lovelace: Int,
) -> assets.Value {
  if pool.quote_asset == ada() {
    assets.add(value, assets.ada_policy_id, assets.ada_asset_name, amount + locked_lovelace)
  } else {
    value
      |> assets.add(
        pool.quote_asset.policy_id,
        pool.quote_asset.asset_name,
        amount,
      )
      |> assets.add(assets.ada_policy_id, assets.ada_asset_name, locked_lovelace)
  }
}

fn pool_cash(output: Output, pool: QuotePoolDatum) -> Int {
  output.value |> quantity_of(pool.quote_asset)
}

fn same_config(current: QuotePoolDatum, next: QuotePoolDatum) -> Bool {
  and {
    next.admin == current.admin,
    next.batcher == current.batcher,
    next.pool_token == current.pool_token,
    next.lp_token == current.lp_token,
    next.inventory_token == current.inventory_token,
    next.quote_asset == current.quote_asset,
    next.min_cash_reserve == current.min_cash_reserve,
    next.paused == current.paused,
  }
}

fn pool_continuation(
  outputs: List<Output>,
  address: Address,
  pool: QuotePoolDatum,
) -> Option<Output> {
  find_pool_output(outputs, address, pool)
}

fn no_open_inventory(pool: QuotePoolDatum, next: QuotePoolDatum) -> Bool {
  and {
    pool.inventory_value == 0,
    next.inventory_value == 0,
  }
}

fn inventory_listing_is_bound(
  listing: SimpleListingDatum,
  pool: QuotePoolDatum,
  pool_address: Address,
) -> Bool {
  when listing.settlement is {
    QuotePool { pool_token, inventory_token } -> and {
      pool_token == pool.pool_token,
      inventory_token == pool.inventory_token,
      listing.seller == pool_address,
      listing.seller_key == pool.batcher,
      listing.price_asset == pool.quote_asset,
    }
    Direct -> False
  }
}

fn pool_can_pay(
  input: Output,
  pool: QuotePoolDatum,
  amount: Int,
  locked_lovelace: Int,
) -> Bool {
  if pool.quote_asset == ada() {
    pool_cash(input, pool) >= amount + locked_lovelace
  } else {
    and {
      pool_cash(input, pool) >= amount,
      (input.value |> quantity_of(ada())) >= locked_lovelace,
    }
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

fn expected_lp_mint(
  pool: QuotePoolDatum,
  own_input: Output,
  amount: Int,
) -> Int {
  if pool.total_lp_supply == 0 {
    amount
  } else {
    amount * pool.total_lp_supply / pool_cash(own_input, pool)
  }
}

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
    let has_pool_token = own_input.output.value |> has_one(pool.pool_token)

    when redeemer is {
      AddLiquidity { amount, lp_minted, provider, provider_key, next } -> {
        expect Some(next_output) = pool_continuation(tx.outputs, pool_address, next)
        let expected_mint = expected_lp_mint(pool, own_input.output, amount)

        and {
          has_pool_token,
          !pool.paused,
          amount > 0,
          pool.quote_asset != ada() || amount > 0,
          pool.total_lp_supply == 0 || pool_cash(own_input.output, pool) > 0,
          no_open_inventory(pool, next),
          same_config(pool, next),
          next.total_lp_supply == pool.total_lp_supply + lp_minted,
          lp_minted == expected_mint,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            amount,
          ),
          minted(tx, pool.lp_token) == lp_minted,
          signed(tx, provider_key),
          paid_at_least(tx.outputs, provider, pool.lp_token, lp_minted),
        }
      }

      RemoveLiquidity { amount, lp_burned, provider, provider_key, next } -> {
        expect Some(next_output) = pool_continuation(tx.outputs, pool_address, next)
        let withdrawable = pool_cash(own_input.output, pool) - pool.min_cash_reserve
        let expected_amount =
          lp_burned * withdrawable / pool.total_lp_supply

        and {
          has_pool_token,
          !pool.paused,
          pool.total_lp_supply > 0,
          lp_burned > 0,
          no_open_inventory(pool, next),
          withdrawable >= 0,
          amount == expected_amount,
          amount > 0,
          same_config(pool, next),
          next.total_lp_supply == pool.total_lp_supply - lp_burned,
          next_output.value == assets.add(
            own_input.output.value,
            pool.quote_asset.policy_id,
            pool.quote_asset.asset_name,
            -amount,
          ),
          minted(tx, pool.lp_token) == -lp_burned,
          signed(tx, provider_key),
          paid_at_least(tx.outputs, provider, pool.quote_asset, amount),
        }
      }

      BatcherAcquire { amount, inventory, next } -> {
        expect Some(listing_input) = find_listing_input(tx.inputs, orderbook_address)
        expect Some(listing) = listing_from_output(listing_input.output)
        expect Some(next_output) = pool_continuation(tx.outputs, pool_address, next)
        expect Some(inventory_output) =
          find_listing_output(tx.outputs, orderbook_address, inventory)
        let locked_lovelace = listing_input.output.value |> quantity_of(ada())
        let inventory_lovelace = inventory_output.value |> quantity_of(ada())

        and {
          has_pool_token,
          !pool.paused,
          signed(tx, pool.batcher),
          listing_is_valid(listing),
          listing.settlement == Direct,
          listing.price_asset == pool.quote_asset,
          listing.price == amount,
          amount > 0,
          listing_input.output.value == listing_value(listing, locked_lovelace),
          inventory_listing_is_bound(inventory, pool, pool_address),
          minted(tx, pool.inventory_token) == 1,
          inventory.rwa == listing.rwa,
          inventory.quantity == listing.quantity,
          inventory.price > 0,
          inventory_lovelace > 0,
          inventory_output.value == listing_value(inventory, inventory_lovelace),
          next.total_lp_supply == pool.total_lp_supply,
          next.inventory_value == pool.inventory_value + inventory.price,
          same_config(pool, next),
          pool_can_pay(own_input.output, pool, amount, locked_lovelace),
          next_output.value == pool_payment(
            own_input.output.value,
            pool,
            -amount,
            -locked_lovelace,
          ),
        }
      }

      InventorySale { amount, buyer, next } -> {
        expect Some(listing_input) = find_listing_input(tx.inputs, orderbook_address)
        expect Some(listing) = listing_from_output(listing_input.output)
        expect Some(next_output) = pool_continuation(tx.outputs, pool_address, next)
        let locked_lovelace = listing_input.output.value |> quantity_of(ada())

        and {
          has_pool_token,
          !pool.paused,
          listing_is_valid(listing),
          inventory_listing_is_bound(listing, pool, pool_address),
          minted(tx, pool.inventory_token) == -1,
          paid_at_least(tx.outputs, buyer, listing.rwa, listing.quantity),
          amount == listing.price,
          amount > 0,
          next.total_lp_supply == pool.total_lp_supply,
          pool.inventory_value >= amount,
          next.inventory_value == pool.inventory_value - amount,
          same_config(pool, next),
          next_output.value == pool_payment(
            own_input.output.value,
            pool,
            amount,
            locked_lovelace,
          ),
          pool_cash(next_output, next) >= next.min_cash_reserve,
        }
      }

      AdminUpdate { next } -> {
        expect Some(next_output) = pool_continuation(tx.outputs, pool_address, next)

        and {
          has_pool_token,
          signed(tx, pool.admin),
          next.pool_token == pool.pool_token,
          next.lp_token == pool.lp_token,
          next.inventory_token == pool.inventory_token,
          next.quote_asset == pool.quote_asset,
          next.total_lp_supply == pool.total_lp_supply,
          next.inventory_value == pool.inventory_value,
          next.min_cash_reserve >= 0,
          next_output.value == own_input.output.value,
          next_output.address == pool_address,
        }
      }

      AdminClose -> {
        and {
          has_pool_token,
          signed(tx, pool.admin),
          pool.inventory_value == 0,
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

const test_quote: AssetClass = AssetClass {
  policy_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  asset_name: "USDC",
}

const test_pool_token: AssetClass = AssetClass {
  policy_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  asset_name: "POOL",
}

test pool_payment_adds_quote_asset() {
  let value = assets.from_lovelace(2_000_000)
  let pool = QuotePoolDatum {
    admin: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    batcher: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    pool_token: test_pool_token,
    lp_token: test_pool_token,
    inventory_token: test_pool_token,
    quote_asset: test_quote,
    total_lp_supply: 10,
    min_cash_reserve: 0,
    paused: False,
    inventory_value: 0,
  }

  quantity_of(pool_payment(value, pool, 500, 1_000_000), test_quote) == 500
}
