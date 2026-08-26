use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}

// Redeemer for STT policy
pub type SttAction {
  Mint
  Burn
}

fn qty(v: assets.Value, pid: PolicyId, an: AssetName) -> Int {
  assets.quantity_of(v, pid, an)
}

// Find whether a given OutputReference is consumed as a *spending input*
fn consumes_ref(self: Transaction, ref: OutputReference) -> Bool {
  self.inputs
    |> list.any(fn(i) { i.output_reference == ref })
}

fn any_input_has_stt(self: Transaction, pid: PolicyId, an: AssetName) -> Bool {
  self.inputs |> list.any(fn(i) { qty(i.output.value, pid, an) == 1 })
}

validator stt_one_shot(seed_ref: OutputReference, stt_name: AssetName) {
  mint(redeemer: SttAction, policy_id: PolicyId, self: Transaction) {
    let m = qty(self.mint, policy_id, stt_name)

    when redeemer is {
      Mint -> {
        expect consumes_ref(self, seed_ref)
        m == 1
      }
      Burn -> {
        expect any_input_has_stt(self, policy_id, stt_name)
        m == -1
      }
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------
// Tests for stt_one_shot
// ------------------------------------------------------------

// Dummy constants for tests
const seed_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

const vault_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 2,
  }

const other_ref: OutputReference =
  OutputReference {
    transaction_id: #"0202020202020202020202020202020202020202020202020202020202020202",
    output_index: 1,
  }

// PolicyId is 28 bytes (56 hex chars); AssetName is a ByteArray (so "STT" is fine).
const policy_id: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const stt_name: AssetName = "STT"

// Minimal Output needed because Input carries a resolved Output.
// Most fields can be placeholders; stt_one_shot only reads input.output_reference and tx.mint.
fn dummy_address() -> Address {
  Address {
    payment_credential: VerificationKey(
      #"00000000000000000000000000000000000000000000000000000000",
    ),
    stake_credential: None,
  }
}

fn dummy_output(v: assets.Value) -> Output {
  Output {
    address: dummy_address(),
    value: v,
    datum: NoDatum,
    reference_script: None,
  }
}

fn mk_input(ref: OutputReference, v: assets.Value) -> Input {
  Input { output_reference: ref, output: dummy_output(v) }
}

fn mk_tx(inputs: List<Input>, mint: assets.Value) -> Transaction {
  // transaction.placeholder is intended exactly for this style of test tx building. :contentReference[oaicite:1]{index=1}
  Transaction { ..transaction.placeholder, inputs, mint }
}

// -------------------
// Positive cases
// -------------------

test stt_mint_ok() {
  let tx =
    mk_tx(
      [mk_input(seed_ref, assets.from_lovelace(5_000_000))],
      assets.from_asset(policy_id, stt_name, 1),
    )

  stt_one_shot.mint(seed_ref, stt_name, Mint, policy_id, tx)
}

test stt_burn_ok() {
  let vault_value =
    assets.from_lovelace(2_000_000) |> assets.add(policy_id, stt_name, 1)

  let tx =
    mk_tx(
      [mk_input(vault_ref, vault_value)],
      assets.from_asset(policy_id, stt_name, -1),
    )

  stt_one_shot.mint(seed_ref, stt_name, Burn, policy_id, tx)
}

// -------------------
// Expected-halt cases (because of `expect consumes_ref(...)`)
// -------------------

test stt_mint_fails_without_seed_ref() fail {
  let tx =
    mk_tx(
      [mk_input(other_ref, assets.from_lovelace(5_000_000))],
      assets.from_asset(policy_id, stt_name, 1),
    )

  // This should halt at: expect consumes_ref(self, seed_ref)
  stt_one_shot.mint(seed_ref, stt_name, Mint, policy_id, tx)
}

test stt_burn_fails_without_stt_input() fail {
  let tx =
    mk_tx(
      [mk_input(other_ref, assets.from_lovelace(2_000_000))],
      assets.from_asset(policy_id, stt_name, -1),
    )

  stt_one_shot.mint(seed_ref, stt_name, Burn, policy_id, tx)
}

// -------------------
// Returns-False cases (wrong quantities)
// -------------------

test stt_mint_wrong_qty_returns_false() {
  let tx =
    mk_tx(
      [mk_input(seed_ref, assets.from_lovelace(5_000_000))],
      assets.from_asset(policy_id, stt_name, 2),
    )

  stt_one_shot.mint(seed_ref, stt_name, Mint, policy_id, tx) == False
}

test stt_burn_wrong_qty_returns_false() {
  let vault_value =
    assets.from_lovelace(2_000_000) |> assets.add(policy_id, stt_name, 1)

  let tx =
    mk_tx(
      [mk_input(vault_ref, vault_value)],
      assets.from_asset(policy_id, stt_name, -2),
    )

  stt_one_shot.mint(seed_ref, stt_name, Burn, policy_id, tx) == False
}
