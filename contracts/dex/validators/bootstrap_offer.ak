use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address
use cardano/assets
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
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
      CancelBootstrap -> and {
          valid_offer(offer, own_input.output.value),
          list.has(tx.extra_signatories, offer.owner_key),
          total_paid(tx.outputs, offer.owner, offer.fraction_asset) >= offer.fraction_amount,
          total_paid(tx.outputs, offer.owner, ada) >= offer.pool_lovelace,
        }
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
