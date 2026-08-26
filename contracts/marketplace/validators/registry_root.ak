use aiken/collection/list
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use ebecca/types.{RegistryRootDatum, has_one}

pub type RegistryRootRedeemer {
  Update { next: RegistryRootDatum }
  Close
}

fn datum_is(output_datum: Data, expected: RegistryRootDatum) -> Bool {
  expect datum: RegistryRootDatum = output_datum
  datum == expected
}

fn root_is_valid(root: RegistryRootDatum) -> Bool {
  root.version >= 0
}

validator registry_root {
  spend(
    datum: Option<RegistryRootDatum>,
    redeemer: RegistryRootRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(current) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    let signed_by_admin = list.has(tx.extra_signatories, current.admin)
    let input_has_root_token =
      own_input.output.value |> has_one(current.root_token)

    when redeemer is {
      Update { next } -> {
        let continuing_root_output =
          list.any(
            tx.outputs,
            fn(output) {
              and {
                output.address == own_input.output.address,
                output.value == own_input.output.value,
                output.value |> has_one(current.root_token),
                when output.datum is {
                  InlineDatum(data) -> datum_is(data, next)
                  _ -> False
                },
              }
            },
          )

        and {
          signed_by_admin,
          input_has_root_token,
          root_is_valid(next),
          next.admin == current.admin,
          next.root_token == current.root_token,
          next.policy_shard_policy == current.policy_shard_policy,
          next.asset_shard_policy == current.asset_shard_policy,
          next.version > current.version,
          continuing_root_output,
        }
      }

      Close -> and {
          signed_by_admin,
          input_has_root_token,
        }
    }
  }

  else(_) {
    fail
  }
}
