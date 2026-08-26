use aiken/collection/list
use cardano/transaction.{
  InlineDatum, Input, OutputReference, Transaction, find_input,
}
use ebecca/types.{
  AssetClass, PolicyShardDatum, RegistryRootDatum, has_one, quantity_of,
}

pub type PolicyShardRedeemer {
  Update { next: PolicyShardDatum }
  Retire
}

fn datum_is(output_datum: Data, expected: PolicyShardDatum) -> Bool {
  expect datum: PolicyShardDatum = output_datum
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

fn config_is_valid(shard: PolicyShardDatum) -> Bool {
  and {
    shard.version >= 0,
    shard.config.policy_id == shard.policy_id,
    shard.config.max_policy_exposure_value >= 0,
    shard.config.max_trade_value >= 0,
    shard.config.risk_tier >= 0,
  }
}

validator policy_shard {
  spend(
    datum: Option<PolicyShardDatum>,
    redeemer: PolicyShardRedeemer,
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
          next.policy_id == current.policy_id,
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
