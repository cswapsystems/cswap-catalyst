use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{Transaction}
use ebecca/types.{AssetClass, has_one}

pub type LpRedeemer {
  MintLp
  BurnLp
}

/// Allows LP minting or burning only alongside the matching pool state input.
/// Exact share accounting and provider payouts are enforced by `quote_pool`.
validator lp_policy(vault_token: AssetClass, lp_name: AssetName) {
  mint(redeemer: LpRedeemer, policy_id: PolicyId, tx: Transaction) {
    let vault_participates =
      list.any(
        tx.inputs,
        fn(input) { input.output.value |> has_one(vault_token) },
      )

    expect [Pair(name, amount)] =
      tx.mint
        |> tokens(policy_id)
        |> dict.to_pairs()

    and {
      vault_participates,
      name == lp_name,
      when redeemer is {
        MintLp -> amount > 0
        BurnLp -> amount < 0
      },
    }
  }

  else(_) {
    fail
  }
}
