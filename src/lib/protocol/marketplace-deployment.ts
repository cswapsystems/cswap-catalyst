import deployment from "../../../marketplace-deployment.preprod.json";

export const marketplaceDeployment = deployment;
export const marketplaceOrderbookAddress = process.env.NEXT_PUBLIC_SIMPLE_ORDERBOOK_ADDRESS || deployment.orderbookAddress;
export const marketplacePoolAddress = process.env.NEXT_PUBLIC_QUOTE_POOL_ADDRESS || deployment.pool.address;
export const marketplaceRegistryToken = process.env.NEXT_PUBLIC_ASSET_REGISTRY_TOKEN || deployment.registry.token;
export const marketplaceRegistryIssuer = process.env.NEXT_PUBLIC_ASSET_REGISTRY_ISSUER || deployment.registry.issuer;
export const marketplaceTeamKey = process.env.NEXT_PUBLIC_TEAM_KEY_HASH || deployment.team;
