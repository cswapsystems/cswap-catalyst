"use client";

import AssetBrowser from "./asset-browser";
import PlatformHeader from "./platform-header";

const assetBrowserStyles = `
.asset-browser { padding: clamp(25px, 4vw, 46px); border: 1px solid var(--line); border-radius: 14px; background: var(--cream); box-shadow: 0 22px 50px rgba(38,50,40,.07); }
.asset-browser-head { display: flex; align-items: start; justify-content: space-between; gap: 20px; }
.asset-browser h2 { margin-top: 8px; font-family: var(--font-financial); font-size: 29px; font-weight: 750; letter-spacing: -1px; }
.asset-browser-head .directory-intro { max-width: 670px; }
.asset-search { display: flex; align-items: end; gap: 14px; margin-top: 31px; padding: 18px; background: #eef3e8; border-left: 3px solid var(--lime); border-radius: 7px; }
.asset-search .field { flex: 1; }
.asset-search .primary-button { height: 47px; }
.asset-empty { display: grid; justify-items: center; padding: 57px 28px; margin-top: 15px; text-align: center; border: 1px dashed #bdc8ba; border-radius: 8px; background: #f7f9f3; }
.asset-empty-mark { display: grid; place-items: center; width: 55px; height: 55px; color: var(--deep-moss); background: var(--lime); border-radius: 50%; font-size: 25px; }
.asset-empty strong { margin-top: 17px; font-size: 17px; }
.asset-empty p { max-width: 520px; margin-top: 7px; color: #89928d; font-size: 14px; line-height: 1.6; }
.asset-result { margin-top: 15px; }
.asset-identity-card { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 19px; border: 1px solid var(--line); border-radius: 8px; background: white; }
.asset-visual { width: 92px; height: 92px; display: grid; place-items: center; overflow: hidden; color: var(--deep-moss); background: #e4ecd1; border-radius: 8px; font-size: 21px; font-weight: 800; }
.asset-visual img { width: 100%; height: 100%; object-fit: cover; }
.asset-status { display: inline-flex; align-items: center; gap: 6px; color: var(--moss); font-size: 13px; font-weight: 800; letter-spacing: .7px; text-transform: uppercase; }
.asset-status i { width: 6px; height: 6px; background: #82b865; border-radius: 50%; }
.asset-identity-copy h3 { margin-top: 6px; font-size: 23px; letter-spacing: -.6px; }
.asset-identity-copy p { margin-top: 5px; color: var(--muted); font-size: 14px; line-height: 1.45; }
.asset-identity-copy code { display: block; max-width: 100%; margin-top: 9px; overflow: hidden; color: #738078; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.asset-identity-card .explorer-link { margin-top: 0; white-space: nowrap; }
.asset-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-top: 15px; }
.asset-panel { padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: white; }
.asset-panel-heading { display: flex; align-items: start; justify-content: space-between; gap: 15px; }
.asset-panel-heading h3 { margin-top: 7px; font-size: 19px; letter-spacing: -.5px; }
.asset-panel-icon { color: var(--moss); font-size: 10px; font-weight: 800; }
.asset-facts { margin-top: 20px; }
.asset-facts div { display: flex; justify-content: space-between; gap: 15px; padding: 10px 0; border-top: 1px solid #edf0eb; }
.asset-facts dt { color: #89928d; font-size: 13px; font-weight: 700; }
.asset-facts dd { max-width: 66%; margin: 0; overflow-wrap: anywhere; color: var(--ink); font-size: 14px; font-weight: 800; text-align: right; }
.asset-facts dd small { display: block; margin-top: 4px; color: #a1aaa3; font-size: 12px; font-weight: 500; }
.asset-facts a { color: var(--moss); text-decoration: none; }
.asset-facts code { color: #536158; font-size: 12px; }
.metadata-panel, .files-panel { margin-top: 15px; }
.metadata-summary { display: grid; grid-template-columns: 1.4fr 1fr .6fr; gap: 15px; margin-top: 21px; }
.metadata-summary div { padding: 13px; background: #f5f7f2; border-radius: 6px; }
.metadata-summary span { display: block; color: #89928d; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .5px; }
.metadata-summary strong { display: block; margin-top: 6px; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.metadata-content details { margin-top: 15px; }
.metadata-content summary { color: var(--moss); cursor: pointer; font-size: 13px; font-weight: 800; }
.metadata-content pre { max-height: 260px; padding: 14px; margin-top: 10px; overflow: auto; color: #536158; background: #f5f7f2; border-radius: 6px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
.asset-muted { margin-top: 20px; color: #89928d; font-size: 14px; line-height: 1.55; }
.file-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 21px; }
.file-card { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 13px; color: var(--ink); border: 1px solid #e0e5dc; border-radius: 7px; background: #f8faf6; text-decoration: none; }
.file-card:hover { border-color: var(--moss); background: white; }
.file-card-featured { grid-column: span 1; padding: 8px; }
.file-preview { width: 50px; height: 50px; flex: 0 0 auto; overflow: hidden; border-radius: 4px; background: #e4ecd1; }
.file-preview img { width: 100%; height: 100%; object-fit: cover; }
.file-type { display: grid; place-items: center; width: 37px; height: 37px; flex: 0 0 auto; color: var(--deep-moss); background: var(--lime); border-radius: 5px; font-size: 11px; font-weight: 900; }
.file-card-copy { min-width: 0; flex: 1; }
.file-card-copy strong, .file-card-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-card-copy strong { font-size: 14px; }
.file-card-copy small { margin-top: 4px; color: #89928d; font-size: 12px; }
.file-card > .button-arrow { color: var(--moss); }
@media (max-width: 800px) { .asset-identity-card { grid-template-columns: 72px minmax(0, 1fr); }.asset-visual { width: 72px; height: 72px; }.asset-identity-card .explorer-link { grid-column: 2; }.file-grid { grid-template-columns: 1fr 1fr; }.file-card-featured { grid-column: span 2; } }
@media (max-width: 560px) { .asset-browser { padding: 25px 20px; }.asset-browser-head { flex-direction: column; }.asset-search { align-items: stretch; flex-direction: column; }.asset-search .primary-button { justify-content: center; }.asset-detail-grid { grid-template-columns: 1fr; }.metadata-summary { grid-template-columns: 1fr; gap: 8px; }.file-grid { grid-template-columns: 1fr; }.file-card-featured { grid-column: span 1; }.asset-identity-card { grid-template-columns: 58px minmax(0, 1fr); gap: 12px; padding: 13px; }.asset-visual { width: 58px; height: 58px; }.asset-identity-copy h3 { font-size: 18px; }.asset-identity-card .explorer-link { grid-column: 1 / -1; } }
`;


export default function AssetPlatform() {
  return <div className="platform-shell"><style>{assetBrowserStyles}</style><PlatformHeader /><main className="page-main"><section className="hero"><div><span className="eyebrow"><span className="eyebrow-icon">⌕</span>Asset intelligence</span><h1>Know what your token carries</h1><p>Inspect the on-chain record, metadata, and files created when an asset was minted.</p></div></section><AssetBrowser /></main><footer><span>© 2025 CSWAP Systems</span><span>Built for real-world assets <b>•</b> Secured on-chain</span><div><a href="#">Terms</a><a href="#">Support</a></div></footer></div>;
}
