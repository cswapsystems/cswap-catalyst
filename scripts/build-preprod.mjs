import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// A deployment is one coherent set of identities. Never let leftover Amplify
// variables mix an old registry/orderbook with a newly committed pool manifest.
const deployment = JSON.parse(readFileSync(new URL('../marketplace-deployment.preprod.json', import.meta.url), 'utf8'));
if (deployment.network !== 'preprod' || deployment.schemaVersion !== 14 || deployment.referenceScripts?.length !== 4) throw new Error('A verified 14-field Preprod marketplace manifest with all four reference scripts is required.');
const result = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', env: {
  ...process.env,
  NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS: deployment.orderbookAddress,
  NEXT_PUBLIC_QUOTE_POOL_ADDRESS: deployment.pool.address,
  NEXT_PUBLIC_ASSET_REGISTRY_TOKEN: deployment.registry.token,
  NEXT_PUBLIC_ASSET_REGISTRY_ISSUER: deployment.registry.issuer,
} });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
