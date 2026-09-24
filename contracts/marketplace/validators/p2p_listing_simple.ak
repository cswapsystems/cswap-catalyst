use aiken/collection/list
use cardano/assets
use aiken/crypto.{VerificationKeyHash}
use cardano/address
use cardano/address.{Address}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, find_input}
use ebecca/types.{
  AssetClass, Direct, InstantSell, PoolAssetPrice, QuotePool, QuotePoolDatum,
  ListingSettlement, PoolExit, SimpleListingDatum, ada, has_one, quantity_of, ratio_value,
}

pub type SimpleListingRedeemer {
  Buy { buyer: Address }
  Cancel
  Update { next: SimpleListingDatum }
  // Batcher's pool purchase of a seller's instant-sell escrow.
  BatcherAcquire { inventory: SimpleListingDatum }
  // Atomic price edit for already pool-owned inventory.
  Reprice { next: SimpleListingDatum }
  // During pool wind-down, the last LP returns each pool-owned RWA in its own
  // transaction before closing the reserve.
  ReturnToClosingLp {
    recipient: Address,
    provider_key: VerificationKeyHash,
    next: QuotePoolDatum,
  }
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

fn listing_value(
  rwa: AssetClass,
  quantity: Int,
  locked_lovelace: Int,
) -> assets.Value {
  assets.from_lovelace(locked_lovelace)
    |> assets.add(rwa.policy_id, rwa.asset_name, quantity)
}

fn listing_escrow_value(
  listing: SimpleListingDatum,
  locked_lovelace: Int,
) -> assets.Value {
  let value =
    listing_value(listing.rwa, listing.quantity, locked_lovelace)

  when listing.settlement is {
    Direct -> value
    InstantSell { pool_token: _ } -> value
    QuotePool { inventory_token, pool_token: _, acquisition_cost: _ } ->
      value
        |> assets.add(
          inventory_token.policy_id,
          inventory_token.asset_name,
          1,
        )
  }
}

fn listing_escrow_is_exact(
  input_value: assets.Value,
  listing: SimpleListingDatum,
  locked_lovelace: Int,
) -> Bool {
  and {
    locked_lovelace > 0,
    input_value == listing_escrow_value(listing, locked_lovelace),
  }
}

fn seller_receives_quantity(
  outputs: List<Output>,
  seller: Address,
  asset: AssetClass,
  quantity: Int,
) -> Bool {
  if quantity <= 0 {
    True
  } else {
    paid_at_least(outputs, seller, asset, quantity)
  }
}

/// Owner recovery must not depend on the escrow matching its datum: a
/// listing holding extra ADA or tokens is returned whole to the seller.
fn seller_receives_escrow(
  outputs: List<Output>,
  seller: Address,
  escrow: assets.Value,
) -> Bool {
  list.any(
    outputs,
    fn(output) {
      output.address == seller && list.all(
        assets.flatten(escrow),
        fn(entry) {
          let (policy_id, asset_name, quantity) = entry
          assets.quantity_of(output.value, policy_id, asset_name) >= quantity
        },
      )
    },
  )
}

fn listing_is_valid(listing: SimpleListingDatum) -> Bool {
  and {
    listing.quantity > 0,
    listing.price > 0,
    listing.rwa != ada(),
    listing.price_asset != listing.rwa,
  }
}

fn output_is_listing(
  output: Output,
  address: Address,
  listing: SimpleListingDatum,
  locked_lovelace: Int,
) -> Bool {
  and {
    output.address == address,
    output.value == listing_escrow_value(listing, locked_lovelace),
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
  locked_lovelace: Int,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      output_is_listing(output, address, listing, locked_lovelace)
    },
  )
}

fn seller_is_paid(
  outputs: List<Output>,
  listing: SimpleListingDatum,
  locked_lovelace: Int,
) -> Bool {
  if listing.price_asset == ada() {
    paid_at_least(
      outputs,
      listing.seller,
      ada(),
      listing.price + locked_lovelace,
    )
  } else {
    and {
      paid_at_least(outputs, listing.seller, listing.price_asset, listing.price),
      paid_at_least(outputs, listing.seller, ada(), locked_lovelace),
    }
  }
}

/// Direct purchases tag the seller payment with the listing's own output
/// reference. Without the tag one payment output could satisfy several
/// listings from the same seller in a single transaction.
fn seller_is_paid_for(
  outputs: List<Output>,
  listing: SimpleListingDatum,
  locked_lovelace: Int,
  own_ref: OutputReference,
) -> Bool {
  list.any(
    outputs,
    fn(output) {
      and {
        output.address == listing.seller,
        output.datum == InlineDatum(own_ref),
        if listing.price_asset == ada() {
          quantity_of(output.value, ada()) >= listing.price + locked_lovelace
        } else {
          and {
            quantity_of(output.value, listing.price_asset) >= listing.price,
            quantity_of(output.value, ada()) >= locked_lovelace,
          }
        },
      }
    },
  )
}

/// A pool-owned listing may only be bought through the pool's `InventorySale`
/// transition. Every pool redeemer fixes the exact receipt mint, and only
/// `InventorySale` / `ReturnClosingInventory` burn one, so requiring a single
/// burn with no receipt left in any output rules out e.g. a 1-lovelace
/// `AddFunds` whose existing balance would otherwise "pay" the listing. By
/// balance it also limits the transaction to one receipt-backed listing.
fn pool_receipt_is_burned(tx: Transaction, listing: SimpleListingDatum) -> Bool {
  when listing.settlement is {
    QuotePool { inventory_token, pool_token: _, acquisition_cost: _ } ->
      and {
        quantity_of(tx.mint, inventory_token) == -1,
        list.all(
          tx.outputs,
          fn(output) { quantity_of(output.value, inventory_token) == 0 },
        ),
      }
    _ -> False
  }
}

fn seller_can_manage_listing(listing: SimpleListingDatum) -> Bool {
  when listing.settlement is {
    Direct -> True
    InstantSell { pool_token: _ } -> True
    QuotePool { pool_token: _, inventory_token: _, acquisition_cost: _ } -> False
  }
}

fn pool_sale_is_atomic(
  tx: Transaction,
  listing: SimpleListingDatum,
) -> Bool {
  when listing.settlement is {
    Direct -> True
    InstantSell { pool_token: _ } -> False
    QuotePool { pool_token, inventory_token: _, acquisition_cost: _ } ->
      and {
        list.any(
          tx.inputs,
          fn(input: Input) {
            input.output.address == listing.seller
              && (input.output.value |> has_one(pool_token))
          },
        ),
        list.any(
          tx.outputs,
          fn(output) {
            and {
              output.address == listing.seller,
              output.value |> has_one(pool_token),
              when output.datum is {
                InlineDatum(data) -> {
                  expect pool: QuotePoolDatum = data
                  pool.pool_token == pool_token
                }
                _ -> False
              },
            }
          },
        ),
      }
  }
}

fn datum_pool(output: Output) -> Option<QuotePoolDatum> {
  when output.datum is {
    InlineDatum(data) -> {
      expect pool: QuotePoolDatum = data
      Some(pool)
    }
    _ -> None
  }
}

fn pool_input_for(inputs: List<Input>, token: AssetClass) -> Option<Input> {
  list.find(
    inputs,
    fn(input) {
      has_one(input.output.value, token)
        && datum_pool(input.output) != None
    },
  )
}

fn pool_output_for(
  outputs: List<Output>,
  address: Address,
  token: AssetClass,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      output.address == address
        && has_one(output.value, token)
        && datum_pool(output) != None
    },
  )
}

fn pool_price_for(asset: AssetClass, prices: List<PoolAssetPrice>) -> Option<PoolAssetPrice> {
  list.find(prices, fn(price) { price.asset == asset })
}

fn inventory_for_pool(
  settlement: ListingSettlement,
  token: AssetClass,
  receipt: AssetClass,
) -> Bool {
  when settlement is {
    QuotePool { pool_token, inventory_token, acquisition_cost: _ } ->
      pool_token == token && inventory_token == receipt
    _ -> False
  }
}

/// Registry-free orderbook for direct/Instant Sell listings and receipt-backed
/// pool inventory. Pool actions are validated jointly with `quote_pool`.
validator p2p_listing_simple {
  spend(
    datum: Option<SimpleListingDatum>,
    redeemer: SimpleListingRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(listing) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    when redeemer is {
      Buy { buyer } -> {
        let locked_lovelace = own_input.output.value |> quantity_of(ada())

        and {
          listing_is_valid(listing),
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          when listing.settlement is {
            Direct ->
              seller_is_paid_for(tx.outputs, listing, locked_lovelace, own_ref)
            QuotePool { pool_token: _, inventory_token: _, acquisition_cost: _ } ->
              and {
                seller_is_paid(tx.outputs, listing, locked_lovelace),
                pool_sale_is_atomic(tx, listing),
                pool_receipt_is_burned(tx, listing),
              }
            InstantSell { pool_token: _ } -> False
          },
          paid_at_least(tx.outputs, buyer, listing.rwa, listing.quantity),
        }
      }

      Cancel -> {
        and {
          seller_can_manage_listing(listing),
          list.has(tx.extra_signatories, listing.seller_key),
          seller_receives_escrow(tx.outputs, listing.seller, own_input.output.value),
        }
      }

      Update { next } -> {
        let locked_lovelace = own_input.output.value |> quantity_of(ada())
        let released_quantity = listing.quantity - next.quantity
        expect Some(next_output) =
          find_listing_output(
            tx.outputs,
            own_input.output.address,
            next,
            locked_lovelace,
          )

        and {
          seller_can_manage_listing(listing),
          listing_is_valid(next),
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          list.has(tx.extra_signatories, listing.seller_key),
          next.rwa == listing.rwa,
          next.price_asset == listing.price_asset,
          next.settlement == listing.settlement,
          next.seller == listing.seller,
          next.seller_key == listing.seller_key,
          next_output.value == listing_escrow_value(next, locked_lovelace),
          seller_receives_quantity(
            tx.outputs,
            listing.seller,
            listing.rwa,
            released_quantity,
          ),
        }
      }

      BatcherAcquire { inventory } -> {
        let locked_lovelace = own_input.output.value |> quantity_of(ada())
        expect InstantSell { pool_token } = listing.settlement
        expect Some(pool_input) = pool_input_for(tx.inputs, pool_token)
        expect Some(pool) = datum_pool(pool_input.output)
        expect Some(price) = pool_price_for(listing.rwa, pool.prices)
        expect Some(pool_output) = pool_output_for(tx.outputs, pool_input.output.address, pool_token)
        expect Some(next_pool) = datum_pool(pool_output)
        let payout = ratio_value(price.buy_price, listing.quantity)
        expect Some(inventory_output) = list.find(
          tx.outputs,
          fn(output) {
            output.address == own_input.output.address
              && when output.datum is {
                InlineDatum(data) -> {
                  expect candidate: SimpleListingDatum = data
                  candidate == inventory
                }
                _ -> False
              }
          },
        )
        let inventory_lovelace = inventory_output.value |> quantity_of(ada())
        let expected_ask = ratio_value(price.sell_price, listing.quantity)

        and {
          listing_is_valid(listing),
          listing.price_asset == pool.quote_asset,
          listing.price > 0,
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          pool.pool_token == pool_token,
          pool.quote_asset == listing.price_asset,
          next_pool.pool_token == pool_token,
          pool_output.address == pool_input.output.address,
          pool_input.output.address == inventory.seller,
          signed(tx, pool.batcher),
          payout >= listing.price,
          payout > 0,
          if pool.quote_asset == ada() {
            paid_at_least(tx.outputs, listing.seller, ada(), payout + locked_lovelace)
          } else {
            and {
              paid_at_least(tx.outputs, listing.seller, pool.quote_asset, payout),
              paid_at_least(tx.outputs, listing.seller, ada(), locked_lovelace),
            }
          },
          inventory_for_pool(inventory.settlement, pool_token, pool.inventory_token),
          inventory.seller == pool_input.output.address,
          inventory.seller_key == pool.batcher,
          inventory.rwa == listing.rwa,
          inventory.quantity == listing.quantity,
          inventory.price_asset == pool.quote_asset,
          inventory.price == expected_ask,
          inventory_lovelace > 0,
          inventory_output.value == listing_escrow_value(inventory, inventory_lovelace),
          inventory.settlement == QuotePool {
            pool_token,
            inventory_token: pool.inventory_token,
            acquisition_cost: payout,
          },
          quantity_of(tx.mint, pool.inventory_token) == 1,
        }
      }

      Reprice { next } -> {
        let locked_lovelace = own_input.output.value |> quantity_of(ada())
        expect QuotePool { pool_token, inventory_token, acquisition_cost } = listing.settlement
        expect Some(pool_input) = pool_input_for(tx.inputs, pool_token)
        expect Some(pool) = datum_pool(pool_input.output)
        expect Some(pool_output) = pool_output_for(tx.outputs, pool_input.output.address, pool_token)
        expect Some(next_pool) = datum_pool(pool_output)
        expect Some(next_output) = find_listing_output(
          tx.outputs,
          own_input.output.address,
          next,
          locked_lovelace,
        )

        and {
          listing_is_valid(listing),
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          pool.pool_token == pool_token,
          pool.inventory_token == inventory_token,
          pool.batcher == listing.seller_key,
          listing.seller == pool_input.output.address,
          signed(tx, pool.batcher),
          next.settlement == listing.settlement,
          next.seller == listing.seller,
          next.seller_key == listing.seller_key,
          next.rwa == listing.rwa,
          next.quantity == listing.quantity,
          next.price_asset == listing.price_asset,
          next.price > 0,
          acquisition_cost > 0,
          next_output.value == listing_escrow_value(next, locked_lovelace),
          next_pool.pool_token == pool_token,
          pool_output.address == pool_input.output.address,
        }
      }

      ReturnToClosingLp { recipient, provider_key, next } -> {
        let locked_lovelace = own_input.output.value |> quantity_of(ada())
        expect QuotePool { pool_token, inventory_token, acquisition_cost: _ } = listing.settlement
        expect Some(pool_input) = pool_input_for(tx.inputs, pool_token)
        expect Some(pool) = datum_pool(pool_input.output)
        expect Some(exit) = pool.closing
        expect Some(pool_output) = pool_output_for(
          tx.outputs,
          pool_input.output.address,
          pool_token,
        )
        expect Some(next_pool) = datum_pool(pool_output)

        and {
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          pool.pool_token == pool_token,
          pool.inventory_token == inventory_token,
          pool.total_lp_supply == 0,
          exit == PoolExit { recipient, provider_key },
          listing.seller == pool_input.output.address,
          listing.seller_key == pool.batcher,
          listing.price_asset == pool.quote_asset,
          paid_to_key(recipient, provider_key),
          signed(tx, provider_key),
          pool_output.address == pool_input.output.address,
          next_pool == next,
          next.closing == pool.closing,
          quantity_of(tx.mint, inventory_token) == -1,
          list.all(tx.outputs, fn(output) {
            quantity_of(output.value, inventory_token) == 0
          }),
          paid_at_least(tx.outputs, recipient, listing.rwa, listing.quantity),
          paid_at_least(tx.outputs, recipient, ada(), locked_lovelace),
        }
      }
    }
  }

  else(_) {
    fail
  }
}

const test_rwa: AssetClass =
  AssetClass {
    policy_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    asset_name: "RWA-1",
  }

const test_extra_asset: AssetClass =
  AssetClass {
    policy_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    asset_name: "EXTRA",
  }

const test_pool_token: AssetClass =
  AssetClass {
    policy_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    asset_name: "POOL",
  }

const test_inventory_token: AssetClass =
  AssetClass {
    policy_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    asset_name: "RECEIPT",
  }

const test_seller: Address =
  address.Address {
    payment_credential: address.VerificationKey(
      #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ),
    stake_credential: None,
  }

test simple_listing_value_rejects_unlisted_assets() {
  let expected = listing_value(test_rwa, 3, 2_000_000)
  let with_extra =
    expected
      |> assets.add(
        test_extra_asset.policy_id,
        test_extra_asset.asset_name,
        1,
      )

  and {
    assets.quantity_of(expected, test_rwa.policy_id, test_rwa.asset_name) == 3,
    assets.quantity_of(expected, test_extra_asset.policy_id, test_extra_asset.asset_name) == 0,
    with_extra == expected == False,
  }
}

test pool_listing_escrow_requires_inventory_receipt() {
  let listing =
    SimpleListingDatum {
      seller: test_seller,
      seller_key: #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      settlement: QuotePool {
        pool_token: test_pool_token,
        inventory_token: test_inventory_token,
        acquisition_cost: 500,
      },
      rwa: test_rwa,
      quantity: 1,
      price_asset: test_extra_asset,
      price: 500,
    }

  let exact = listing_escrow_value(listing, 2_000_000)
  let missing_receipt = listing_value(test_rwa, 1, 2_000_000)

  and {
    assets.quantity_of(
      exact,
      test_inventory_token.policy_id,
      test_inventory_token.asset_name,
    ) == 1,
    listing_escrow_is_exact(exact, listing, 2_000_000),
    listing_escrow_is_exact(missing_receipt, listing, 2_000_000) == False,
  }
}

// Regression fixtures: a pool-owned listing and direct listings spent together
// with other inputs, to prove each purchase is paid for exactly once.
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

fn reg_ref(index: Int) -> OutputReference {
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: index,
  }
}

fn reg_pool() -> QuotePoolDatum {
  QuotePoolDatum {
    admin: reg_batcher,
    batcher: reg_batcher,
    pool_token: test_pool_token,
    lp_token: test_extra_asset,
    inventory_token: test_inventory_token,
    quote_asset: ada(),
    prices: [],
    total_lp_supply: 100_000_000,
    min_cash_reserve: 5_000_000,
    paused: False,
    inventory_cost: 80_000_000,
    inventory_value: 100_000_000,
    inventory_count: 2,
    closing: None,
  }
}

fn reg_pool_listing() -> SimpleListingDatum {
  SimpleListingDatum {
    seller: reg_pool_address,
    seller_key: reg_batcher,
    settlement: QuotePool {
      pool_token: test_pool_token,
      inventory_token: test_inventory_token,
      acquisition_cost: 40_000_000,
    },
    rwa: test_rwa,
    quantity: 1,
    price_asset: ada(),
    price: 50_000_000,
  }
}

fn reg_pool_value(lovelace: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.add(test_pool_token.policy_id, test_pool_token.asset_name, 1)
}

fn reg_pool_input() -> Input {
  Input {
    output_reference: reg_ref(0),
    output: Output {
      address: reg_pool_address,
      value: reg_pool_value(100_000_000),
      datum: InlineDatum(reg_pool()),
      reference_script: None,
    },
  }
}

fn reg_pool_listing_input(index: Int) -> Input {
  Input {
    output_reference: reg_ref(index),
    output: Output {
      address: reg_orderbook_address,
      value: listing_escrow_value(reg_pool_listing(), 2_000_000),
      datum: InlineDatum(reg_pool_listing()),
      reference_script: None,
    },
  }
}

fn reg_output(to: Address, value: assets.Value) -> Output {
  Output { address: to, value, datum: transaction.NoDatum, reference_script: None }
}

fn reg_pool_output(lovelace: Int) -> Output {
  Output {
    address: reg_pool_address,
    value: reg_pool_value(lovelace),
    datum: InlineDatum(reg_pool()),
    reference_script: None,
  }
}

fn reg_receipt_burn() -> assets.Value {
  assets.from_asset(
    test_inventory_token.policy_id,
    test_inventory_token.asset_name,
    -1,
  )
}

test pool_listing_buy_accepts_inventory_sale_shape() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [reg_pool_input(), reg_pool_listing_input(1)],
      outputs: [
        reg_pool_output(152_000_000),
        reg_output(reg_buyer, assets.from_asset(test_rwa.policy_id, test_rwa.asset_name, 1)),
      ],
      mint: reg_receipt_burn(),
    }

  p2p_listing_simple.spend(Some(reg_pool_listing()), Buy { buyer: reg_buyer }, reg_ref(1), tx)
}

// The pool is re-created by a 1-lovelace AddFunds; its existing balance used to
// count as payment while the buyer walked off with the RWA and the receipt.
test pool_listing_buy_rejects_addfunds_spend() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [reg_pool_input(), reg_pool_listing_input(1)],
      outputs: [
        reg_pool_output(100_000_001),
        reg_output(reg_buyer, listing_escrow_value(reg_pool_listing(), 2_000_000)),
      ],
    }

  p2p_listing_simple.spend(Some(reg_pool_listing()), Buy { buyer: reg_buyer }, reg_ref(1), tx)
}

// Two pool listings, one paid sale: the second listing's receipt survives in
// an output, so the piggybacking purchase is rejected.
test pool_listing_buy_rejects_second_listing_in_sale() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [reg_pool_input(), reg_pool_listing_input(1), reg_pool_listing_input(2)],
      outputs: [
        reg_pool_output(152_000_000),
        reg_output(
          reg_buyer,
          listing_escrow_value(reg_pool_listing(), 0)
            |> assets.add(test_rwa.policy_id, test_rwa.asset_name, 1),
        ),
      ],
      mint: reg_receipt_burn(),
    }

  p2p_listing_simple.spend(Some(reg_pool_listing()), Buy { buyer: reg_buyer }, reg_ref(2), tx)
}

fn reg_direct() -> SimpleListingDatum {
  SimpleListingDatum {
    seller: test_seller,
    seller_key: #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    settlement: Direct,
    rwa: test_rwa,
    quantity: 1,
    price_asset: ada(),
    price: 10_000_000,
  }
}

fn reg_direct_input(index: Int) -> Input {
  Input {
    output_reference: reg_ref(index),
    output: Output {
      address: reg_orderbook_address,
      value: listing_value(test_rwa, 1, 2_000_000),
      datum: InlineDatum(reg_direct()),
      reference_script: None,
    },
  }
}

fn reg_seller_payment(tag: Option<OutputReference>) -> Output {
  Output {
    address: test_seller,
    value: assets.from_lovelace(12_000_000),
    datum: when tag is {
      Some(own_ref) -> InlineDatum(own_ref)
      None -> transaction.NoDatum
    },
    reference_script: None,
  }
}

test direct_buy_accepts_tagged_payment() {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [reg_direct_input(1)],
      outputs: [
        reg_seller_payment(Some(reg_ref(1))),
        reg_output(reg_buyer, listing_value(test_rwa, 1, 2_000_000)),
      ],
    }

  p2p_listing_simple.spend(Some(reg_direct()), Buy { buyer: reg_buyer }, reg_ref(1), tx)
}

test direct_buy_rejects_untagged_payment() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [reg_direct_input(1)],
      outputs: [
        reg_seller_payment(None),
        reg_output(reg_buyer, listing_value(test_rwa, 1, 2_000_000)),
      ],
    }

  p2p_listing_simple.spend(Some(reg_direct()), Buy { buyer: reg_buyer }, reg_ref(1), tx)
}

// One 12-ADA payment previously bought two 10-ADA listings from the same seller.
test direct_buy_rejects_shared_payment() fail {
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [reg_direct_input(1), reg_direct_input(2)],
      outputs: [
        reg_seller_payment(Some(reg_ref(1))),
        reg_output(reg_buyer, listing_value(test_rwa, 2, 4_000_000)),
      ],
    }

  p2p_listing_simple.spend(Some(reg_direct()), Buy { buyer: reg_buyer }, reg_ref(2), tx)
}

fn reg_cancel_tx(escrow: assets.Value, refund: assets.Value, signer: VerificationKeyHash) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: reg_ref(1),
        output: Output {
          address: reg_orderbook_address,
          value: escrow,
          datum: InlineDatum(reg_direct()),
          reference_script: None,
        },
      },
    ],
    outputs: [reg_output(test_seller, refund)],
    extra_signatories: [signer],
  }
}

// The escrow holds more than its datum declares; the seller still recovers it.
test cancel_returns_escrow_with_unlisted_assets() {
  let escrow =
    listing_value(test_rwa, 1, 3_000_000)
      |> assets.add(test_extra_asset.policy_id, test_extra_asset.asset_name, 5)
  p2p_listing_simple.spend(
    Some(reg_direct()),
    Cancel,
    reg_ref(1),
    reg_cancel_tx(escrow, escrow, reg_direct().seller_key),
  )
}

test cancel_rejects_partial_refund() fail {
  let escrow =
    listing_value(test_rwa, 1, 3_000_000)
      |> assets.add(test_extra_asset.policy_id, test_extra_asset.asset_name, 5)
  p2p_listing_simple.spend(
    Some(reg_direct()),
    Cancel,
    reg_ref(1),
    reg_cancel_tx(escrow, listing_value(test_rwa, 1, 3_000_000), reg_direct().seller_key),
  )
}

test cancel_rejects_non_seller() fail {
  let escrow = listing_value(test_rwa, 1, 2_000_000)
  p2p_listing_simple.spend(Some(reg_direct()), Cancel, reg_ref(1), reg_cancel_tx(escrow, escrow, reg_batcher))
}
