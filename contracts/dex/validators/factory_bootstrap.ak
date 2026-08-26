use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use ebecca/amm_helpers.{has_one}
use ebecca/dex_types.{
  AssetId, FactoryBootstrapAction, FactoryDatum, MintFactory,
}

/// One-shot factory-state NFT policy.
///
/// Spend the configured seed UTxO exactly once to mint the factory-state NFT
/// and place it at the configured factory-state validator address.
validator factory_bootstrap(
  seed: OutputReference,
  factory_state_address: Address,
  token_name: AssetName,
) {
  mint(action: FactoryBootstrapAction, policy_id: PolicyId, tx: Transaction) {
    let MintFactory = action
    expect [Pair(name, amount)] =
      tx.mint |> tokens(policy_id) |> dict.to_pairs()
    expect [factory_output] =
      list.filter(
        tx.outputs,
        fn(output) {
          output.address == factory_state_address && has_one(
            output.value,
            AssetId { policy_id, asset_name: token_name },
          )
        },
      )
    expect InlineDatum(raw_factory) = factory_output.datum
    expect factory: FactoryDatum = raw_factory

    and {
      list.any(tx.inputs, fn(input) { input.output_reference == seed }),
      name == token_name,
      amount == 1,
      factory.factory_token == AssetId { policy_id, asset_name: token_name },
      factory.pool_nft_policy != "",
      factory.next_pool_id >= 0,
    }
  }

  else(_) {
    False
  }
}
