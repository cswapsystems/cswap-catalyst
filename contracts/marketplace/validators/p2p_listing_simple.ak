use aiken/collection/list
use cardano/assets
use cardano/address.{Address}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, find_input}
use ebecca/types.{AssetClass, QuotePoolDatum, SimpleListingDatum, ada, has_one, quantity_of}

pub type SimpleListingRedeemer {
  Buy { buyer: Address }
  Cancel
  Update { next: SimpleListingDatum }
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

fn listing_escrow_is_exact(
  input_value: assets.Value,
  listing: SimpleListingDatum,
  locked_lovelace: Int,
) -> Bool {
  and {
    locked_lovelace > 0,
    input_value == listing_value(listing.rwa, listing.quantity, locked_lovelace),
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
    output.value == listing_value(
      listing.rwa,
      listing.quantity,
      locked_lovelace,
    ),
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

fn pool_sale_is_atomic(
  tx: Transaction,
  listing: SimpleListingDatum,
) -> Bool {
  when listing.settlement is {
    Direct -> True
    QuotePool { pool_token } ->
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
          seller_is_paid(tx.outputs, listing, locked_lovelace),
          pool_sale_is_atomic(tx, listing),
          paid_at_least(tx.outputs, buyer, listing.rwa, listing.quantity),
        }
      }

      Cancel -> {
        let locked_lovelace = own_input.output.value |> quantity_of(ada())

        and {
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          list.has(tx.extra_signatories, listing.seller_key),
          seller_receives_quantity(
            tx.outputs,
            listing.seller,
            listing.rwa,
            listing.quantity,
          ),
          paid_at_least(tx.outputs, listing.seller, ada(), locked_lovelace),
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
          listing_is_valid(next),
          listing_escrow_is_exact(own_input.output.value, listing, locked_lovelace),
          list.has(tx.extra_signatories, listing.seller_key),
          next.rwa == listing.rwa,
          next.settlement == listing.settlement,
          next.seller_key == listing.seller_key,
          next_output.value == listing_value(
            next.rwa,
            next.quantity,
            locked_lovelace,
          ),
          seller_receives_quantity(
            tx.outputs,
            listing.seller,
            listing.rwa,
            released_quantity,
          ),
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
