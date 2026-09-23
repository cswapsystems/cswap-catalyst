export type NavigationItem = { href: string; label: string };
export type NavigationSection = { label: string; primary: string | null; items: NavigationItem[] };

export const primaryNavigation: NavigationItem[] = [
  { href: "/marketplace", label: "Marketplace" },
  { href: "/dex", label: "Swap" },
  { href: "/my-assets", label: "Portfolio" },
  { href: "/mint", label: "Create" },
];

export const navigationSections: Record<string, NavigationSection> = {
  portfolio: { label: "Portfolio", primary: "/my-assets", items: [
    { href: "/my-assets", label: "Holdings" },
    { href: "/portfolio/positions", label: "Open positions" },
    { href: "/portfolio/orders", label: "Listings & requests" },
    { href: "/portfolio/reserves", label: "Shared liquidity" },
    { href: "/history", label: "Activity" },
  ] },
  dex: { label: "Exchange", primary: "/dex", items: [
    { href: "/dex", label: "Swap" },
    { href: "/dex/liquidity", label: "Pool liquidity" },
    { href: "/dex/launch", label: "Launch a pool" },
  ] },
  create: { label: "Create", primary: "/mint", items: [
    { href: "/mint", label: "Mint an asset" },
    { href: "/fractionalize", label: "Split or combine" },
  ] },
  operations: { label: "Operations", primary: null, items: [
    { href: "/team", label: "Overview & requests" },
    { href: "/team/inventory", label: "Prices & inventory" },
    { href: "/registry", label: "Asset approvals" },
    { href: "/team/controls", label: "Shared pool" },
    { href: "/team/dex", label: "DEX controls" },
    { href: "/team/recovery", label: "Recovery" },
    { href: "/wallets", label: "Deployment wallets" },
  ] },
  protocol: { label: "Protocol", primary: null, items: [
    { href: "/protocol", label: "Overview" },
    { href: "/asset-registry", label: "Approved assets" },
    { href: "/vault", label: "Vault activity" },
  ] },
};

const aliases: Record<string, string> = { "/": "/marketplace", "/list": "/my-assets", "/reserves": "/portfolio/reserves", "/liquidate": "/my-assets" };

export function navigationForPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const path = aliases[normalized] ?? normalized;
  const section = Object.values(navigationSections).find(group => group.items.some(item => item.href === path))
    ?? (path === "/wallet" ? navigationSections.portfolio : null);
  return { path, section, primary: section ? section.primary : path === "/marketplace" ? path : null };
}
