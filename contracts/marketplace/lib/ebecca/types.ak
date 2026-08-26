use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, Value}

pub type AssetClass {
  policy_id: PolicyId,
  asset_name: AssetName,
}

pub type SupportedAsset {
  PolicyOnly(PolicyId)
  SpecificAsset(AssetClass)
}

pub type PriceSubject {
  PolicySubject(PolicyId)
  AssetSubject(AssetClass)
}

pub type Ratio {
  numerator: Int,
  denominator: Int,
}

pub type Quote {
  bid: Ratio,
  ask: Ratio,
  nav: Ratio,
  active: Bool,
  max_trade_value: Int,
}

pub type PolicyQuote {
  policy_id: PolicyId,
  quote: Quote,
}

pub type AssetQuote {
  asset: AssetClass,
  quote: Quote,
}

pub type PolicyConfig {
  policy_id: PolicyId,
  bucket_id: ByteArray,
  active: Bool,
  sell_enabled: Bool,
  buy_enabled: Bool,
  redeem_enabled: Bool,
  max_policy_exposure_value: Int,
  max_trade_value: Int,
  risk_tier: Int,
  requires_kyc: Bool,
}

pub type AssetConfig {
  asset: AssetClass,
  active: Bool,
  frozen: Bool,
  defaulted: Bool,
  redeemed: Bool,
  sell_enabled: Bool,
  buy_enabled: Bool,
  redeem_enabled: Bool,
  max_asset_exposure_value: Int,
  max_trade_value: Int,
  requires_kyc: Bool,
  reason_code: ByteArray,
}

pub type PolicyExposure {
  policy_id: PolicyId,
  value: Int,
}

pub type AssetExposure {
  asset: AssetClass,
  value: Int,
}

pub type RegistryDatum {
  admin: ByteArray,
  registry_token: AssetClass,
  sequence: Int,
  policies: List<PolicyConfig>,
  asset_configs: List<AssetConfig>,
  quote_assets: List<AssetClass>,
  paused: Bool,
}

// V2 registry state is deliberately split into small, independently-authenticated
// UTxOs. These types do not replace RegistryDatum: the legacy registry and
// marketplace remain deployable for a controlled migration.
pub type RegistryRootDatum {
  admin: VerificationKeyHash,
  root_token: AssetClass,
  version: Int,
  paused: Bool,
  quote_assets: List<AssetClass>,
  policy_shard_policy: PolicyId,
  asset_shard_policy: PolicyId,
}

pub type PolicyShardDatum {
  root_token: AssetClass,
  shard_token: AssetClass,
  policy_id: PolicyId,
  config: PolicyConfig,
  version: Int,
}

pub type AssetShardDatum {
  root_token: AssetClass,
  shard_token: AssetClass,
  asset: AssetClass,
  config: AssetConfig,
  version: Int,
}

pub type OracleDatum {
  oracle_token: AssetClass,
  quote: AssetClass,
  sequence: Int,
  valid_until: Int,
  policy_quotes: List<PolicyQuote>,
  asset_quotes: List<AssetQuote>,
}

pub type ListingDatum {
  seller: Address,
  seller_key: VerificationKeyHash,
  registry_token: AssetClass,
  rwa: AssetClass,
  quantity: Int,
  price_asset: AssetClass,
  price: Int,
}

pub type VaultDatum {
  admin: ByteArray,
  vault_token: AssetClass,
  registry_token: AssetClass,
  oracle_token: AssetClass,
  lp_token: AssetClass,
  settlement_asset: AssetClass,
  total_lp_supply: Int,
  total_rwa_exposure: Int,
  policy_exposures: List<PolicyExposure>,
  asset_exposures: List<AssetExposure>,
  fee_bps: Int,
  protocol_fee_bps: Int,
  min_cash_reserve: Int,
  max_total_rwa_exposure: Int,
  treasury: Address,
  paused: Bool,
}

// A separate datum type makes the V2 marketplace incapable of accepting a V1
// RegistryDatum by accident. Apart from the registry identity, pool accounting
// is intentionally identical to the V1 vault.
pub type ShardedVaultDatum {
  admin: ByteArray,
  vault_token: AssetClass,
  root_token: AssetClass,
  oracle_token: AssetClass,
  lp_token: AssetClass,
  settlement_asset: AssetClass,
  total_lp_supply: Int,
  total_rwa_exposure: Int,
  policy_exposures: List<PolicyExposure>,
  asset_exposures: List<AssetExposure>,
  fee_bps: Int,
  protocol_fee_bps: Int,
  min_cash_reserve: Int,
  max_total_rwa_exposure: Int,
  treasury: Address,
  paused: Bool,
}

pub fn ada() -> AssetClass {
  AssetClass {
    policy_id: assets.ada_policy_id,
    asset_name: assets.ada_asset_name,
  }
}

pub fn quantity_of(value: Value, asset: AssetClass) -> Int {
  assets.quantity_of(value, asset.policy_id, asset.asset_name)
}

pub fn add(value: Value, asset: AssetClass, amount: Int) -> Value {
  assets.add(value, asset.policy_id, asset.asset_name, amount)
}

pub fn has_at_least(value: Value, asset: AssetClass, amount: Int) -> Bool {
  quantity_of(value, asset) >= amount
}

pub fn has_one(value: Value, asset: AssetClass) -> Bool {
  quantity_of(value, asset) == 1
}

pub fn is_supported(asset: AssetClass, allowed: List<SupportedAsset>) -> Bool {
  list.any(
    allowed,
    fn(rule) {
      when rule is {
        PolicyOnly(policy_id) -> asset.policy_id == policy_id
        SpecificAsset(allowed_asset) -> asset == allowed_asset
      }
    },
  )
}

pub fn subject_matches_asset(subject: PriceSubject, asset: AssetClass) -> Bool {
  when subject is {
    PolicySubject(policy_id) -> asset.policy_id == policy_id
    AssetSubject(expected_asset) -> asset == expected_asset
  }
}

pub fn ratio_value(ratio: Ratio, quantity: Int) -> Int {
  ratio.numerator * quantity / ratio.denominator
}

pub fn quote_is_sane(quote: Quote) -> Bool {
  and {
    quote.active,
    quote.bid.denominator > 0,
    quote.ask.denominator > 0,
    quote.nav.denominator > 0,
    quote.bid.numerator > 0,
    quote.ask.numerator > 0,
    quote.nav.numerator > 0,
    quote.bid.numerator * quote.ask.denominator <= quote.ask.numerator * quote.bid.denominator,
    quote.bid.numerator * quote.nav.denominator <= quote.nav.numerator * quote.bid.denominator,
    quote.nav.numerator * quote.ask.denominator <= quote.ask.numerator * quote.nav.denominator,
  }
}

pub fn quote_trade_cap(quote: Quote, fallback: Int) -> Int {
  if quote.max_trade_value <= 0 {
    fallback
  } else if fallback <= 0 {
    quote.max_trade_value
  } else if quote.max_trade_value < fallback {
    quote.max_trade_value
  } else {
    fallback
  }
}

pub fn policy_config_for(
  policy_id: PolicyId,
  policies: List<PolicyConfig>,
) -> Option<PolicyConfig> {
  list.find(policies, fn(config) { config.policy_id == policy_id })
}

pub fn asset_config_for(
  asset: AssetClass,
  configs: List<AssetConfig>,
) -> Option<AssetConfig> {
  list.find(configs, fn(config) { config.asset == asset })
}

pub fn policy_quote_for(
  policy_id: PolicyId,
  quotes: List<PolicyQuote>,
) -> Option<Quote> {
  list.find_map(
    quotes,
    fn(entry) {
      if entry.policy_id == policy_id {
        Some(entry.quote)
      } else {
        None
      }
    },
  )
}

pub fn asset_quote_for(
  asset: AssetClass,
  quotes: List<AssetQuote>,
) -> Option<Quote> {
  list.find_map(
    quotes,
    fn(entry) {
      if entry.asset == asset {
        Some(entry.quote)
      } else {
        None
      }
    },
  )
}

pub fn resolve_quote(datum: OracleDatum, asset: AssetClass) -> Option<Quote> {
  when asset_quote_for(asset, datum.asset_quotes) is {
    Some(quote) ->
      if quote.active {
        Some(quote)
      } else {
        None
      }
    None -> policy_quote_for(asset.policy_id, datum.policy_quotes)
  }
}

pub fn stricter_positive_cap(left: Int, right: Int) -> Int {
  if left <= 0 {
    right
  } else if right <= 0 {
    left
  } else if left < right {
    left
  } else {
    right
  }
}

pub fn policy_exposure_of(
  exposures: List<PolicyExposure>,
  policy_id: PolicyId,
) -> Int {
  when
    list.find_map(
      exposures,
      fn(exposure) {
        if exposure.policy_id == policy_id {
          Some(exposure.value)
        } else {
          None
        }
      },
    )
  is {
    Some(value) -> value
    None -> 0
  }
}

pub fn asset_exposure_of(
  exposures: List<AssetExposure>,
  asset: AssetClass,
) -> Int {
  when
    list.find_map(
      exposures,
      fn(exposure) {
        if exposure.asset == asset {
          Some(exposure.value)
        } else {
          None
        }
      },
    )
  is {
    Some(value) -> value
    None -> 0
  }
}

const policy_a: PolicyId =
  #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const policy_b: PolicyId =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const asset_a: AssetClass =
  AssetClass { policy_id: policy_a, asset_name: "RWA-1" }

const asset_b: AssetClass =
  AssetClass { policy_id: policy_b, asset_name: "RWA-2" }

const ratio_one: Ratio = Ratio { numerator: 1, denominator: 1 }

const sane_quote: Quote =
  Quote {
    bid: ratio_one,
    ask: ratio_one,
    nav: ratio_one,
    active: True,
    max_trade_value: 0,
  }

test policy_level_support_allows_any_asset_under_policy() {
  is_supported(asset_a, [PolicyOnly(policy_a)])
}

test asset_level_support_rejects_other_assets() {
  is_supported(asset_b, [SpecificAsset(asset_a)]) == False
}

test policy_subject_matches_asset_policy() {
  subject_matches_asset(PolicySubject(policy_a), asset_a)
}

test asset_subject_rejects_other_asset() {
  subject_matches_asset(AssetSubject(asset_a), asset_b) == False
}

test asset_quote_override_takes_priority() {
  let oracle =
    OracleDatum {
      oracle_token: asset_a,
      quote: ada(),
      sequence: 1,
      valid_until: 10,
      policy_quotes: [PolicyQuote { policy_id: policy_a, quote: sane_quote }],
      asset_quotes: [
        AssetQuote {
          asset: asset_a,
          quote: Quote {
            ..sane_quote,
            bid: Ratio { numerator: 2, denominator: 1 },
          },
        },
      ],
    }

  expect Some(quote) = resolve_quote(oracle, asset_a)
  quote.bid.numerator == 2
}

test policy_quote_used_when_no_asset_override() {
  let oracle =
    OracleDatum {
      oracle_token: asset_a,
      quote: ada(),
      sequence: 1,
      valid_until: 10,
      policy_quotes: [PolicyQuote { policy_id: policy_a, quote: sane_quote }],
      asset_quotes: [],
    }

  expect Some(quote) = resolve_quote(oracle, asset_a)
  quote == sane_quote
}
