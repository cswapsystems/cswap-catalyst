use aiken/collection/dict
use aiken/collection/list
use cardano/address
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}

pub type OneShotRedeemer {
  Mint
}

/// Mints the single named identity token authorized by a consumed seed UTxO.
/// Used for persistent registry and shared-pool identity assets. Burning is
/// allowed without the seed: the token only leaves its script address when the
/// holding validator permits it (e.g. shared-pool closure), and every
/// continuing registry/pool output must keep it.
validator one_shot(seed: OutputReference, token_name: AssetName) {
  mint(_redeemer: OneShotRedeemer, policy_id: PolicyId, tx: Transaction) {
    let seed_is_spent =
      list.any(tx.inputs, fn(input) { input.output_reference == seed })

    expect [Pair(name, amount)] =
      tx.mint
        |> tokens(policy_id)
        |> dict.to_pairs()

    and {
      name == token_name,
      or {
        and {
          seed_is_spent,
          amount == 1,
        },
        amount == -1,
      },
    }
  }

  else(_) {
    fail
  }
}

const test_seed: OutputReference =
  OutputReference {
    transaction_id: #"0000000000000000000000000000000000000000000000000000000000000000",
    output_index: 0,
  }

const test_policy: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

fn test_tx(spends_seed: Bool, amount: Int, name: AssetName) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: if spends_seed {
      [
        Input {
          output_reference: test_seed,
          output: Output {
            address: address.from_verification_key(
              #"22222222222222222222222222222222222222222222222222222222",
            ),
            value: assets.from_lovelace(5_000_000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ]
    } else {
      []
    },
    mint: assets.from_asset(test_policy, name, amount),
  }
}

test one_shot_mints_once_with_seed() {
  one_shot.mint(test_seed, "POOL", Mint, test_policy, test_tx(True, 1, "POOL"))
}

test one_shot_rejects_mint_without_seed() fail {
  one_shot.mint(test_seed, "POOL", Mint, test_policy, test_tx(False, 1, "POOL"))
}

test one_shot_rejects_second_token() fail {
  one_shot.mint(test_seed, "POOL", Mint, test_policy, test_tx(True, 2, "POOL"))
}

test one_shot_allows_identity_burn() {
  one_shot.mint(test_seed, "POOL", Mint, test_policy, test_tx(False, -1, "POOL"))
}

test one_shot_rejects_other_name() fail {
  one_shot.mint(test_seed, "POOL", Mint, test_policy, test_tx(False, -1, "OTHER"))
}
