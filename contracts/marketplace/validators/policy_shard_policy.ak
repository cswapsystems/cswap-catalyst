use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{InlineDatum, Input, Transaction}
use ebecca/types.{AssetClass, PolicyShardDatum, RegistryRootDatum, has_one}

pub type PolicyShardMintRedeemer {
  Mint
  Burn
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
    shard.version == 0,
    shard.config.policy_id == shard.policy_id,
    shard.config.max_policy_exposure_value >= 0,
    shard.config.max_trade_value >= 0,
    shard.config.risk_tier >= 0,
  }
}

validator policy_shard_policy(root_token: AssetClass, shard_address: Address) {
  mint(redeemer: PolicyShardMintRedeemer, policy_id: PolicyId, tx: Transaction) {
    expect [Pair(name, amount)] =
      tx.mint
        |> tokens(policy_id)
        |> dict.to_pairs()
    expect Some(root) = root_from_reference(tx.reference_inputs, root_token)

    let expected_token = AssetClass { policy_id, asset_name: name }

    let creates_bound_shard =
      list.any(
        tx.outputs,
        fn(output) {
          if output.address == shard_address && (
            output.value |> has_one(expected_token)
          ) {
            when output.datum is {
              InlineDatum(data) -> {
                expect shard: PolicyShardDatum = data
                and {
                  shard.root_token == root_token,
                  shard.shard_token == expected_token,
                  name == shard.policy_id,
                  config_is_valid(shard),
                }
              }
              _ -> False
            }
          } else {
            False
          }
        },
      )

    and {
      root.policy_shard_policy == policy_id,
      list.has(tx.extra_signatories, root.admin),
      when redeemer is {
        Mint -> amount == 1 && creates_bound_shard
        Burn -> amount == -1
      },
    }
  }

  else(_) {
    fail
  }
}
