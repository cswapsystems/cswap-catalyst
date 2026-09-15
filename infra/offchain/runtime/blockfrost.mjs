const bases = {
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
};

export function createBlockfrostClient({ network, projectId, fetchImpl = fetch }) {
  const base = bases[network];
  if (!base) throw new Error(`Unsupported Cardano network: ${network}`);
  async function request(path, optional404 = false) {
    const response = await fetchImpl(`${base}${path}`, { headers: { project_id: projectId, accept: "application/json" } });
    if (optional404 && response.status === 404) return [];
    if (!response.ok) throw new Error(`Blockfrost ${path} failed with HTTP ${response.status}.`);
    return response.json();
  }
  return {
    latestBlock: () => request("/blocks/latest"),
    async addressUtxos(address) {
      const output = [];
      for (let page = 1; ; page += 1) {
        const batch = await request(`/addresses/${encodeURIComponent(address)}/utxos?count=100&page=${page}&order=asc`, true);
        output.push(...batch);
        if (batch.length < 100) return output;
      }
    },
  };
}
