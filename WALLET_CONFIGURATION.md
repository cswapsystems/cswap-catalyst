# Wallet configuration

The Wallets page reads **public Cardano addresses** from `.env.local`. Start by
copying `.env.example` to `.env.local` and add the addresses after the wallets
and vault are deployed.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_ISSUER_WALLET` | Issuer/admin public receiving address. |
| `NEXT_PUBLIC_CUSTODY_WALLET` | Custody address that provides the RWA NFT. |
| `NEXT_PUBLIC_TREASURY_WALLET` | Protocol-fee receiving address. |
| `NEXT_PUBLIC_SETTLEMENT_WALLET` | Sale and liquidation settlement address. |
| `NEXT_PUBLIC_VAULT_ADDRESS` | Deployed vault script address. |

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

## Admin wallet safety

For production, create the admin wallet recovery phrase in a hardware wallet or
an offline, trusted Cardano wallet application. Keep its recovery phrase outside
this project and its cloud backups. The app only needs the wallet's **public
receiving address**; minting and administrative actions should be signed by the
connected wallet, never by a seed phrase stored in frontend configuration.

## Local demo wallets

For this demo only, local credentials are generated under `wallets/` and their
public Preprod addresses are configured in `.env.local`. That directory is
ignored by Git. Import the admin recovery phrase into a compatible Preprod
wallet extension to sign demo transactions; do not reuse those credentials or
send mainnet funds to them.
