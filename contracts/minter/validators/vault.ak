// vault.ak
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address
use cardano/assets
use cardano/assets.{AssetName, PolicyId, Value, quantity_of, from_asset}
use cardano/transaction
use cardano/transaction.{Input, OutputReference, Transaction, Output, NoDatum, find_input, InlineDatum}

// Datum for the vault UTxO that holds a single NFT and tracks its fractions.
pub type VaultDatum {
  // Original owner receives the NFT during an approved partial recovery.
  owner: address.Address,

  // Team key hash that authorizes emergency recovery when fractions are lost.
  recovery_admin: VerificationKeyHash,

  // The NFT locked in this vault UTxO
  nft_policy: PolicyId,
  nft_name: AssetName,

  // The fungible token representing fractions
  ft_policy: PolicyId,
  ft_name: AssetName,

  // Total supply of fractions that must be burned to withdraw the NFT
  total_fractions: Int,

  // Seed UTxO used to parameterize the fraction minting policy
  seed: OutputReference,
}

// A normal withdrawal burns the full supply. Emergency recovery burns the
// claimant's available fractions, requires the team key, and returns the NFT
// only to the original owner recorded at fractionalization time.
pub type VaultRedeemer {
  Withdraw
  EmergencyRecover { fractions_burned: Int }
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

fn nft_paid_to_owner(self: Transaction, d: VaultDatum) -> Bool {
  list.any(self.outputs, fn(o) {
    o.address == d.owner && has_nft(o.value, d.nft_policy, d.nft_name)
  })
}

fn signed_by(self: Transaction, admin: VerificationKeyHash) -> Bool {
  list.has(self.extra_signatories, admin)
}

fn emergency_recovery_is_valid(
  self: Transaction,
  d: VaultDatum,
  fractions_burned: Int,
) -> Bool {
  fractions_burned > 0
    && fractions_burned < d.total_fractions
    && signed_by(self, d.recovery_admin)
    && self.mint == from_asset(d.ft_policy, d.ft_name, -fractions_burned)
    && nft_paid_to_owner(self, d)
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
      EmergencyRecover { fractions_burned } ->
        emergency_recovery_is_valid(self, d, fractions_burned)
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
    owner: pubkey_address(),
    recovery_admin: admin,
    nft_policy,
    nft_name,
    ft_policy,
    ft_name,
    total_fractions: total,
    seed: vault_ref,
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

test emergency_recovery_ok() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)
  let output = Output { address: pubkey_address(), value: vault_value(), datum: NoDatum, reference_script: None }
  let tx = mk_tx([input], [output], from_asset(ft_policy, ft_name, -600), [admin])

  vault.spend(Some(d), EmergencyRecover { fractions_burned: 600 }, vault_ref, tx)
}

test emergency_recovery_fails_without_team_signature() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)
  let output = Output { address: pubkey_address(), value: vault_value(), datum: NoDatum, reference_script: None }
  let tx = mk_tx([input], [output], from_asset(ft_policy, ft_name, -600), [])

  vault.spend(Some(d), EmergencyRecover { fractions_burned: 600 }, vault_ref, tx)
    == False
}

test emergency_recovery_rejects_full_supply() {
  let d = datum(1_000)
  let input = mk_input(vault_value(), d)
  let output = Output { address: pubkey_address(), value: vault_value(), datum: NoDatum, reference_script: None }
  let tx = mk_tx([input], [output], from_asset(ft_policy, ft_name, -1_000), [admin])

  vault.spend(Some(d), EmergencyRecover { fractions_burned: 1_000 }, vault_ref, tx)
    == False
}
