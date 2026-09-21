use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use ebecca/types.{AssetClass, has_one}

// A bounded issuer-approved asset list. Identity and issuer are script parameters.
pub type RegistryDatum {
  version: Int,
  entries: List<AssetClass>,
}

pub type RegistryAction {
  Register { asset: AssetClass }
  Revoke { asset: AssetClass }
  RegisterMany { assets: List<AssetClass> }
}

fn valid_asset(asset: AssetClass) -> Bool {
  bytearray.length(asset.policy_id) == 28 && bytearray.length(asset.asset_name) <= 32
}

fn valid_entries(entries: List<AssetClass>) -> Bool {
  list.length(entries) <= 50 && list.all(entries, valid_asset) && list.length(
    list.unique(entries),
  ) == list.length(entries)
}


fn prepend_all(new_entries: List<AssetClass>, entries: List<AssetClass>) -> List<AssetClass> {
  when new_entries is {
    [] -> entries
    [entry, ..rest] -> [entry, ..prepend_all(rest, entries)]
  }
}
validator asset_registry(
  registry_token: AssetClass,
  issuer: VerificationKeyHash,
) {
  spend(
    datum: Option<RegistryDatum>,
    action: RegistryAction,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(current) = datum
    expect Some(own) = find_input(tx.inputs, own_ref)
    expect [continuing] =
      list.filter(
        tx.outputs,
        fn(output) { output.value |> has_one(registry_token) },
      )
    expect InlineDatum(raw) = continuing.datum
    expect next: RegistryDatum = raw
    let expected =
      when action is {
        Register { asset } -> {
          expect valid_asset(asset)
          expect !list.has(current.entries, asset)
          [asset, ..current.entries]
        }
        Revoke { asset } -> {
          expect list.has(current.entries, asset)
          list.filter(current.entries, fn(entry) { entry != asset })
        }
        RegisterMany { assets } -> {
          expect list.length(assets) > 0
          expect list.all(assets, valid_asset)
          expect list.length(list.unique(assets)) == list.length(assets)
          expect list.all(assets, fn(asset) { !list.has(current.entries, asset) })
          prepend_all(assets, current.entries)
        }
      }
    and {
      list.has(tx.extra_signatories, issuer),
      own.output.value |> has_one(registry_token),
      assets.is_zero(tx.mint),
      continuing.address == own.output.address,
      assets.without_lovelace(continuing.value) == assets.without_lovelace(
        own.output.value,
      ),
      assets.lovelace_of(continuing.value) >= assets.lovelace_of(
        own.output.value,
      ),
      current.version >= 0,
      valid_entries(current.entries),
      next.version == current.version + 1,
      next.entries == expected,
      valid_entries(next.entries),
    }
  }

  else(_) {
    fail
  }
}

const issuer_key: VerificationKeyHash =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const identity: AssetClass =
  AssetClass {
    policy_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    asset_name: "REGISTRY",
  }

const asset_a: AssetClass =
  AssetClass {
    policy_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    asset_name: "A",
  }

const asset_b: AssetClass = AssetClass { ..asset_a, asset_name: "B" }

const own_ref: OutputReference =
  OutputReference {
    transaction_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    output_index: 0,
  }

fn fixture(current: RegistryDatum, next: RegistryDatum) -> Transaction {
  let addr =
    address.from_script(
      #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    )
  let value =
    assets.from_lovelace(5_000_000)
      |> assets.add(identity.policy_id, identity.asset_name, 1)
  let output =
    Output {
      address: addr,
      value,
      datum: InlineDatum(current),
      reference_script: None,
    }
  Transaction {
    ..transaction.placeholder,
    inputs: [Input { output_reference: own_ref, output }],
    outputs: [Output { ..output, datum: InlineDatum(next) }],
    extra_signatories: [issuer_key],
  }
}

fn empty() -> RegistryDatum {
  RegistryDatum { version: 0, entries: [] }
}

fn registered() -> RegistryDatum {
  RegistryDatum { version: 1, entries: [asset_a] }
}

fn run(tx: Transaction) -> Bool {
  asset_registry.spend(
    identity,
    issuer_key,
    Some(empty()),
    Register { asset: asset_a },
    own_ref,
    tx,
  )
}

test register_ok() {
  run(fixture(empty(), registered()))
}

test register_many_ok() {
  let next = RegistryDatum { version: 1, entries: [asset_a, asset_b] }
  asset_registry.spend(
    identity,
    issuer_key,
    Some(empty()),
    RegisterMany { assets: [asset_a, asset_b] },
    own_ref,
    fixture(empty(), next),
  )
}

test empty_batch_rejected() fail {
  asset_registry.spend(
    identity,
    issuer_key,
    Some(empty()),
    RegisterMany { assets: [] },
    own_ref,
    fixture(empty(), empty()),
  )
}

test revoke_ok() {
  let next = RegistryDatum { version: 2, entries: [] }
  asset_registry.spend(
    identity,
    issuer_key,
    Some(registered()),
    Revoke { asset: asset_a },
    own_ref,
    fixture(registered(), next),
  )
}

test unsigned_update_rejected() {
  !run(Transaction { ..fixture(empty(), registered()), extra_signatories: [] })
}

test wrong_issuer_rejected() {
  !asset_registry.spend(
    identity,
    asset_a.policy_id,
    Some(empty()),
    Register { asset: asset_a },
    own_ref,
    fixture(empty(), registered()),
  )
}

test version_must_increment() {
  !run(fixture(empty(), RegistryDatum { version: 0, entries: [asset_a] }))
}

test unrelated_entry_rejected() {
  !run(fixture(empty(), RegistryDatum { version: 1, entries: [asset_b] }))
}

test duplicate_registration_rejected() fail {
  asset_registry.spend(
    identity,
    issuer_key,
    Some(registered()),
    Register { asset: asset_a },
    own_ref,
    fixture(
      registered(),
      RegistryDatum { version: 2, entries: [asset_a, asset_a] },
    ),
  )
}

test missing_revocation_rejected() fail {
  asset_registry.spend(
    identity,
    issuer_key,
    Some(empty()),
    Revoke { asset: asset_a },
    own_ref,
    fixture(empty(), RegistryDatum { version: 1, entries: [] }),
  )
}

test registry_cannot_be_closed() fail {
  run(Transaction { ..fixture(empty(), registered()), outputs: [] })
}

test identity_cannot_be_minted_or_burned() {
  !run(
    Transaction {
      ..fixture(empty(), registered()),
      mint: assets.from_asset(identity.policy_id, identity.asset_name, 1),
    },
  )
}

test fake_input_without_identity_rejected() {
  let tx = fixture(empty(), registered())
  expect [input] = tx.inputs
  let fake =
    Input {
      ..input,
      output: Output { ..input.output, value: assets.from_lovelace(5_000_000) },
    }
  !run(Transaction { ..tx, inputs: [fake] })
}

test identity_cannot_leave_script() {
  let tx = fixture(empty(), registered())
  expect [output] = tx.outputs
  !run(
    Transaction {
      ..tx,
      outputs: [
        Output { ..output, address: address.from_verification_key(issuer_key) },
      ],
    },
  )
}

test ada_cannot_be_withdrawn() {
  let tx = fixture(empty(), registered())
  expect [output] = tx.outputs
  !run(
    Transaction {
      ..tx,
      outputs: [
        Output {
          ..output,
          value: assets.from_lovelace(2_000_000)
            |> assets.add(identity.policy_id, identity.asset_name, 1),
        },
      ],
    },
  )
}

test ada_topup_allowed() {
  let tx = fixture(empty(), registered())
  expect [output] = tx.outputs
  run(
    Transaction {
      ..tx,
      outputs: [
        Output {
          ..output,
          value: assets.from_lovelace(6_000_000)
            |> assets.add(identity.policy_id, identity.asset_name, 1),
        },
      ],
    },
  )
}

test invalid_asset_rejected() fail {
  asset_registry.spend(
    identity,
    issuer_key,
    Some(empty()),
    Register { asset: AssetClass { policy_id: #"", asset_name: #"" } },
    own_ref,
    fixture(empty(), registered()),
  )
}

test registry_capacity_enforced() {
  let entries =
    list.range(0, 49)
      |> list.map(
          fn(n) {
            AssetClass {
              ..asset_a,
              asset_name: bytearray.from_int_big_endian(n, 1),
            }
          },
        )
  let current = RegistryDatum { version: 50, entries }
  let next = RegistryDatum { version: 51, entries: [asset_a, ..entries] }
  !asset_registry.spend(
    identity,
    issuer_key,
    Some(current),
    Register { asset: asset_a },
    own_ref,
    fixture(current, next),
  )
}
