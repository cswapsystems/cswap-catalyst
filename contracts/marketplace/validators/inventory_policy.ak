use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{Transaction}
use ebecca/types.{AssetClass, has_one}

pub type InventoryRedeemer {
  MintInventory
  BurnInventory
}

validator inventory_policy(
  pool_token: AssetClass,
  inventory_name: AssetName,
  batcher: VerificationKeyHash,
) {
  mint(redeemer: InventoryRedeemer, policy_id: PolicyId, tx: Transaction) {
    let pool_participates =
      list.any(
        tx.inputs,
        fn(input) { input.output.value |> has_one(pool_token) },
      )

    expect [Pair(name, amount)] =
      tx.mint
        |> tokens(policy_id)
        |> dict.to_pairs()

    and {
      pool_participates,
      name == inventory_name,
      when redeemer is {
        MintInventory ->
          and {
            amount == 1,
            list.has(tx.extra_signatories, batcher),
          }
        BurnInventory -> amount == -1
      },
    }
  }

  else(_) {
    fail
  }
}
