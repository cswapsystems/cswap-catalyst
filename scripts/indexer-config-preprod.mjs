import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatorToAddress } from '@lucid-evolution/lucid';
import { parseWatchedAddresses } from '../infra/offchain/runtime/config.mjs';

const root = new URL('../', import.meta.url);
const json = path => readFile(new URL(path, root), 'utf8').then(JSON.parse);

export async function preprodWatchedAddresses() {
  const [marketplace, dex, minter] = await Promise.all([
    json('marketplace-deployment.preprod.json'), json('dex-deployment.preprod.json'), json('contracts/minter/plutus.json'),
  ]);
  if (marketplace.network !== 'preprod' || dex.network !== 'preprod') throw new Error('Both deployment manifests must target Preprod.');
  const vault = minter.validators.find(v => v.title === 'vault.vault.spend');
  if (!vault) throw new Error('Vault validator is missing.');
  const watched = [
    { kind: 'registry', address: marketplace.registry.address, token: marketplace.registry.token },
    { kind: 'orderbook', address: marketplace.orderbookAddress },
    { kind: 'quote-pool', address: marketplace.pool.address },
    { kind: 'vault', address: validatorToAddress('Preprod', { type: 'PlutusV3', script: vault.compiledCode }) },
    { kind: 'dex-factory', address: dex.factoryAddress },
    { kind: 'dex-pool', address: dex.ammAddress },
  ];
  if (watched.some(entry => !entry.address?.startsWith('addr_test1'))) throw new Error('Every watched address must be a testnet address.');
  return parseWatchedAddresses(JSON.stringify(watched));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await preprodWatchedAddresses(), null, 2));
}
