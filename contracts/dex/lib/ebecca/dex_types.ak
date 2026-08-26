use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets

/// Shared types for the shared-address AMM, factory, and LP policy.
/// ADA is represented by empty policy ID and asset name.
pub type AssetId {
  AssetId { policy_id: assets.PolicyId, asset_name: assets.AssetName }
}

/// Every live pool sits at the same AMM script address. `pool_lovelace` is
/// the total lovelace locked in the UTxO; it is either the ADA reserve or the
/// min-UTxO value for a token/token pair.
pub type PoolDatum {
  PoolDatum {
    pool_nft: AssetId,
    asset_a: AssetId,
    asset_b: AssetId,
    lp_token: AssetId,
    fee_numerator: Int,
    fee_denominator: Int,
    reserve_a: Int,
    reserve_b: Int,
    total_liquidity: Int,
    pool_lovelace: Int,
  }
}

/// The factory state is held at the `factory_state` validator. It is consumed
/// only to create a pool and is otherwise supplied as a reference input by
/// AMM transactions.
pub type FactoryDatum {
  FactoryDatum {
    factory_token: AssetId,
    admin: VerificationKeyHash,
    pool_nft_policy: assets.PolicyId,
    next_pool_id: Int,
    paused: Bool,
  }
}

pub type PoolAction {
  Swap { minimum_amount_out: Int }
  AddLiquidity { minimum_lp_out: Int }
  RemoveLiquidity { minimum_a_out: Int, minimum_b_out: Int }
  Close { recipient: Address }
}

pub type FactoryStateAction {
  Advance
  SetPaused { paused: Bool }
}

pub type FactoryAction {
  CreatePool
  BurnPool
}

pub type FactoryBootstrapAction {
  MintFactory
}

pub type LpAction {
  Bootstrap { pool_nft: AssetId }
  MintLp { pool_nft: AssetId }
  BurnLp { pool_nft: AssetId }
  CloseLp { pool_nft: AssetId }
}
