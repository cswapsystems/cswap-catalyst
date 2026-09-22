use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use ebecca/types.{AssetConfig, PolicyConfig, RegistryDatum, has_one}

pub type RegistryRedeemer {
  Update { next: RegistryDatum }
  Close
}

fn datum_is(output_datum: Data, expected: RegistryDatum) -> Bool {
  expect datum: RegistryDatum = output_datum
  datum == expected
}

fn policy_config_is_valid(config: PolicyConfig) -> Bool {
  and {
    config.max_policy_exposure_value >= 0,
    config.max_trade_value >= 0,
    config.risk_tier >= 0,
  }
}

fn asset_config_is_valid(config: AssetConfig) -> Bool {
  and {
    config.max_asset_exposure_value >= 0,
    config.max_trade_value >= 0,
  }
}

validator registry {
  spend(
    datum: Option<RegistryDatum>,
    redeemer: RegistryRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(current) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    let admin: VerificationKeyHash = current.admin
    let signed_by_admin = list.has(tx.extra_signatories, admin)
    let input_has_registry_token =
      own_input.output.value |> has_one(current.registry_token)

    when redeemer is {
      Update { next } -> {
        let continuing_registry_output =
          list.any(
            tx.outputs,
            fn(output) {
              and {
                output.address == own_input.output.address,
                output.value == own_input.output.value,
                output.value |> has_one(current.registry_token),
                when output.datum is {
                  InlineDatum(data) -> datum_is(data, next)
                  _ -> False
                },
              }
            },
          )

        and {
          signed_by_admin,
          input_has_registry_token,
          next.admin == current.admin,
          next.registry_token == current.registry_token,
          next.sequence > current.sequence,
          list.all(next.policies, policy_config_is_valid),
          list.all(next.asset_configs, asset_config_is_valid),
          continuing_registry_output,
        }
      }

      Close -> and {
          signed_by_admin,
          input_has_registry_token,
        }
    }
  }

  else(_) {
    fail
  }
}
