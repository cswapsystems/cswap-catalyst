# Local demo wallets

This directory contains local-only Cardano demo credentials for these roles:

- `admin`
- `custody`
- `treasury`
- `settlement`

Each role directory includes a 24-word recovery phrase, a derived payment
signing key, verification key, and Preprod receiving address. All credential
files are ignored by Git and should remain local. The Wallets page reads the
public addresses from the root `.env.local` file.

For browser signing, import only the `admin` recovery phrase into a compatible
Preprod wallet extension. Do not use these demo credentials with mainnet funds.
