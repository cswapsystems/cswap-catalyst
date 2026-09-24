use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{OutputReference, Transaction}

pub type OneShotRedeemer {
  Mint
}

/// Mints the single named identity token authorized by a consumed seed UTxO.
/// Used for persistent registry and shared-pool identity assets.
validator one_shot(seed: OutputReference, token_name: AssetName) {
  mint(_redeemer: OneShotRedeemer, policy_id: PolicyId, tx: Transaction) {
    let seed_is_spent =
      list.any(tx.inputs, fn(input) { input.output_reference == seed })

    expect [Pair(name, amount)] =
      tx.mint
        |> tokens(policy_id)
        |> dict.to_pairs()

    and {
      seed_is_spent,
      name == token_name,
      amount == 1,
    }
  }

  else(_) {
    fail
  }
}
