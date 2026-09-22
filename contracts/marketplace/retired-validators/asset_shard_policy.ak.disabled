use aiken/builtin
use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{blake2b_256}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{InlineDatum, Input, Transaction}
use ebecca/types.{AssetClass, AssetShardDatum, RegistryRootDatum, has_one}

pub type AssetShardMintRedeemer {
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

fn asset_shard_name(asset: AssetClass) -> AssetName {
  builtin.append_bytearray(asset.policy_id, asset.asset_name)
    |> blake2b_256
}

fn config_is_valid(shard: AssetShardDatum) -> Bool {
  and {
    shard.version == 0,
    shard.config.asset == shard.asset,
    shard.config.max_asset_exposure_value >= 0,
    shard.config.max_trade_value >= 0,
  }
}

validator asset_shard_policy(root_token: AssetClass, shard_address: Address) {
  mint(redeemer: AssetShardMintRedeemer, policy_id: PolicyId, tx: Transaction) {
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
                expect shard: AssetShardDatum = data
                and {
                  shard.root_token == root_token,
                  shard.shard_token == expected_token,
                  name == asset_shard_name(shard.asset),
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
      root.asset_shard_policy == policy_id,
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
