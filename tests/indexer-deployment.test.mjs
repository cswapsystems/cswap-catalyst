import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preprodWatchedAddresses } from '../scripts/indexer-config-preprod.mjs';

test('Preprod indexer watches the current deployments and authenticates the registry token', async () => {
  const actual = JSON.parse(await readFile(new URL('../infra/offchain/watched-addresses.preprod.json', import.meta.url), 'utf8'));
  assert.deepEqual(actual, await preprodWatchedAddresses(), 'Regenerate WatchedAddresses after a contract redeployment.');
  assert.equal(actual.length, 6);
  assert.equal(actual.filter(entry => entry.kind === 'registry' && /^[0-9a-f]{56,120}$/.test(entry.token)).length, 1);
});
