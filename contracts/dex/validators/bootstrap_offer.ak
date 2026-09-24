use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
}
use ebecca/amm_helpers.{ada, has_one, total_paid}
use ebecca/dex_types.{
  AcceptBootstrap, AssetId, BootstrapOfferAction, BootstrapOfferDatum,
  CancelBootstrap, FactoryDatum, PoolDatum,
}

/// Escrows the FT side of a Team-approved, three-party pool bootstrap.
///
/// The FT owner first locks the asset and terms. A distinct liquidity provider
/// then funds and signs the quote side. The factory Team creator must also
/// sign before the same transaction can create the pool. The factory,
/// pool-NFT policy and LP policy authenticate pool creation; this validator
/// additionally binds the escrowed FT, quoted reserve, and LP allocation.
validator bootstrap_offer {
  spend(
    datum_opt: Option<BootstrapOfferDatum>,
    action: BootstrapOfferAction,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(offer) = datum_opt
    expect Some(own_input) =
      list.find(
        tx.inputs,
        fn(input: Input) { input.output_reference == own_ref },
      )

    when action is {
      CancelBootstrap -> valid_cancel(offer, own_ref, own_input, tx)
      AcceptBootstrap { liquidity_provider, liquidity_provider_key } ->
        valid_accept(
          offer,
          own_input.output.value,
          liquidity_provider,
          liquidity_provider_key,
          tx,
        )
    }
  }

  else(_) {
    False
  }
}

/// Cancellation is deliberately independent of acceptance validity (R04).
///
/// It does not inspect trading terms or require the escrow to hold exactly the
/// datum-derived value, so an owner can recover an escrow with extra ADA,
/// extra assets, a datum/value mismatch, or invalid share/quote terms. It does
/// require:
/// - a trustworthy owner binding: `owner` must be a verification-key address
///   whose payment key is `owner_key`, and `owner_key` must sign;
/// - a full refund: the owner's exact address (payment and stake parts) must
///   receive at least every asset of every offer input in this transaction at
///   this script address whose datum names the same owner. Aggregating those
///   inputs prevents one refund output from satisfying several cancellations
///   (double satisfaction).
fn valid_cancel(
  offer: BootstrapOfferDatum,
  own_ref: OutputReference,
  own_input: Input,
  tx: Transaction,
) -> Bool {
  let owner_escrow =
    owner_escrow_value(tx.inputs, own_ref, own_input.output, offer.owner)
  let refunded = value_paid_to(tx.outputs, offer.owner)
  and {
    owner_matches_key(offer.owner, offer.owner_key),
    list.has(tx.extra_signatories, offer.owner_key),
    covers(refunded, owner_escrow),
  }
}

/// Sum of the own input and every other input at the same script address
/// whose inline datum decodes as a bootstrap offer for `owner`.
fn owner_escrow_value(
  inputs: List<Input>,
  own_ref: OutputReference,
  own_output: Output,
  owner: address.Address,
) -> assets.Value {
  list.foldl(
    inputs,
    own_output.value,
    fn(input: Input, total) {
      if input.output_reference == own_ref || input.output.address != own_output.address {
        total
      } else {
        when input.output.datum is {
          InlineDatum(raw) ->
            if raw is other: BootstrapOfferDatum {
              if other.owner == owner {
                assets.merge(total, input.output.value)
              } else {
                total
              }
            } else {
              total
            }
          _ -> total
        }
      }
    },
  )
}

fn value_paid_to(
  outputs: List<Output>,
  recipient: address.Address,
) -> assets.Value {
  list.foldl(
    outputs,
    assets.zero,
    fn(output: Output, total) {
      if output.address == recipient {
        assets.merge(total, output.value)
      } else {
        total
      }
    },
  )
}

/// True when `paid` holds at least the quantity of every asset in `required`.
fn covers(paid: assets.Value, required: assets.Value) -> Bool {
  list.all(
    assets.flatten(required),
    fn(entry) {
      let (policy_id, asset_name, quantity) = entry
      assets.quantity_of(paid, policy_id, asset_name) >= quantity
    },
  )
}

fn expected_offer_value(offer: BootstrapOfferDatum) -> assets.Value {
  assets.from_lovelace(offer.pool_lovelace)
    |> assets.add(
        offer.fraction_asset.policy_id,
        offer.fraction_asset.asset_name,
        offer.fraction_amount,
      )
}

fn valid_offer(offer: BootstrapOfferDatum, value: assets.Value) -> Bool {
  and {
    offer.owner_key != "",
    owner_matches_key(offer.owner, offer.owner_key),
    offer.factory_token != ada,
    offer.fraction_asset != ada,
    offer.quote_asset != offer.fraction_asset,
    offer.fraction_amount > 0,
    offer.quote_amount > 0,
    has_minimum_pool_buffer(offer.pool_lovelace),
    offer.owner_share_bps > 0,
    offer.owner_share_bps < 10_000,
    if offer.quote_asset == ada {
      offer.pool_lovelace <= offer.quote_amount
    } else {
      True
    },
    value == expected_offer_value(offer),
  }
}

fn valid_accept(
  offer: BootstrapOfferDatum,
  offer_value: assets.Value,
  liquidity_provider: address.Address,
  liquidity_provider_key: VerificationKeyHash,
  tx: Transaction,
) -> Bool {
  expect [factory_input] =
    list.filter(
      tx.inputs,
      fn(input: Input) { has_one(input.output.value, offer.factory_token) },
    )
  expect InlineDatum(raw_factory) = factory_input.output.datum
  expect factory: FactoryDatum = raw_factory
  let pool_nft =
    AssetId {
      policy_id: factory.pool_nft_policy,
      asset_name: bytearray.from_int_big_endian(factory.next_pool_id, 8),
    }
  expect [pool_output] =
    list.filter(tx.outputs, fn(output) { has_one(output.value, pool_nft) })
  expect InlineDatum(raw_pool) = pool_output.datum
  expect pool: PoolDatum = raw_pool
  let owner_lp = pool.total_liquidity * offer.owner_share_bps / 10_000
  let provider_lp = pool.total_liquidity - owner_lp

  and {
    valid_offer(offer, offer_value),
    liquidity_provider != offer.owner,
    owner_matches_key(liquidity_provider, liquidity_provider_key),
    liquidity_provider_key != offer.owner_key,
    factory.factory_token == offer.factory_token,
    factory.admin != offer.owner_key,
    factory.admin != liquidity_provider_key,
    list.has(tx.extra_signatories, liquidity_provider_key),
    list.has(tx.extra_signatories, factory.admin),
    pool.pool_nft == pool_nft,
    pool.asset_a == offer.quote_asset,
    pool.asset_b == offer.fraction_asset,
    pool.reserve_a == offer.quote_amount,
    pool.reserve_b == offer.fraction_amount,
    if offer.quote_asset == ada {
      pool.pool_lovelace == offer.quote_amount
    } else {
      pool.pool_lovelace == offer.pool_lovelace
    },
    owner_lp > 0,
    provider_lp > 0,
    total_paid(tx.outputs, offer.owner, pool.lp_token) >= owner_lp,
    total_paid(tx.outputs, liquidity_provider, pool.lp_token) >= provider_lp,
  }
}

fn owner_matches_key(owner: address.Address, key: VerificationKeyHash) -> Bool {
  when owner.payment_credential is {
    address.VerificationKey(owner_key) -> owner_key == key
    _ -> False
  }
}

fn has_minimum_pool_buffer(pool_lovelace: Int) -> Bool {
  pool_lovelace >= 2_000_000
}

test bootstrap_offer_requires_two_ada_buffer() {
  and {
    has_minimum_pool_buffer(2_000_000),
    has_minimum_pool_buffer(1_999_999) == False,
  }
}

// ---------------------------------------------------------------------------
// Transaction-level fixtures for cancellation (R04) and acceptance.
// ---------------------------------------------------------------------------

const owner_vk: VerificationKeyHash =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const provider_vk: VerificationKeyHash =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const admin_vk: VerificationKeyHash =
  #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

const test_offer_script: ByteArray =
  #"0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"

const test_factory_script: ByteArray =
  #"1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e"

const test_pool_script: ByteArray =
  #"2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d"

const test_ft =
  AssetId {
    policy_id: #"abababababababababababababababababababababababababababab",
    asset_name: #"01",
  }

const test_extra_asset =
  AssetId {
    policy_id: #"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    asset_name: #"02",
  }

const test_factory_token =
  AssetId {
    policy_id: #"fafafafafafafafafafafafafafafafafafafafafafafafafafafafa",
    asset_name: "CSWAP_DEX_FACTORY",
  }

const test_pool_nft_policy: ByteArray =
  #"c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

const test_lp_policy: ByteArray =
  #"d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"

const test_offer_ref =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

fn test_owner() -> address.Address {
  address.from_verification_key(owner_vk)
}

fn test_provider() -> address.Address {
  address.from_verification_key(provider_vk)
}

fn test_offer() -> BootstrapOfferDatum {
  BootstrapOfferDatum {
    owner: test_owner(),
    owner_key: owner_vk,
    factory_token: test_factory_token,
    fraction_asset: test_ft,
    fraction_amount: 1000,
    quote_asset: ada,
    quote_amount: 10_000_000,
    pool_lovelace: 4_000_000,
    owner_share_bps: 5000,
  }
}

fn escrow_output(offer: BootstrapOfferDatum, value: assets.Value) -> Output {
  Output {
    address: address.from_script(test_offer_script),
    value,
    datum: InlineDatum(offer),
    reference_script: None,
  }
}

fn pay(to: address.Address, value: assets.Value) -> Output {
  Output { address: to, value, datum: NoDatum, reference_script: None }
}

fn with_ft(value: assets.Value, amount: Int) -> assets.Value {
  assets.add(value, test_ft.policy_id, test_ft.asset_name, amount)
}

fn with_extra(value: assets.Value) -> assets.Value {
  assets.add(value, test_extra_asset.policy_id, test_extra_asset.asset_name, 7)
}

/// The R04 reproduction value: 4 ADA + 1,000 FT.
fn r04_value() -> assets.Value {
  assets.from_lovelace(4_000_000) |> with_ft(1000)
}

fn cancel_tx(
  escrow: Output,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Transaction {
  Transaction {
    ..transaction.placeholder,
    inputs: [Input { output_reference: test_offer_ref, output: escrow }],
    outputs,
    extra_signatories: signers,
  }
}

fn run_cancel(
  offer: BootstrapOfferDatum,
  value: assets.Value,
  outputs: List<Output>,
  signers: List<VerificationKeyHash>,
) -> Bool {
  bootstrap_offer.spend(
    Some(offer),
    CancelBootstrap,
    test_offer_ref,
    cancel_tx(escrow_output(offer, value), outputs, signers),
  )
}

fn refund_all(value: assets.Value) -> List<Output> {
  [pay(test_owner(), value)]
}

test cancel_valid_offer_by_owner() {
  run_cancel(test_offer(), r04_value(), refund_all(r04_value()), [owner_vk])
}

test cancel_r04_datum_declares_less_ada_than_locked() {
  // Datum declares 3 ADA, escrow holds 4 ADA + 1,000 FT.
  let offer = BootstrapOfferDatum { ..test_offer(), pool_lovelace: 3_000_000 }
  run_cancel(offer, r04_value(), refund_all(r04_value()), [owner_vk])
}

test cancel_with_extra_ada() {
  let value = assets.from_lovelace(9_000_000) |> with_ft(1000)
  run_cancel(test_offer(), value, refund_all(value), [owner_vk])
}

test cancel_with_extra_asset() {
  let value = r04_value() |> with_extra
  run_cancel(test_offer(), value, refund_all(value), [owner_vk])
}

test cancel_with_invalid_share_terms() {
  let offer = BootstrapOfferDatum { ..test_offer(), owner_share_bps: 10_000 }
  run_cancel(offer, r04_value(), refund_all(r04_value()), [owner_vk])
}

test cancel_with_invalid_quote_terms() {
  let offer =
    BootstrapOfferDatum {
      ..test_offer(),
      quote_asset: test_ft,
      quote_amount: 0,
    }
  run_cancel(offer, r04_value(), refund_all(r04_value()), [owner_vk])
}

test cancel_refund_may_be_split_across_owner_outputs() {
  let value = r04_value() |> with_extra
  run_cancel(
    test_offer(),
    value,
    [
      pay(test_owner(), assets.from_lovelace(2_000_000) |> with_ft(1000)),
      pay(test_owner(), assets.from_lovelace(2_000_000) |> with_extra),
    ],
    [owner_vk],
  )
}

test cancel_rejects_non_owner_signer() {
  !run_cancel(
    test_offer(),
    r04_value(),
    refund_all(r04_value()),
    [provider_vk, admin_vk],
  )
}

test cancel_rejects_unsigned() {
  !run_cancel(test_offer(), r04_value(), refund_all(r04_value()), [])
}

test cancel_rejects_owner_key_not_bound_to_owner_address() {
  // An attacker-controlled key cannot be paired with someone else's address,
  // nor can a script-address owner be "authenticated" by an arbitrary key.
  let mismatched =
    BootstrapOfferDatum { ..test_offer(), owner_key: provider_vk }
  let script_owner =
    BootstrapOfferDatum {
      ..test_offer(),
      owner: address.from_script(test_offer_script),
    }
  and {
    !run_cancel(mismatched, r04_value(), refund_all(r04_value()), [provider_vk]),
    !run_cancel(
      script_owner,
      r04_value(),
      [pay(address.from_script(test_offer_script), r04_value())],
      [owner_vk],
    ),
  }
}

test cancel_rejects_partial_ada_refund() {
  let value = assets.from_lovelace(9_000_000) |> with_ft(1000)
  !run_cancel(
    test_offer(),
    value,
    [pay(test_owner(), assets.from_lovelace(4_000_000) |> with_ft(1000))],
    [owner_vk],
  )
}

test cancel_rejects_missing_extra_asset() {
  let value = r04_value() |> with_extra
  !run_cancel(test_offer(), value, refund_all(r04_value()), [owner_vk])
}

test cancel_rejects_diverted_refund() {
  !run_cancel(
    test_offer(),
    r04_value(),
    [pay(test_provider(), r04_value())],
    [owner_vk],
  )
}

test cancel_rejects_refund_to_owner_key_with_other_stake() {
  let restaked =
    address.from_verification_key(owner_vk)
      |> address.with_delegation_key(provider_vk)
  !run_cancel(
    test_offer(),
    r04_value(),
    [pay(restaked, r04_value())],
    [owner_vk],
  )
}

test cancel_rejects_double_satisfaction_across_owner_escrows() {
  let second_ref = OutputReference { ..test_offer_ref, output_index: 1 }
  let tx =
    Transaction {
      ..transaction.placeholder,
      inputs: [
        Input {
          output_reference: test_offer_ref,
          output: escrow_output(test_offer(), r04_value()),
        },
        Input {
          output_reference: second_ref,
          output: escrow_output(test_offer(), r04_value()),
        },
      ],
      outputs: [
        pay(test_owner(), r04_value()),
        pay(test_provider(), r04_value()),
      ],
      extra_signatories: [owner_vk],
    }
  let both_refunded =
    Transaction {
      ..tx,
      outputs: [pay(test_owner(), assets.merge(r04_value(), r04_value()))],
    }
  and {
    !bootstrap_offer.spend(
      Some(test_offer()),
      CancelBootstrap,
      test_offer_ref,
      tx,
    ),
    bootstrap_offer.spend(
      Some(test_offer()),
      CancelBootstrap,
      test_offer_ref,
      both_refunded,
    ),
  }
}

fn accept_tx(offer_value: assets.Value) -> Transaction {
  let pool_nft =
    AssetId {
      policy_id: test_pool_nft_policy,
      asset_name: bytearray.from_int_big_endian(0, 8),
    }
  let lp_token =
    AssetId { policy_id: test_lp_policy, asset_name: pool_nft.asset_name }
  let factory =
    FactoryDatum {
      factory_token: test_factory_token,
      admin: admin_vk,
      pool_nft_policy: test_pool_nft_policy,
      next_pool_id: 0,
      paused: False,
    }
  let pool =
    PoolDatum {
      pool_nft,
      asset_a: ada,
      asset_b: test_ft,
      lp_token,
      fee_numerator: 997,
      fee_denominator: 1000,
      reserve_a: 10_000_000,
      reserve_b: 1000,
      total_liquidity: 100_000,
      pool_lovelace: 10_000_000,
    }
  let factory_value =
    assets.from_lovelace(5_000_000)
      |> assets.add(
          test_factory_token.policy_id,
          test_factory_token.asset_name,
          1,
        )
  let lp =
    fn(n) { assets.from_asset(lp_token.policy_id, lp_token.asset_name, n) }
  Transaction {
    ..transaction.placeholder,
    inputs: [
      Input {
        output_reference: test_offer_ref,
        output: escrow_output(test_offer(), offer_value),
      },
      Input {
        output_reference: OutputReference { ..test_offer_ref, output_index: 1 },
        output: Output {
          address: address.from_script(test_factory_script),
          value: factory_value,
          datum: InlineDatum(factory),
          reference_script: None,
        },
      },
    ],
    outputs: [
      Output {
        address: address.from_script(test_factory_script),
        value: factory_value,
        datum: InlineDatum(FactoryDatum { ..factory, next_pool_id: 1 }),
        reference_script: None,
      },
      Output {
        address: address.from_script(test_pool_script),
        value: assets.from_lovelace(10_000_000)
          |> with_ft(1000)
          |> assets.add(pool_nft.policy_id, pool_nft.asset_name, 1),
        datum: InlineDatum(pool),
        reference_script: None,
      },
      pay(test_owner(), lp(50_000)),
      pay(test_provider(), lp(50_000)),
    ],
    extra_signatories: [provider_vk, admin_vk],
  }
}

fn run_accept(offer_value: assets.Value) -> Bool {
  bootstrap_offer.spend(
    Some(test_offer()),
    AcceptBootstrap {
      liquidity_provider: test_provider(),
      liquidity_provider_key: provider_vk,
    },
    test_offer_ref,
    accept_tx(offer_value),
  )
}

test accept_valid_offer_still_passes() {
  run_accept(r04_value())
}

test accept_still_rejects_extra_ada() {
  !run_accept(assets.from_lovelace(5_000_000) |> with_ft(1000))
}

test accept_still_rejects_extra_asset() {
  !run_accept(r04_value() |> with_extra)
}
