use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, ScriptHash}
use cardano/address
use cardano/assets
use cardano/assets.{AssetName, PolicyId, Value, from_asset}
use cardano/transaction
use cardano/transaction.{Input, OutputReference, Transaction, Output, NoDatum, InlineDatum}

pub type VaultDatum {
  admin: VerificationKeyHash,
  nft_policy: PolicyId,
  nft_name: AssetName,
  ft_policy: PolicyId,
  ft_name: AssetName,
  total_fractions: Int,
}

// One-shot mint for the full fraction supply; later burns are allowed.
pub type FtRedeemer {
  Mint { total_fractions: Int, ft_name: AssetName }
  Burn { ft_name: AssetName }
}

// Ensure the seed UTxO is consumed to authorize the one-shot mint.
fn has_input(tx: Transaction, oref: OutputReference) -> Bool {
  list.any(tx.inputs, fn(i) { i.output_reference == oref })
}

fn has_matching_vault_output(
  tx: Transaction,
  policy_id: PolicyId,
  vault_script: ScriptHash,
  ft_name: AssetName,
  total_fractions: Int,
) -> Bool {
  list.any(tx.outputs, fn(o) {
    when o.datum is {
      InlineDatum(raw_datum) -> {
        expect d: VaultDatum = raw_datum
        d.ft_policy == policy_id
          && d.ft_name == ft_name
          && d.total_fractions == total_fractions
          && assets.quantity_of(o.value, d.nft_policy, d.nft_name) == 1
          && when o.address.payment_credential is {
            address.Script(script_hash) -> script_hash == vault_script
            _ -> False
          }
      }
      _ -> False
    }
  })
}

validator ft_oneshot(seed: OutputReference, vault_script: ScriptHash) {
  mint(redeemer: FtRedeemer, policy_id: PolicyId, self: Transaction) {
    when redeemer is {
      Mint { total_fractions, ft_name } ->
        total_fractions > 0
          && has_input(self, seed)
          && self.mint == from_asset(policy_id, ft_name, total_fractions)
          && has_matching_vault_output(
            self,
            policy_id,
            vault_script,
            ft_name,
            total_fractions,
          )

      // Any negative mint for the FT is treated as a burn.
      Burn { ft_name } -> assets.quantity_of(self.mint, policy_id, ft_name) < 0
    }
  }

  else(_) {
    fail
  }
}

// ------------------------------------------------------------
// Tests for ft_policy
// ------------------------------------------------------------

const policy_id: PolicyId =
  #"88888888888888888888888888888888888888888888888888888888"

const nft_policy: PolicyId =
  #"99999999999999999999999999999999999999999999999999999999"

const ft_name: AssetName = "FT"
const nft_name: AssetName = "NFT"

const admin: VerificationKeyHash =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const vault_script_hash: ScriptHash =
  #"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

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

fn dummy_script_address() -> address.Address {
  address.Address {
    payment_credential: address.Script(
      #"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    ),
    stake_credential: None,
  }
}

fn mk_vault_datum(total_fractions: Int) -> VaultDatum {
  VaultDatum {
    admin,
    nft_policy,
    nft_name,
    ft_policy: policy_id,
    ft_name,
    total_fractions,
  }
}

fn vault_output(total_fractions: Int) -> Output {
  Output {
    address: dummy_script_address(),
    value: assets.from_lovelace(2_000_000) |> assets.add(nft_policy, nft_name, 1),
    datum: InlineDatum(mk_vault_datum(total_fractions)),
    reference_script: None,
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

fn mk_tx(inputs: List<Input>, outputs: List<Output>, mint: Value) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs,
    outputs,
    mint,
  }
}

test mint_ok() {
  let mint_value = from_asset(policy_id, ft_name, 1_000)
  let tx = mk_tx([mk_input(seed_ref)], [vault_output(1_000)], mint_value)

  ft_oneshot.mint(
    seed_ref,
    vault_script_hash,
    Mint { total_fractions: 1_000, ft_name },
    policy_id,
    tx,
  )
}

test mint_fails_without_seed_returns_false() {
  let mint_value = from_asset(policy_id, ft_name, 1_000)
  let tx = mk_tx([], [vault_output(1_000)], mint_value)

  ft_oneshot.mint(
    seed_ref,
    vault_script_hash,
    Mint { total_fractions: 1_000, ft_name },
    policy_id,
    tx,
  )
    == False
}

test mint_fails_wrong_amount_returns_false() {
  let mint_value = from_asset(policy_id, ft_name, 999)
  let tx = mk_tx([mk_input(seed_ref)], [vault_output(1_000)], mint_value)

  ft_oneshot.mint(
    seed_ref,
    vault_script_hash,
    Mint { total_fractions: 1_000, ft_name },
    policy_id,
    tx,
  )
    == False
}

test mint_fails_without_vault_nft_returns_false() {
  let mint_value = from_asset(policy_id, ft_name, 1_000)
  let out =
    Output {
      address: dummy_script_address(),
      value: assets.from_lovelace(2_000_000),
      datum: InlineDatum(mk_vault_datum(1_000)),
      reference_script: None,
    }
  let tx = mk_tx([mk_input(seed_ref)], [out], mint_value)

  ft_oneshot.mint(
    seed_ref,
    vault_script_hash,
    Mint { total_fractions: 1_000, ft_name },
    policy_id,
    tx,
  )
    == False
}

test mint_fails_datum_supply_mismatch_returns_false() {
  let mint_value = from_asset(policy_id, ft_name, 1_000)
  let tx = mk_tx([mk_input(seed_ref)], [vault_output(999)], mint_value)

  ft_oneshot.mint(
    seed_ref,
    vault_script_hash,
    Mint { total_fractions: 1_000, ft_name },
    policy_id,
    tx,
  )
    == False
}

test mint_fails_wrong_vault_script_hash_returns_false() {
  let mint_value = from_asset(policy_id, ft_name, 1_000)
  let tx = mk_tx([mk_input(seed_ref)], [vault_output(1_000)], mint_value)

  ft_oneshot.mint(
    seed_ref,
    #"efefefefefefefefefefefefefefefefefefefefefefefefefefefef",
    Mint { total_fractions: 1_000, ft_name },
    policy_id,
    tx,
  )
    == False
}

test burn_ok() {
  let mint_value = from_asset(policy_id, ft_name, -10)
  let tx = mk_tx([], [], mint_value)

  ft_oneshot.mint(seed_ref, vault_script_hash, Burn { ft_name }, policy_id, tx)
}

test burn_fails_with_positive_mint_returns_false() {
  let mint_value = from_asset(policy_id, ft_name, 10)
  let tx = mk_tx([], [], mint_value)

  ft_oneshot.mint(seed_ref, vault_script_hash, Burn { ft_name }, policy_id, tx)
    == False
}
