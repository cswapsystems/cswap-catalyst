use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets
use cardano/assets.{AssetName, PolicyId, tokens}
use cardano/address
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}
use ebecca/types.{AssetClass, has_one}

pub type InventoryRedeemer {
  MintInventory
  BurnInventory
}

/// Mints one receipt for each batcher-acquired pool listing and permits burns
/// when that listing is sold or returned during LP wind-down. The pool
/// validator authenticates the matching listing and accounting transition.
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
        BurnInventory -> amount < 0
      },
    }
  }

  else(_) {
    fail
  }
}

const test_pool_token: AssetClass =
  AssetClass {
    policy_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    asset_name: "POOL",
  }

const test_receipt_policy: PolicyId =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const test_receipt_name: AssetName = "RECEIPT"

const test_batcher: VerificationKeyHash =
  #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

const test_pool_ref: OutputReference =
  OutputReference {
    transaction_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    output_index: 0,
  }

fn pool_input() -> Input {
  Input {
    output_reference: test_pool_ref,
    output: Output {
      address: address.Address {
        payment_credential: address.Script(
          #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ),
        stake_credential: None,
      },
      value: assets.from_lovelace(3_000_000)
        |> assets.add(
          test_pool_token.policy_id,
          test_pool_token.asset_name,
          1,
        ),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn test_tx(mint: assets.Value, signers: List<VerificationKeyHash>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [pool_input()],
    mint,
    extra_signatories: signers,
  }
}

test inventory_receipt_mint_requires_batcher_signature() {
  let mint = assets.zero |> assets.add(
    test_receipt_policy,
    test_receipt_name,
    1,
  )
  let valid =
    inventory_policy.mint(
      test_pool_token,
      test_receipt_name,
      test_batcher,
      MintInventory,
      test_receipt_policy,
      test_tx(mint, [test_batcher]),
    )
  let missing_signature =
    inventory_policy.mint(
      test_pool_token,
      test_receipt_name,
      test_batcher,
      MintInventory,
      test_receipt_policy,
      test_tx(mint, []),
    )

  and {
    valid,
    missing_signature == False,
  }
}

test inventory_receipt_burn_allows_batch_exit_burns() {
  let mint = assets.zero |> assets.add(
    test_receipt_policy,
    test_receipt_name,
    -1,
  )

  and {
    inventory_policy.mint(
      test_pool_token,
      test_receipt_name,
      test_batcher,
      BurnInventory,
      test_receipt_policy,
      test_tx(mint, []),
    ),
    inventory_policy.mint(
      test_pool_token,
      test_receipt_name,
      test_batcher,
      BurnInventory,
      test_receipt_policy,
      test_tx(assets.zero |> assets.add(test_receipt_policy, test_receipt_name, -2), []),
    )
  }
}

// A zero quantity leaves no entry under the policy, so the policy aborts.
test inventory_receipt_policy_rejects_empty_mint() fail {
  inventory_policy.mint(
    test_pool_token,
    test_receipt_name,
    test_batcher,
    BurnInventory,
    test_receipt_policy,
    test_tx(assets.zero, []),
  )
}
