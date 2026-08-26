use aiken/collection/list
use cardano/transaction.{
  InlineDatum, Input, OutputReference, Transaction, find_input,
}
use ebecca/types.{
  AssetClass, AssetShardDatum, RegistryRootDatum, has_one, quantity_of,
}

pub type AssetShardRedeemer {
  Update { next: AssetShardDatum }
  Retire
}

fn datum_is(output_datum: Data, expected: AssetShardDatum) -> Bool {
  expect datum: AssetShardDatum = output_datum
  datum == expected
}

fn root_from_reference(
  reference_inputs: List<Input>,
  root_token: AssetClass,
) -> Option<RegistryRootDatum> {
  list.find_map(
    reference_inputs,
    fn(input) {
      if input.output.value |> has_one(root_token) {
        when input.output.datum is {
          InlineDatum(data) -> {
            expect root: RegistryRootDatum = data
            if root.root_token == root_token {
              Some(root)
            } else {
              None
            }
          }
          _ -> None
        }
      } else {
        None
      }
    },
  )
}

fn config_is_valid(shard: AssetShardDatum) -> Bool {
  and {
    shard.version >= 0,
    shard.config.asset == shard.asset,
    shard.config.max_asset_exposure_value >= 0,
    shard.config.max_trade_value >= 0,
  }
}

validator asset_shard {
  spend(
    datum: Option<AssetShardDatum>,
    redeemer: AssetShardRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(current) = datum
    expect Some(root) =
      root_from_reference(tx.reference_inputs, current.root_token)
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    let signed_by_admin = list.has(tx.extra_signatories, root.admin)
    let input_has_shard_token =
      own_input.output.value |> has_one(current.shard_token)

    when redeemer is {
      Update { next } -> {
        let continuing_shard_output =
          list.any(
            tx.outputs,
            fn(output) {
              and {
                output.address == own_input.output.address,
                output.value == own_input.output.value,
                output.value |> has_one(current.shard_token),
                when output.datum is {
                  InlineDatum(data) -> datum_is(data, next)
                  _ -> False
                },
              }
            },
          )

        and {
          signed_by_admin,
          input_has_shard_token,
          config_is_valid(next),
          next.root_token == current.root_token,
          next.shard_token == current.shard_token,
          next.asset == current.asset,
          next.version > current.version,
          continuing_shard_output,
        }
      }

      Retire -> and {
          signed_by_admin,
          input_has_shard_token,
          quantity_of(tx.mint, current.shard_token) == -1,
        }
    }
  }

  else(_) {
    fail
  }
}
