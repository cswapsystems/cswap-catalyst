# Wallet configuration

The Operations → Team wallet page (`/wallets`) now shows the **connected authorized Eternl account**—its public address, payment-key hash, ADA total and UTxO count. It does not need separate issuer, custody, treasury or settlement address variables. The current Preprod marketplace Team, batcher, registry issuer and DEX administrator roles use the same configured payment key, although the on-chain authorities remain distinct roles. The page never reads a signing key or requests a transaction signature.

The older four-wallet address directory has been retired from the UI. The fraction vault remains a separate script custody address, visible at `/vault`; it is not a Team wallet.

Start local development from `.env.example` and supply only the public identifiers and server-only project IDs needed for the workflows you use.

See the canonical [environment-variable reference](docs/ENVIRONMENT_VARIABLES.md)
for required values, optional overrides, visibility, and secret-handling rules.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_TEAM_KEY_HASH` | Public Team payment-key hash for recovery/shared-pool controls; the manifest supplies the current Preprod value. |

Set `NEXT_PUBLIC_CARDANO_NETWORK` to `preprod` or `mainnet`. The page forms a
Cexplorer link appropriate to that network.

## Blockfrost server configuration

Add separate server-only project IDs to `.env.local`. Never expose either
value with a `NEXT_PUBLIC_` prefix:

```bash
BLOCKFROST_PROJECT_ID=<Cardano Preprod project ID>
BLOCKFROST_IPFS_PROJECT_ID=<Blockfrost IPFS project ID>
```

The IPFS project ID is distinct from the Cardano Preprod project ID. It will
be used only by the server-side IPFS upload route; it is never sent to the
browser. The Mint RWA form pins three selected files up to 5 MB each: a PNG,
JPEG, or WebP image; a PDF proof-of-authenticity document; and a JSON metadata
object. It embeds the resulting `ipfs://` URIs in CIP-25 metadata. Before
exposing the application publicly, protect this upload route with your
application's issuer authentication and rate limits so untrusted users cannot
consume your IPFS quota.

## Team wallet safety

For production, create the Team wallet recovery phrase in a hardware wallet or
an offline, trusted Cardano wallet application. Keep its recovery phrase outside
this project and its cloud backups. Administrative actions are signed by the
connected wallet, never by a seed phrase stored in frontend configuration.

## Local demo wallets

For this demo only, local credentials are generated under `wallets/`, which is
ignored by Git. Import the Team recovery phrase into a compatible Preprod
wallet extension to sign demo transactions; do not reuse those credentials or
send mainnet funds to them.
