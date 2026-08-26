use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, find_input}
use ebecca/types.{
  AssetConfig, AssetClass, ListingDatum, PolicyConfig, RegistryDatum, ada,
  asset_config_for, has_one, policy_config_for, quantity_of,
}

pub type ListingRedeemer {
  Buy { buyer: Address }
  Cancel
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

fn registry_from_reference(
  reference_inputs: List<Input>,
  registry_token: AssetClass,
) -> Option<RegistryDatum> {
  list.find_map(
    reference_inputs,
    fn(input) {
      if input.output.value |> has_one(registry_token) {
        when input.output.datum is {
          InlineDatum(data) -> {
            expect registry: RegistryDatum = data
            Some(registry)
          }
          _ -> None
        }
      } else {
        None
      }
    },
  )
}

fn asset_config_allows_sell(config: Option<AssetConfig>) -> Bool {
  when config is {
    Some(asset_config) -> and {
      asset_config.active,
      !asset_config.frozen,
      !asset_config.defaulted,
      !asset_config.redeemed,
      asset_config.sell_enabled,
    }
    None -> True
  }
}

fn asset_config_allows_buy(config: Option<AssetConfig>) -> Bool {
  when config is {
    Some(asset_config) -> and {
      asset_config.active,
      !asset_config.frozen,
      !asset_config.defaulted,
      !asset_config.redeemed,
      asset_config.buy_enabled,
    }
    None -> True
  }
}

fn listing_is_valid(listing: ListingDatum) -> Bool {
  and {
    listing.quantity > 0,
    listing.price > 0,
    listing.price_asset != listing.rwa,
  }
}

fn registry_allows_fill(registry: RegistryDatum, listing: ListingDatum) -> Bool {
  expect Some(policy): Option<PolicyConfig> =
    policy_config_for(listing.rwa.policy_id, registry.policies)

  let asset_config = asset_config_for(listing.rwa, registry.asset_configs)

  and {
    !registry.paused,
    policy.active,
    policy.sell_enabled,
    policy.buy_enabled,
    asset_config_allows_sell(asset_config),
    asset_config_allows_buy(asset_config),
    list.has(registry.quote_assets, listing.price_asset),
  }
}

fn seller_is_paid(
  outputs: List<Output>,
  listing: ListingDatum,
  locked_lovelace: Int,
) -> Bool {
  if listing.price_asset == ada() {
    paid_at_least(
      outputs,
      listing.seller,
      ada(),
      listing.price + locked_lovelace,
    )
  } else {
    and {
      paid_at_least(outputs, listing.seller, listing.price_asset, listing.price),
      paid_at_least(outputs, listing.seller, ada(), locked_lovelace),
    }
  }
}

validator p2p_listing {
  spend(
    datum: Option<ListingDatum>,
    redeemer: ListingRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(listing) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    when redeemer is {
      Buy { buyer } -> {
        expect Some(registry) =
          registry_from_reference(tx.reference_inputs, listing.registry_token)

        let locked_lovelace = own_input.output.value |> quantity_of(ada())

        and {
          listing_is_valid(listing),
          registry_allows_fill(registry, listing),
          (own_input.output.value |> quantity_of(listing.rwa)) == listing.quantity,
          seller_is_paid(tx.outputs, listing, locked_lovelace),
          paid_at_least(tx.outputs, buyer, listing.rwa, listing.quantity),
        }
      }

      Cancel -> {
        let seller_key: VerificationKeyHash = listing.seller_key
        list.has(tx.extra_signatories, seller_key)
      }
    }
  }

  else(_) {
    fail
  }
}
