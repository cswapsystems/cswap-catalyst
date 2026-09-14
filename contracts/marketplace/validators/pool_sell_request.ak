use aiken/collection/list
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{Input, Output, OutputReference, Transaction, find_input}
use ebecca/types.{AssetClass, PoolSellRequestDatum, ada, has_one, quantity_of}

pub type PoolSellRequestRedeemer {
  Settle
  Cancel
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

fn request_value(request: PoolSellRequestDatum, locked_lovelace: Int) -> assets.Value {
  assets.from_lovelace(locked_lovelace)
    |> assets.add(request.rwa.policy_id, request.rwa.asset_name, request.quantity)
}

fn pool_is_spent(inputs: List<Input>, pool_address: Address, pool_token: AssetClass) -> Bool {
  list.any(
    inputs,
    fn(input) {
      input.output.address == pool_address && (input.output.value |> has_one(pool_token))
    },
  )
}

validator pool_sell_request(pool_address: Address) {
  spend(
    datum: Option<PoolSellRequestDatum>,
    redeemer: PoolSellRequestRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(request) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)
    let locked_lovelace = own_input.output.value |> quantity_of(ada())

    and {
      request.quantity > 0,
      request.min_payout > 0,
      request.rwa != ada(),
      request.quote_asset != request.rwa,
      own_input.output.value == request_value(request, locked_lovelace),
      when redeemer is {
        Settle -> and {
          pool_is_spent(tx.inputs, pool_address, request.pool_token),
          if request.quote_asset == ada() {
            paid_at_least(
              tx.outputs,
              request.seller,
              ada(),
              request.min_payout + locked_lovelace,
            )
          } else {
            and {
              paid_at_least(tx.outputs, request.seller, request.quote_asset, request.min_payout),
              paid_at_least(tx.outputs, request.seller, ada(), locked_lovelace),
            }
          },
        }
        Cancel -> and {
          list.has(tx.extra_signatories, request.seller_key),
          paid_at_least(tx.outputs, request.seller, request.rwa, request.quantity),
          paid_at_least(tx.outputs, request.seller, ada(), locked_lovelace),
        }
      },
    }
  }

  else(_) {
    fail
  }
}
