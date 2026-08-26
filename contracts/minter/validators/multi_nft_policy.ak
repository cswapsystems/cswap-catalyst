use aiken/collection/dict
use aiken/collection/list
use cardano/address
use cardano/assets
use cardano/assets.{AssetName, PolicyId, Value, from_asset, tokens}
use cardano/transaction
use cardano/transaction.{Input, OutputReference, Transaction, Output, NoDatum}

pub type MultiRedeemer {
  Mint { names: List<AssetName> }
  Burn
}

// Enforce one-shot mint by requiring the seed UTxO to be consumed.
fn has_input(self: Transaction, seed: OutputReference) -> Bool {
  list.any(self.inputs, fn(i) { i.output_reference == seed })
}

// helper function which checks if asset name is on the given list
fn contains_asset_name(seen: List<AssetName>, tn: AssetName) -> Bool {
  list.any(seen, fn(x) { x == tn })
}

// recursive function to check if there's a duplicate asset name
fn no_dups_go(xs: List<AssetName>, seen: List<AssetName>) -> Bool {
  when xs is {
    [] -> True
    [h, ..t] ->
      if contains_asset_name(seen, h) {
        False
      } else {
        no_dups_go(t, [h, ..seen])
      }
  }
}

// function to check if there are not duplicate names
fn no_duplicate_token_names(names: List<AssetName>) -> Bool {
  no_dups_go(names, [])
}

// helper: true if a given asset name + quantity pair appears in the list.
fn pair_contains(
  pairs: List<Pair<AssetName, Int>>,
  tn: AssetName,
  qty: Int,
) -> Bool {
  list.any(
    pairs,
    fn(p) {
      let Pair(a, q) = p
      a == tn && q == qty
    },
  )
}

// Redeemer is token names; required minted qty is always 1.
// True iff minted tokens match the redeemer list (set equality on name+qty).
fn exact_match_nft_names(
  minted_pairs: List<Pair<AssetName, Int>>,
  names: List<AssetName>,
) -> Bool {
  let spec_pairs = list.map(names, fn(tn) { Pair(tn, 1) })

  list.length(minted_pairs) == list.length(spec_pairs) && list.all(
    minted_pairs,
    fn(p) {
      let Pair(a, q) = p
      pair_contains(spec_pairs, a, q)
    },
  ) && list.all(
    spec_pairs,
    fn(p) {
      let Pair(a, q) = p
      pair_contains(minted_pairs, a, q)
    },
  )
}

validator multi_oneshot(seed: OutputReference) {
  mint(redeemer: MultiRedeemer, policy_id: PolicyId, self: Transaction) {
    // Restrict mint to this policy id and ensure all minted assets are listed.
    let minted_pairs =
      self.mint
        |> tokens(policy_id)
        |> dict.to_pairs()

    when redeemer is {
      Burn ->
        // Allow burns without consuming the seed.
        list.length(minted_pairs) > 0 && list.all(
          minted_pairs,
          fn(p) {
            let Pair(_, q) = p
            q < 0
          },
        )
      Mint { names } ->
        list.length(names) > 0
          && has_input(self, seed)
          && no_duplicate_token_names(names)
          && exact_match_nft_names(minted_pairs, names)
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------
// Tests for multi_nft_policy
// ------------------------------------------------------------

const policy_id: PolicyId =
  #"99999999999999999999999999999999999999999999999999999999"

const name_a: AssetName = "A"
const name_b: AssetName = "B"

const seed_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

fn dummy_address() -> address.Address {
  address.Address {
    payment_credential: address.VerificationKey(
      #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    stake_credential: None,
  }
}

fn mk_input(oref: OutputReference) -> Input {
  Input {
    output_reference: oref,
    output: Output {
      address: dummy_address(),
      value: assets.from_lovelace(2_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn mk_tx(inputs: List<Input>, mint: Value) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    mint,
  }
}

test mint_ok() {
  let mint_value =
    from_asset(policy_id, name_a, 1)
      |> assets.add(policy_id, name_b, 1)

  let tx = mk_tx([mk_input(seed_ref)], mint_value)
  let redeemer: MultiRedeemer = Mint { names: [name_a, name_b] }

  multi_oneshot.mint(seed_ref, redeemer, policy_id, tx)
}

test mint_fails_without_seed_returns_false() {
  let mint_value =
    from_asset(policy_id, name_a, 1)
      |> assets.add(policy_id, name_b, 1)

  let tx = mk_tx([], mint_value)
  let redeemer: MultiRedeemer = Mint { names: [name_a, name_b] }

  multi_oneshot.mint(seed_ref, redeemer, policy_id, tx) == False
}

test mint_fails_with_mismatched_names_returns_false() {
  let mint_value = from_asset(policy_id, name_a, 1)

  let tx = mk_tx([mk_input(seed_ref)], mint_value)
  let redeemer: MultiRedeemer = Mint { names: [name_a, name_b] }

  multi_oneshot.mint(seed_ref, redeemer, policy_id, tx) == False
}

test burn_ok() {
  let mint_value = from_asset(policy_id, name_a, -1)

  let tx = mk_tx([], mint_value)
  let redeemer: MultiRedeemer = Burn

  multi_oneshot.mint(seed_ref, redeemer, policy_id, tx)
}

test burn_fails_with_positive_mint_returns_false() {
  let mint_value = from_asset(policy_id, name_a, 1)

  let tx = mk_tx([], mint_value)
  let redeemer: MultiRedeemer = Burn

  multi_oneshot.mint(seed_ref, redeemer, policy_id, tx) == False
}
