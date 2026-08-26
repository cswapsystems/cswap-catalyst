// vault.ak
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address
use cardano/assets
use cardano/assets.{AssetName, PolicyId, Value, quantity_of, from_asset, is_zero}
use cardano/transaction
use cardano/transaction.{Input, OutputReference, Transaction, Output, NoDatum, find_input, InlineDatum}

// Datum for the vault UTxO that holds a single NFT and tracks its fractions.
pub type VaultDatum {
  // Admin key hash allowed to update total_fractions
  admin: VerificationKeyHash,

  // The NFT locked in this vault UTxO
  nft_policy: PolicyId,
  nft_name: AssetName,

  // The fungible token representing fractions
  ft_policy: PolicyId,
  ft_name: AssetName,

  // Total supply of fractions that must be burned to withdraw the NFT
  total_fractions: Int,
}

// Actions: withdraw burns all fractions; update adjusts total_fractions only.
pub type VaultRedeemer {
  Withdraw
  Update { new_total_fractions: Int }
}

// ---- helpers

fn has_nft(v: Value, policy: PolicyId, name: AssetName) -> Bool {
  quantity_of(v, policy, name) == 1
}

// The mint field must be only the FT burn for the full supply.
fn burns_exactly_all_fractions(self: Transaction, d: VaultDatum) -> Bool {
  d.total_fractions > 0
    // must burn EXACTLY total_fractions of the single FT asset and nothing else
    && self.mint == from_asset(d.ft_policy, d.ft_name, -d.total_fractions)
}

// Require the NFT to be paid to a pubkey address (not a script).
fn nft_paid_to_pubkey(self: Transaction, d: VaultDatum) -> Bool {
  list.any(self.outputs, fn(o) {
    has_nft(o.value, d.nft_policy, d.nft_name)
      && when o.address.payment_credential is {
        address.VerificationKey(_) -> True
        _ -> False
      }
  })
}

fn signed_by(self: Transaction, admin: VerificationKeyHash) -> Bool {
  list.has(self.extra_signatories, admin)
}

fn find_continuing_output(self: Transaction, addr: address.Address) -> Option<Output> {
  list.find(self.outputs, fn(o) { o.address == addr })
}

// Update keeps all fields identical except total_fractions, and keeps NFT locked.
fn update_is_valid(self: Transaction, d: VaultDatum, input: Input, new_total: Int) -> Bool {
  new_total > 0
    && signed_by(self, d.admin)
    && is_zero(self.mint)
    && when find_continuing_output(self, input.output.address) is {
      Some(out) -> {
        expect has_nft(out.value, d.nft_policy, d.nft_name)
        expect InlineDatum(out_datum) = out.datum
        expect new_datum: VaultDatum = out_datum

        new_datum.admin == d.admin
          && new_datum.nft_policy == d.nft_policy
          && new_datum.nft_name == d.nft_name
          && new_datum.ft_policy == d.ft_policy
          && new_datum.ft_name == d.ft_name
          && new_datum.total_fractions == new_total
      }
      None -> False
    }
}

// ---- validator

validator vault {
  spend(datum: Option<VaultDatum>, redeemer: VaultRedeemer, utxo: OutputReference, self: Transaction) {
    expect Some(d) = datum

    // Find the script's own input being spent
    expect Some(input) =
      self.inputs
        |> find_input(utxo)

    // The vault UTxO must actually hold the NFT
    expect has_nft(input.output.value, d.nft_policy, d.nft_name)

    when redeemer is {
      Withdraw ->
        burns_exactly_all_fractions(self, d)
          && nft_paid_to_pubkey(self, d)
      Update { new_total_fractions } ->
        update_is_valid(self, d, input, new_total_fractions)
    }
  }
}

// ------------------------------------------------------------
// Tests for vault
// ------------------------------------------------------------

const admin: VerificationKeyHash =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const nft_policy: PolicyId =
  #"11111111111111111111111111111111111111111111111111111111"

const ft_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const other_policy: PolicyId =
  #"33333333333333333333333333333333333333333333333333333333"

const nft_name: AssetName = "NFT"
const ft_name: AssetName = "FT"
const other_name: AssetName = "OTHER"

const vault_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

fn script_address() -> address.Address {
  address.Address {
    payment_credential: address.Script(
      #"abababababababababababababababababababababababababababab",
    ),
    stake_credential: None,
  }
}

fn pubkey_address() -> address.Address {
  address.Address {
    payment_credential: address.VerificationKey(
      #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
    stake_credential: None,
  }
}

fn vault_value() -> Value {
  assets.from_lovelace(2_000_000)
    |> assets.add(nft_policy, nft_name, 1)
}

fn datum(total: Int) -> VaultDatum {
  VaultDatum {
    admin,
    nft_policy,
    nft_name,
    ft_policy,
    ft_name,
    total_fractions: total,
  }
}

fn mk_input(v: Value, d: VaultDatum) -> Input {
  Input {
    output_reference: vault_ref,
    output: Output {
      address: script_address(),
      value: v,
      datum: InlineDatum(d),
      reference_script: None,
    },
  }
}

fn mk_tx(
  inputs: List<Input>,
  outputs: List<Output>,
  mint: Value,
  sigs: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    outputs,
    mint,
    extra_signatories: sigs,
  }
}

test withdraw_ok() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)

  let outputs =
    [
      Output {
        address: pubkey_address(),
        value: vault_value(),
        datum: NoDatum,
        reference_script: None,
      },
    ]

  let tx =
    mk_tx(
      [input],
      outputs,
      from_asset(ft_policy, ft_name, -1_000),
      [],
    )

  vault.spend(Some(d), Withdraw, vault_ref, tx)
}

test withdraw_fails_extra_mint_returns_false() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)

  let outputs =
    [
      Output {
        address: pubkey_address(),
        value: vault_value(),
        datum: NoDatum,
        reference_script: None,
      },
    ]

  let mint =
    from_asset(ft_policy, ft_name, -1_000)
      |> assets.add(other_policy, other_name, 1)

  let tx = mk_tx([input], outputs, mint, [])

  vault.spend(Some(d), Withdraw, vault_ref, tx) == False
}

test update_ok() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)
  let new_d = datum(2_000)

  let outputs =
    [
      Output {
        address: script_address(),
        value: vault_value(),
        datum: InlineDatum(new_d),
        reference_script: None,
      },
    ]

  let tx =
    mk_tx(
      [input],
      outputs,
      assets.zero,
      [admin],
    )

  vault.spend(Some(d), Update { new_total_fractions: 2_000 }, vault_ref, tx)
}

test update_fails_without_signature_returns_false() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)
  let new_d = datum(2_000)

  let outputs =
    [
      Output {
        address: script_address(),
        value: vault_value(),
        datum: InlineDatum(new_d),
        reference_script: None,
      },
    ]

  let tx = mk_tx([input], outputs, assets.zero, [])

  vault.spend(Some(d), Update { new_total_fractions: 2_000 }, vault_ref, tx)
    == False
}

test update_fails_without_continuing_output_returns_false() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)

  let outputs =
    [
      Output {
        address: pubkey_address(),
        value: vault_value(),
        datum: NoDatum,
        reference_script: None,
      },
    ]

  let tx = mk_tx([input], outputs, assets.zero, [admin])

  vault.spend(Some(d), Update { new_total_fractions: 2_000 }, vault_ref, tx)
    == False
}

test update_fails_without_inline_datum() fail {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)

  let outputs =
    [
      Output {
        address: script_address(),
        value: vault_value(),
        datum: NoDatum,
        reference_script: None,
      },
    ]

  let tx = mk_tx([input], outputs, assets.zero, [admin])

  vault.spend(Some(d), Update { new_total_fractions: 2_000 }, vault_ref, tx)
}

test update_fails_without_nft_in_output() fail {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)
  let new_d = datum(2_000)

  let outputs =
    [
      Output {
        address: script_address(),
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(new_d),
        reference_script: None,
      },
    ]

  let tx = mk_tx([input], outputs, assets.zero, [admin])

  vault.spend(Some(d), Update { new_total_fractions: 2_000 }, vault_ref, tx)
}
