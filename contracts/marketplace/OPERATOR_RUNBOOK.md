# Operator Runbook: RWA / USDM Pool

> Scope: this is the legacy oracle-priced RWA/USDM pool runbook. It does not
> describe the registry-free shared quote pool surfaced by `/marketplace`,
> `/team`, and `/portfolio/reserves`. For that current flow, use
> [Shared-pool Marketplace operations](../../docs/SHARED_POOL_OPERATIONS.md).

This archived procedure describes the former single-pool MVP: one RWA policy/product
bucket, USDM settlement, one registry UTxO, one oracle UTxO, and one pool UTxO.
The pool is an oracle-priced inventory pool, not an AMM: sellers deposit RWA
and receive the bid in USDM; buyers pay the ask and receive pool inventory.

## 0. Operating model and limitations

### Separate the authorities

| Role | Authority | Action |
| --- | --- | --- |
| RWA issuer | RWA minting policy | Mints and distributes RWA. |
| Registry admin | `RegistryDatum.admin` | Approves, pauses, and removes policies/assets. |
| Oracle operator | `oracle` validator parameter | Publishes bid/NAV/ask and expiry. |
| Liquidity provider | USDM and LP tokens | Adds/removes USDM. |
| Treasury | receives protocol fees | No registry/oracle authority is required. |

The included deployment/operator scripts are explicitly restricted to Preprod.
They are test tooling, not a Mainnet deployment system.

Do not use `mint-test-tokens.mjs` for a real RWA issuance. It uses a simple
signature-only policy and can mint further tokens whenever its key is available.
A production RWA must use the issuer's approved/audited minting policy, supply
controls, metadata, custody, and compliance process.

### Current contract constraints

1. Registering a `PolicyConfig` admits **every asset name** under that policy
   ID. `asset_configs` only add stricter controls; they are not an allowlist.
   For this MVP, use an RWA policy that cannot mint unrelated assets, or add an
   exact-asset allowlist to the validator before registering a mixed policy.
2. `requires_kyc` and `redeem_enabled` are datum fields only. The marketplace
   validator does not enforce them.
3. Do not seed USDM directly into a pool with `total_lp_supply = 0`. The next
   LP provider would mint only for its own deposit but gain a claim on the
   pre-seeded reserve. Deploy an empty vault, then have the initial LP provider
   call `AddLiquidity` in the next transaction. The current LP policy requires
   a pool input, so it cannot mint initial LP in the deployment transaction.
4. `marketplace-ops.mjs` supports pause/unpause, asset-price update, LP
   add/remove, and test trading. It does not add/remove policies, update policy
   default prices, or delete quotes; these need a controlled updater transaction.
5. The test buy/sell CLI derives the RWA policy from the test deployment and
   accepts a text name. It cannot yet submit an arbitrary external policy ID and
   asset-name hex for a real RWA.

## 1. Record the deployment configuration

Never identify an asset by ticker alone. Store the following in an
operator-controlled manifest, with tx hashes and script addresses:

```text
USDM = (usdm_policy_id, usdm_asset_name_hex)
RWA  = (rwa_policy_id,  rwa_asset_name_hex)

registry_token = (auth_policy_id, registry_name_hex)
oracle_token   = (auth_policy_id, oracle_name_hex)
vault_token    = (auth_policy_id, vault_name_hex)
lp_token       = (pool_share_policy_id, lp_name_hex)
```

Every amount is in integer smallest units. If USDM has six decimal places,
5 USDM is `5_000_000`, not `5`. For a one-token RWA valued at 5 USDM:

```text
bid = 5_000_000 / 1
nav = 5_000_000 / 1
ask = 5_500_000 / 1
```

Every quote must be positive and satisfy `bid <= nav <= ask`.

An example initial risk configuration is:

```text
initial_USDM_liquidity       = 1_000_000_000  # 1,000 USDM
min_cash_reserve             =   100_000_000  # 100 USDM
max_total_rwa_exposure       =   900_000_000  # 900 USDM NAV
max_policy_exposure_value    =   900_000_000
max_trade_value              =    50_000_000  # 50 USDM/trade
fee_bps                      = 0
protocol_fee_bps             = 0
```

The maximum immediate seller cash outflow is `pool USDM - min_cash_reserve`.
Choose initial USDM as the minimum reserve plus the desired seller capacity.

## 2. Pre-flight checklist

Perform this before every state-changing transaction:

1. Confirm network, wallet address, Blockfrost project, and required signer.
2. Build and check the exact source being operated:

   ```sh
   npm run check:contracts
   npm run check:offchain
   ```

3. Query and archive current state:

   ```sh
   npm run offchain:status
   ```

4. Check each auth UTxO has exactly one expected auth NFT, an inline datum, and
   the expected script address.
5. Check registry/pool are not paused, required flags are enabled, and the
   oracle quote has not expired.
6. Re-read state just before signing. Every trade/liquidity operation spends
   the pool UTxO; a transaction built against a stale input must be rebuilt.

## 3. Mint RWA tokens

### Preprod demonstration

The test token command mints with the wallet's test policy:

```sh
npm run offchain:mint-test-tokens -- FAKE_RWA_PACK_000001:1
```

Save the returned policy ID, asset-name hex, full unit, quantity, address, and
transaction hash. This command is only for Preprod.

### Production issuance

1. Mint using the approved RWA issuer policy.
2. Record policy ID, asset-name bytes, quantity, issue tx, custodian/recipient,
   and metadata reference.
3. Confirm the policy cannot mint unrelated assets. If it can, do not register
   that policy under the current policy-wide admission model.
4. Put a test quantity in the intended seller wallet and verify the builder can
   select it as an input.

## 4. Create/update the registry

At initial deployment, include this policy configuration in the registry datum:

```text
PolicyConfig
  policy_id:                    RWA.policy_id
  bucket_id:                    MVP_RWA_V1 (UTF-8 bytes)
  active:                       true
  sell_enabled:                 true
  buy_enabled:                  true
  redeem_enabled:               false # not enforced by current contract
  max_policy_exposure_value:    900_000_000
  max_trade_value:               50_000_000
  risk_tier:                    1
  requires_kyc:                 false # not enforced by current contract

RegistryDatum
  quote_assets: [USDM]
  asset_configs: []
  paused: false
```

Keep `buy_enabled` true if the pool must later sell inventory or use
`OperatorSettle`; that redeemer uses buy controls. Setting it false makes this
a one-way test pool and prevents the normal operator inventory-settlement path.

### Add/edit a policy after deployment

The existing CLI cannot do this. Build `RegistryRedeemer.Update { next }`:

1. Read/decode the current registry UTxO selected by its exact registry NFT.
2. Construct `next`: add/edit the `PolicyConfig`, and add exact asset overrides
   only where they are needed.
3. Increase `sequence` strictly; preserve `admin` and `registry_token` exactly.
4. Require non-negative caps/risk tier and enforce unique policy IDs/assets in
   the operator tool, even though the current validator does not enforce it.
5. Spend the registry UTxO; recreate it at the registry script address with the
   same value and registry NFT, and with `next` as an inline datum.
6. Sign with the registry admin key, submit, then archive the new out-ref/datum.

The registry validator requires the continuing value to be exactly unchanged.
Fund its initial lovelace buffer generously; a normal update cannot top it up if
the growing datum requires more lovelace.

To pause all pools using the registry:

```sh
npm run offchain:registry -- pause
```

Use `unpause` only after review.

## 5. Create the oracle and set initial price

The oracle must use USDM as its quote asset and contain a policy default price:

```text
OracleDatum
  oracle_token: configured oracle NFT
  quote: USDM
  sequence: 1
  valid_until: future POSIX milliseconds
  policy_quotes: [RWA.policy_id -> bid/NAV/ask]
  asset_quotes: []
```

The oracle UTxO contains exactly one oracle NFT and the inline datum at the
parameterized oracle address. Expiry halts both buys and sells.

### Test asset-price update command

This creates/replaces an asset-level override, not the policy default:

```sh
npm run offchain:oracle -- quote FAKE_RWA_PACK_000001 \
  5000000/1 5000000/1 5500000/1 24
```

Arguments are `RWA_NAME BID NAV ASK VALID_FOR_HOURS`; the oracle operator signs.

### Production price update transaction

1. Record approved bid/NAV/ask values, data source, approver, and expiry.
2. Read the oracle UTxO by exact oracle NFT and confirm `quote == USDM`.
3. Replace the intended policy or asset quote; never append a duplicate.
4. Set a future `valid_until`, increase `sequence`, and preserve oracle NFT and
   quote asset exactly.
5. Check every remaining quote is active, positive, and `bid <= nav <= ask`.
6. Spend with `OracleRedeemer.Update`, recreate the same-value oracle UTxO with
   `next` inline datum, sign as oracle operator, and make tx expiry earlier than
   `next.valid_until`.
7. Query, verify, and archive the new oracle state.

## 6. Bootstrap / add USDM liquidity

### Correct bootstrap

1. Deploy registry, oracle, and an **empty** vault: `total_lp_supply = 0`, no
   RWA inventory, and only required lovelace plus vault NFT.
2. In the next transaction, the initial LP provider calls `AddLiquidity` with
   all initial USDM. This mints its initial LP position fairly.
3. Verify pool USDM, LP holder balance, and `total_lp_supply`.

Test command:

```sh
npm run offchain:lp:add -- 1000000000
```

Use smallest USDM units. The contract does not require post-deposit cash to
meet `min_cash_reserve`; the operator must ensure the initial deposit is at
least the planned minimum reserve plus usable seller liquidity.

## 7. Sell RWA into the pool

Preconditions:

- Seller owns the exact RWA and has ADA for fees/collateral.
- Registry policy is active and sell-enabled; USDM is in `quote_assets`.
- Oracle has a fresh active policy or asset quote.
- Trade fits quote, policy, asset, and total exposure caps.
- Resulting pool USDM remains at least `min_cash_reserve`.

For quantity `q`:

```text
gross          = q * bid
lp_fee         = gross * fee_bps / 10,000
protocol_fee   = gross * protocol_fee_bps / 10,000
seller_payout  = gross - lp_fee - protocol_fee
```

Test command (test policy/name convention only):

```sh
npm run offchain:sell-rwa -- FAKE_RWA_PACK_000001 1 \
  --min-payout 5000000
```

Set `min-payout` no higher than the calculated payout. On success the pool
receives RWA, the seller receives USDM, and vault policy/asset/total exposures
increase by `q * NAV`.

Archive tx hash and verify seller RWA/USDM, pool RWA/USDM, post-trade cash
reserve, and all three exposure values.

## 8. Buy RWA from the pool

Preconditions: pool has the RWA quantity; buy controls are enabled; oracle is
fresh; buyer has sufficient USDM and ADA.

```text
gross          = q * ask
lp_fee         = gross * fee_bps / 10,000
protocol_fee   = gross * protocol_fee_bps / 10,000
buyer_payment  = gross + lp_fee + protocol_fee
```

Test command:

```sh
npm run offchain:buy-rwa -- FAKE_RWA_PACK_000001 1 \
  --max-payment 5500000
```

Set `max-payment` at or above the calculated payment. Buyer receives RWA; pool
receives gross plus LP fee; treasury receives protocol fee; exposure decreases
by `q * NAV`. Verify each of those movements after confirmation.

## 9. Remove liquidity

Only the LP-token holder can remove liquidity:

```text
withdrawable = pool USDM - min_cash_reserve
USDM paid    = LP burned * withdrawable / total_lp_supply
```

Test command:

```sh
npm run offchain:lp:remove -- 100000000
```

It burns LP and preserves the minimum reserve. It fails when available USDM is
zero/negative or the withdrawal rounds to zero. Before an operator-directed
withdrawal, ensure remaining USDM still supports desired seller capacity.

## 10. Remove an RWA from registry service

Do not remove the policy while the pool holds its RWA: `BuyRwa` would fail and
inventory can be stranded. Use this order:

1. Registry-update the policy to disable new sells. Keep `buy_enabled = true`.
2. Keep a fresh quote long enough to unwind inventory.
3. Drain pool inventory by normal buys, or use `OperatorSettle` with the admin
   signature while depositing required NAV USDM into the pool.
4. Verify pool RWA quantity, policy exposure, and asset exposure are all zero.
5. Registry-update to remove the policy and related `asset_configs`; increment
   sequence and preserve registry NFT/value.
6. Oracle-update to remove related policy and asset quote entries; increment
   sequence and preserve oracle NFT/value.
7. Simulate buy/sell and verify both fail for the removed asset.

Frozen/defaulted/redeemed asset overrides also block `OperatorSettle` under the
current buy controls. Plan the unwind before applying those flags.

## 11. Remove prices, oracle, or registry

Oracle updates require every remaining quote to be active and sane. Remove a
quote by deleting its `PolicyQuote`/`AssetQuote` list entry; do not set it
inactive. A missing quote blocks buys and sells.

`OracleRedeemer.Close` removes the entire oracle UTxO. Use it only after every
pool using that oracle token is closed or migrated.

Removing one registry policy is a normal registry `Update`. `RegistryRedeemer.Close`
removes the entire registry UTxO and disables every referencing pool; use only
after all those pools are closed or migrated.

For every registry/oracle action, archive before/after datums, transaction hash,
signer, price source, approval, and reason.

## 12. Work required before Mainnet

1. Build a deployment tool that accepts explicit USDM and RWA `AssetClass`
   values, rather than test assets.
2. Correct the initial-liquidity bootstrap as described above, or redesign LP
   minting for an auditable deployment-time initial mint.
3. Add exact-asset allowlisting for policies with unrelated assets.
4. Add reviewed CLI/API commands for registry policy add/edit/remove, policy
   quote update/remove, and arbitrary-policy RWA buy/sell.
5. Enforce registry-list uniqueness and pin/validate registry references.
6. Complete independent security review plus emulator and testnet lifecycle
