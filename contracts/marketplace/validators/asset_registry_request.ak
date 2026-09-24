use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use ebecca/types.{
  AssetClass, AssetRegistryRequestDatum, ada, has_one, quantity_of,
}

// Structural mirror of asset_registry.RegistryDatum. Both use the same
// constructor encoding so an approval can validate the registry transition
// without trusting an off-chain description of the requested assets.
type BasicRegistryDatum {
  version: Int,
  entries: List<AssetClass>,
}

pub type AssetRegistryRequestAction {
  Approve
  Reject
  Cancel
}

const min_request_deposit: Int = 2_000_000

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

fn paid_at_least(
  outputs: List<Output>,
  recipient: Address,
  asset: AssetClass,
  amount: Int,
) -> Bool {
  list.any(
    outputs,
    fn(output) {
      output.address == recipient && (output.value |> quantity_of(asset)) >= amount
    },
  )
}

fn valid_request(request: AssetRegistryRequestDatum, value: assets.Value) -> Bool {
  let request_assets = request.assets
  and {
    list.length(request_assets) > 0,
    list.length(request_assets) <= 50,
    list.all(request_assets, valid_asset),
    list.length(list.unique(request_assets)) == list.length(request_assets),
    assets.lovelace_of(value) >= min_request_deposit,
    assets.without_lovelace(value) == assets.zero,
  }
}

fn registry_transition_is_approved(
  tx: Transaction,
  registry_address: Address,
  registry_token: AssetClass,
  requested: List<AssetClass>,
) -> Bool {
  expect [registry_input] =
    list.filter(
      tx.inputs,
      fn(input) {
        input.output.address == registry_address && (input.output.value |> has_one(registry_token))
      },
    )
  expect InlineDatum(current_raw) = registry_input.output.datum
  expect current: BasicRegistryDatum = current_raw
  expect [registry_output] =
    list.filter(
      tx.outputs,
      fn(output) {
        output.address == registry_address && (output.value |> has_one(registry_token))
      },
    )
  expect InlineDatum(next_raw) = registry_output.datum
  expect next: BasicRegistryDatum = next_raw
  and {
    current.version >= 0,
    valid_entries(current.entries),
    next.version == current.version + 1,
    list.all(requested, fn(asset) { !list.has(current.entries, asset) }),
    next.entries == prepend_all(requested, current.entries),
    valid_entries(next.entries),
  }
}

/// Holds permissionless proposals until the issuer approves, rejects, or the
/// requester cancels them. Approval must include the exact registry update.
validator asset_registry_request(
  registry_address: Address,
  registry_token: AssetClass,
  issuer: VerificationKeyHash,
) {
  spend(
    datum: Option<AssetRegistryRequestDatum>,
    action: AssetRegistryRequestAction,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(request) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)
    let locked_lovelace = own_input.output.value |> quantity_of(ada())

    and {
      valid_request(request, own_input.output.value),
      when action is {
        Approve -> and {
          list.has(tx.extra_signatories, issuer),
          registry_transition_is_approved(
            tx,
            registry_address,
            registry_token,
            request.assets,
          ),
          paid_at_least(tx.outputs, request.requester, ada(), locked_lovelace),
        }
        Reject -> and {
          list.has(tx.extra_signatories, issuer),
          paid_at_least(tx.outputs, request.requester, ada(), locked_lovelace),
        }
        Cancel -> and {
          list.has(tx.extra_signatories, request.requester_key),
          paid_at_least(tx.outputs, request.requester, ada(), locked_lovelace),
        }
      },
    }
  }

  else(_) {
    fail
  }
}

const issuer_key: VerificationKeyHash =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const requester_key: VerificationKeyHash =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const registry_token: AssetClass =
  AssetClass {
    policy_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    asset_name: "REGISTRY",
  }

const requested_asset: AssetClass =
  AssetClass {
    policy_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    asset_name: "RWA",
  }

const request_ref: OutputReference =
  OutputReference {
    transaction_id: #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    output_index: 0,
  }

const registry_ref: OutputReference =
  OutputReference {
    transaction_id: #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    output_index: 1,
  }

fn registry_address() -> Address {
  address.from_script(
    #"11111111111111111111111111111111111111111111111111111111",
  )
}

fn request_address() -> Address {
  address.from_script(
    #"22222222222222222222222222222222222222222222222222222222",
  )
}

fn request() -> AssetRegistryRequestDatum {
  AssetRegistryRequestDatum {
    requester: address.from_verification_key(requester_key),
    requester_key,
    assets: [requested_asset],
  }
}

fn request_output() -> Output {
  Output {
    address: request_address(),
    value: assets.from_lovelace(3_000_000),
    datum: InlineDatum(request()),
    reference_script: None,
  }
}

fn registry_output(datum: BasicRegistryDatum) -> Output {
  Output {
    address: registry_address(),
    value: assets.from_lovelace(5_000_000)
      |> assets.add(registry_token.policy_id, registry_token.asset_name, 1),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn refund() -> Output {
  Output {
    address: address.from_verification_key(requester_key),
    value: assets.from_lovelace(3_000_000),
    datum: InlineDatum(request()),
    reference_script: None,
  }
}

fn reject_transaction(signers: List<VerificationKeyHash>) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input { output_reference: request_ref, output: request_output() },
    ],
    outputs: [refund()],
    extra_signatories: signers,
  }
}

fn approval_transaction(next: BasicRegistryDatum) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input { output_reference: request_ref, output: request_output() },
      Input {
        output_reference: registry_ref,
        output: registry_output(BasicRegistryDatum { version: 0, entries: [] }),
      },
    ],
    outputs: [registry_output(next), refund()],
    extra_signatories: [issuer_key],
  }
}

test issuer_can_reject_and_refund() {
  asset_registry_request.spend(
    registry_address(),
    registry_token,
    issuer_key,
    Some(request()),
    Reject,
    request_ref,
    reject_transaction([issuer_key]),
  )
}

test requester_can_cancel_and_refund() {
  asset_registry_request.spend(
    registry_address(),
    registry_token,
    issuer_key,
    Some(request()),
    Cancel,
    request_ref,
    reject_transaction([requester_key]),
  )
}

test unsigned_rejection_fails() {
  !asset_registry_request.spend(
    registry_address(),
    registry_token,
    issuer_key,
    Some(request()),
    Reject,
    request_ref,
    reject_transaction([]),
  )
}

test approval_atomically_adds_entire_request() {
  asset_registry_request.spend(
    registry_address(),
    registry_token,
    issuer_key,
    Some(request()),
    Approve,
    request_ref,
    approval_transaction(
      BasicRegistryDatum { version: 1, entries: [requested_asset] },
    ),
  )
}

test approval_with_partial_transition_fails() {
  !asset_registry_request.spend(
    registry_address(),
    registry_token,
    issuer_key,
    Some(request()),
    Approve,
    request_ref,
    approval_transaction(BasicRegistryDatum { version: 1, entries: [] }),
  )
}
