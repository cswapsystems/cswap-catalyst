"use client";

import { confirmTransaction } from "@/lib/transaction-confirmation";
import { assertWalletSession, isWalletChangedError } from "@/lib/wallet-guard";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "./wallet-context";
import DexSwapFields from "./dex-swap-fields";
import { formatAda } from "@/lib/ada";
import { parseAdaToLovelace, quoteConstantProduct, quoteLiquidityDeposit, quoteLiquidityWithdrawal, priceImpactBps } from "@/lib/dex";
import { type Deployment, type Scripts, type Pool, type Action, actions, assetData, assetUnit, parseUnit, parseIntegerAmount, addressData, poolName, integerSqrt, asConstr, decodePool, isAuthenticatedPool, nextDatum, poolValue, reservePayout, displayName, format, loadDex } from "@/lib/protocol/dex-client";

export default function DexWorkbench({ mode = "swap" }: { mode?: "swap" | "liquidity" | "admin" }) {
  const { lucid, address, connect, disconnect, status, error: walletError } = useWallet();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [scripts, setScripts] = useState<Scripts | null>(null);
  const [pools, setPools] = useState<Pool[]>([]);
  const [selected, setSelected] = useState("");
  const [action, setAction] = useState<Action>(mode === "liquidity" ? "add" : mode === "admin" ? "create" : "swap-a");
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [pendingHash, setPendingHash] = useState("");
  const [asset, setAsset] = useState("");
  const [ada, setAda] = useState("10");
  const [amount, setAmount] = useState(mode === "swap" ? "" : "1");
  const [fractionAmount, setFractionAmount] = useState("100");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  // Survives the disconnect-triggered refresh so the user sees why a reconnect is required.
  const [sessionError, setSessionError] = useState("");
  const [canCreatePool, setCanCreatePool] = useState(false);
  const pool = useMemo(() => pools.find((item) => item.id === selected) ?? pools[0], [pools, selected]);
  const availableActions = actions.filter((item) => mode === "swap" ? item.id.startsWith("swap") : mode === "liquidity" ? ["add", "remove"].includes(item.id) : ["create", "destroy"].includes(item.id));

  const refresh = useCallback(async () => {
    setLoading(true); setMessage(null);
    try {
      const tools = await import("@lucid-evolution/lucid");
      const loaded = await loadDex(tools); setDeployment(loaded.deployment); setScripts(loaded.scripts); setCanCreatePool(loaded.canCreatePool);
      if (!lucid) { setPools([]); setBalances({}); setIsAdmin(false); return; }
      setSessionError("");
      const credential = tools.getAddressDetails(await lucid.wallet().address()).paymentCredential;
      setIsAdmin(credential?.type === "Key" && credential.hash === loaded.deployment.admin);
      const holdings: Record<string, bigint> = {};
      for (const utxo of await lucid.wallet().getUtxos()) for (const [unit, quantity] of Object.entries(utxo.assets)) holdings[unit] = (holdings[unit] ?? BigInt(0)) + quantity;
      setBalances(holdings);
      const found: Pool[] = [];
      for (const utxo of await lucid.utxosAt(loaded.deployment.ammAddress)) { try { const candidate = decodePool(tools, utxo); if (isAuthenticatedPool(candidate, loaded.deployment)) found.push(candidate); } catch { /* Ignore unrelated outputs. */ } }
      setPools(found); setSelected((current) => { const preferred = current || new URLSearchParams(window.location.search).get("pool"); return found.find((item) => item.id === preferred)?.id ?? found[0]?.id ?? ""; });
    } catch (cause) { setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "Unable to load pools." }); }
    finally { setLoading(false); }
  }, [lucid]);

  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);

  async function signSubmit(builder: ReturnType<NonNullable<typeof lucid>["newTx"]>) {
    if (!lucid) throw new Error("Connect Eternl before submitting a DEX transaction.");
    const completed = await builder.complete();
    // Re-check immediately before signing: outputs pay the stored context address.
    await assertWalletSession(lucid, address);
    const hash = await (await completed.sign.withWallet().complete()).submit();
    setPendingHash(hash);
    return hash;
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setMessage(null);
    try {
      if (!lucid || !address) throw new Error("Connect Eternl before submitting a DEX transaction.");
      if (!deployment || !scripts) throw new Error("DEX deployment is not loaded.");
      await assertWalletSession(lucid, address);
      const tools = await import("@lucid-evolution/lucid");
      const state = await lucid.utxoByUnit(deployment.factoryToken);
      let builder;
      if (action === "create") {
        const factoryStateScript = scripts.factoryState;
        if (!factoryStateScript) throw new Error("Pool creation requires the DEX factory migration to be deployed.");
        const fraction = parseUnit(asset); const reserveA = BigInt(ada) * BigInt(1_000_000); const reserveB = BigInt(fractionAmount);
        if (reserveA < BigInt(2_000_000) || reserveB <= BigInt(0)) throw new Error("Initial reserves must include at least 2 ADA and one fraction unit.");
        if (!state.datum) throw new Error("Factory state datum is missing.");
        const before = asConstr(tools.Data.from(state.datum), "factory");
        if (before.fields.length !== 5 || typeof before.fields[3] !== "bigint") throw new Error("Malformed factory datum.");
        const details = tools.getAddressDetails(address);
        if (details.paymentCredential?.type !== "Key" || details.paymentCredential.hash !== deployment.admin) throw new Error("Only the deployed factory admin can create pools.");
        const name = poolName(before.fields[3]); const poolNft = { policyId: deployment.poolPolicyId, assetName: name }; const lpToken = { policyId: deployment.lpPolicyId, assetName: name };
        const liquidity = integerSqrt(reserveA * reserveB);
        const after = new tools.Constr(0, [before.fields[0], before.fields[1], before.fields[2], before.fields[3] + BigInt(1), before.fields[4]]);
        const datum = new tools.Constr(0, [assetData(tools, poolNft), assetData(tools, { policyId: "", assetName: "" }), assetData(tools, fraction), assetData(tools, lpToken), BigInt(997), BigInt(1000), reserveA, reserveB, liquidity, reserveA]);
        builder = lucid.newTx().collectFrom([state], tools.Data.to(new tools.Constr(0, []))).mintAssets({ [assetUnit(poolNft)]: BigInt(1) }, tools.Data.to(new tools.Constr(0, []))).mintAssets({ [assetUnit(lpToken)]: liquidity }, tools.Data.to(new tools.Constr(0, [assetData(tools, poolNft)]))).attach.SpendingValidator(factoryStateScript).attach.MintingPolicy(scripts.poolFactory).attach.MintingPolicy(scripts.lp).pay.ToContract(deployment.factoryAddress, { kind: "inline", value: tools.Data.to(after) }, { ...state.assets }).pay.ToContract(deployment.ammAddress, { kind: "inline", value: tools.Data.to(datum) }, { lovelace: reserveA, [assetUnit(fraction)]: reserveB, [assetUnit(poolNft)]: BigInt(1) }).pay.ToAddress(address, { [assetUnit(lpToken)]: liquidity }).addSigner(address);
      } else {
        if (!pool) throw new Error("Select an active pool first.");
        const currentPool = await lucid.utxoByUnit(assetUnit(pool.poolNft));
        if (currentPool.txHash !== pool.utxo.txHash || currentPool.outputIndex !== pool.utxo.outputIndex) throw new Error("This pool changed since the quote was shown. Refresh and review the new amounts before signing.");
        let a = pool.reserveA; let b = pool.reserveB; let liquidity = pool.liquidity; let redeemer; let mint = BigInt(0); let lpRedeemer; let swapPayout: Record<string, bigint> | null = null;
        if (action === "swap-a") {
          const input = pool.assetA.policyId ? parseIntegerAmount(amount, "Quote amount") : parseAdaToLovelace(amount);
          const output = quoteConstantProduct(input, a, b, pool.feeN, pool.feeD);
          a += input; b -= output; redeemer = new tools.Constr(0, [output]); swapPayout = { [assetUnit(pool.assetB)]: output };
        } else if (action === "swap-b") {
          const input = parseIntegerAmount(amount, "Fraction amount");
          const output = quoteConstantProduct(input, b, a, pool.feeN, pool.feeD);
          b += input; a -= output; redeemer = new tools.Constr(0, [output]); swapPayout = { [assetUnit(pool.assetA)]: output };
        } else if (action === "add") {
          const requestedA = pool.assetA.policyId ? parseIntegerAmount(ada, "Quote amount") : parseAdaToLovelace(ada);
          const quote = quoteLiquidityDeposit(requestedA, a, b, liquidity);
          mint = quote.lp; a += quote.amountA; b += quote.amountB; liquidity += mint; redeemer = new tools.Constr(1, [mint]); lpRedeemer = new tools.Constr(1, [assetData(tools, pool.poolNft)]);
        } else if (action === "remove") {
          const burn = parseIntegerAmount(amount, "LP amount"); const quote = quoteLiquidityWithdrawal(burn, a, b, liquidity); a -= quote.amountA; b -= quote.amountB; liquidity -= burn; mint = -burn; redeemer = new tools.Constr(2, [quote.amountA, quote.amountB]); lpRedeemer = new tools.Constr(2, [assetData(tools, pool.poolNft)]);
        } else {
          const details = tools.getAddressDetails(address);
          if (details.paymentCredential?.type !== "Key" || details.paymentCredential.hash !== deployment.admin) throw new Error("Only the factory admin can destroy a pool.");
          builder = lucid.newTx().collectFrom([pool.utxo], tools.Data.to(new tools.Constr(3, [addressData(tools, address)]))).readFrom([state]).mintAssets({ [assetUnit(pool.poolNft)]: -BigInt(1) }, tools.Data.to(new tools.Constr(1, []))).mintAssets({ [assetUnit(pool.lpToken)]: -pool.liquidity }, tools.Data.to(new tools.Constr(3, [assetData(tools, pool.poolNft)]))).attach.SpendingValidator(scripts.amm).attach.MintingPolicy(scripts.poolFactory).attach.MintingPolicy(scripts.lp).pay.ToAddress(address, reservePayout(pool)).addSigner(address);
          const hash = await signSubmit(builder); const confirmed = await confirmTransaction(lucid, hash); if (!confirmed) throw new Error(`Pool destruction was submitted but not confirmed: ${hash}`); await refresh(); setPendingHash(""); setMessage({ kind: "success", text: `Pool destroyed. Transaction ${hash}` }); return;
        }
        const datum = nextDatum(tools, pool, a, b, liquidity);
        builder = lucid.newTx().collectFrom([pool.utxo], tools.Data.to(redeemer!)).readFrom([state]).attach.SpendingValidator(scripts.amm).pay.ToContract(deployment.ammAddress, { kind: "inline", value: tools.Data.to(datum) }, poolValue(pool, a, b));
        if (swapPayout) builder = builder.pay.ToAddress(address, swapPayout);
        if (mint !== BigInt(0)) builder = builder.mintAssets({ [assetUnit(pool.lpToken)]: mint }, tools.Data.to(lpRedeemer!)).attach.MintingPolicy(scripts.lp);
      }
      const hash = await signSubmit(builder); const confirmed = await confirmTransaction(lucid, hash); if (!confirmed) throw new Error(`Transaction was submitted but not confirmed: ${hash}`); await refresh(); setPendingHash(""); setMessage({ kind: "success", text: `Transaction confirmed: ${hash}` });
    } catch (cause) {
      if (isWalletChangedError(cause)) {
        // Invalidate the prepared quote and wallet-derived state; require an explicit reconnect.
        setAmount(""); setPools([]); setBalances({}); setIsAdmin(false); setSessionError(cause.message); disconnect();
        return;
      }
      setMessage({ kind: "error", text: cause instanceof Error ? cause.message : "DEX transaction failed." });
    }
    finally { setLoading(false); }
  }

  const estimate = pool && (action === "swap-a" || action === "swap-b") ? (() => { try { const input = action === "swap-a" ? (pool.assetA.policyId ? parseIntegerAmount(amount, "Quote amount") : parseAdaToLovelace(amount)) : parseIntegerAmount(amount, "Fraction amount"); return action === "swap-a" ? quoteConstantProduct(input, pool.reserveA, pool.reserveB, pool.feeN, pool.feeD) : quoteConstantProduct(input, pool.reserveB, pool.reserveA, pool.feeN, pool.feeD); } catch { return BigInt(0); } })() : null;

  const preview = (() => {
    if (!pool || !lucid || action === "create" || action === "destroy") return null;
    const show = (value: bigint, quote: boolean) => quote && !pool.assetA.policyId ? formatAda(value) + " tADA" : format(value) + " " + displayName(quote ? pool.assetA : pool.assetB) + " base units";
    try {
      const balanceA = balances[assetUnit(pool.assetA)] ?? BigInt(0), balanceB = balances[assetUnit(pool.assetB)] ?? BigInt(0), lp = balances[assetUnit(pool.lpToken)] ?? BigInt(0);
      if (action === "add" || action === "remove") {
        const quote = action === "add" ? quoteLiquidityDeposit(pool.assetA.policyId ? parseIntegerAmount(ada, "Quote amount") : parseAdaToLovelace(ada), pool.reserveA, pool.reserveB, pool.liquidity) : quoteLiquidityWithdrawal(parseIntegerAmount(amount, "LP amount"), pool.reserveA, pool.reserveB, pool.liquidity);
        const insufficient = action === "add" ? quote.amountA > balanceA || quote.amountB > balanceB : quote.lp > lp;
        return { lines: ["Your LP balance: " + format(lp), `${action === "add" ? "Deposit" : "Receive"}: ${show(quote.amountA, true)} + ${show(quote.amountB, false)}`, `${action === "add" ? "LP minted" : "LP burned"}: ${format(quote.lp)}`], warning: action === "add" ? "Deposits round up to the exact pool ratio. These are the actual amounts required." : "Amounts are rounded down to base units.", error: insufficient ? "Insufficient wallet balance for these amounts." : "" };
      }
      const input = action === "swap-a" ? pool.assetA.policyId ? parseIntegerAmount(amount, "Quote amount") : parseAdaToLovelace(amount) : parseIntegerAmount(amount, "Fraction amount");
      const output = estimate ?? BigInt(0);
      const impact = priceImpactBps(input, output, action === "swap-a" ? pool.reserveA : pool.reserveB, action === "swap-a" ? pool.reserveB : pool.reserveA);
      return { lines: [`Wallet balance: ${show(action === "swap-a" ? balanceA : balanceB, action === "swap-a")}`, `Receive: ${show(output, action === "swap-b")}`, `Price impact including fee and rounding: ${(Number(impact) / 100).toFixed(2)}%`], warning: impact >= BigInt(500) ? "High price impact: this trade receives at least 5% less than the current spot-rate amount." : "Direct execution uses this exact pool state. A competing transaction can require a fresh quote.", error: input > (action === "swap-a" ? balanceA : balanceB) ? "Insufficient wallet balance." : "" };
    } catch (cause) { return { lines: [], warning: "", error: cause instanceof Error ? cause.message : "Enter valid amounts." }; }
  })();

  async function checkPending() {
    if (!pendingHash) return;
    const response = await fetch(`/api/blockfrost/txs/${pendingHash}`, { cache: "no-store" });
    if (!response.ok) { setMessage({ kind: "error", text: "Confirmation is not available yet. Check the explorer before retrying." }); return; }
    await refresh(); setPendingHash(""); setMessage({ kind: "success", text: "Transaction confirmed." });
  }

  return <section className={"dex-workbench" + (mode === "swap" ? " dex-workbench-swap" : "")}><div className="dex-card"><div className="section-heading"><div><span className="section-kicker">{mode === "swap" ? "Direct pool swap" : "Constant-product exchange"}</span><h2>{mode === "swap" ? "Swap" : "Fraction liquidity pools"}</h2></div><span className="network-badge"><i /> Preprod</span></div><p className="dex-intro">{mode === "swap" ? "Choose your tokens and enter an amount to swap." : "Trade fractionalized RWA tokens against tADA or a supported native quote asset, provide liquidity, or administer pool lifecycle operations. Every operation is signed by the connected wallet."}</p>{mode !== "swap" && !canCreatePool && <p className="dex-warning" role="status">Pool creation and the three-party bootstrap remain unavailable until the factory migration is redeployed. Existing active pools can still be swapped and have liquidity managed.</p>}{mode !== "swap" && <div className="dex-tabs">{availableActions.map((item) => <button key={item.id} type="button" className={action === item.id ? "selected" : ""} disabled={loading || Boolean(pendingHash)} onClick={() => setAction(item.id)}>{item.label}</button>)}</div>}<form onSubmit={submit}><fieldset className="module-fieldset" disabled={loading || Boolean(pendingHash)}>
    {mode === "swap" && <DexSwapFields pools={pools} pool={pool} reverse={action === "swap-b"} amount={amount} estimate={estimate} balances={balances} connected={Boolean(lucid)} onAmount={setAmount} onPair={(id, direction) => { setSelected(id); setAction(direction); setAmount(""); setMessage(null); }} />}
    {mode !== "swap" && action !== "create" && <label className="field dex-field"><span className="field-label">Pool</span><select value={pool?.id ?? ""} onChange={(event) => setSelected(event.target.value)} disabled={!pools.length}>{pools.length ? pools.map((item) => <option key={item.id} value={item.id}>{displayName(item.assetB)} · {item.assetB.policyId.slice(0, 8)}…</option>) : <option>No active pools</option>}</select></label>}
    {action === "create" && <div className="dex-form-grid"><label className="field field-wide"><span className="field-label">Fraction asset unit</span><input value={asset} onChange={(event) => setAsset(event.target.value)} placeholder="policy ID + asset name hex" required /></label><label className="field"><span className="field-label">Initial tADA</span><input type="number" min="2" step="1" value={ada} onChange={(event) => setAda(event.target.value)} required /></label><label className="field"><span className="field-label">Initial fraction units</span><input type="number" min="1" step="1" value={fractionAmount} onChange={(event) => setFractionAmount(event.target.value)} required /></label></div>}
    {action === "add" && <label className="field dex-field"><span className="field-label">{pool ? displayName(pool.assetA) + " to add" : "Quote asset to add"}</span><input type="text" inputMode="decimal" value={ada} onChange={(event) => setAda(event.target.value)} required /><span className="field-hint">The matching fraction amount is calculated from the current reserve ratio.</span></label>}
    {action === "remove" && <label className="field dex-field"><span className="field-label">LP units to burn</span><input type="number" inputMode="numeric" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>}
    {preview && mode !== "swap" && <div className="execution-preview" aria-live="polite"><h3>Transaction preview</h3>{preview.lines.map((line) => <p key={line}>{line}</p>)}<p>{preview.warning}</p><p>Keep ADA available for the network fee and required output deposits.</p>{preview.error && <p role="alert" className="form-message error-message">{preview.error}</p>}</div>}
    {mode === "swap" && <div className="swap-quote-note" aria-live="polite">{preview && amount.trim() && <>{preview.lines.slice(2).map((line) => <p key={line}>{line}</p>)}{preview.warning && <p>{preview.warning}</p>}{preview.error && <p role="alert" className="form-message error-message">{preview.error}</p>}</>}<p>{!lucid ? "Connect your wallet to load available pairs and balances." : !pool ? "No active swap pairs are available in this deployment." : "Network fees are separate. Keep ADA available for fees and output deposits."}</p></div>}
    {mode === "admin" && !isAdmin && <p className="dex-warning">Connect the configured factory administrator to use these controls.</p>}{action === "destroy" && <div className="dex-warning">Destroying requires the admin wallet to hold and burn the pool&apos;s entire LP supply. All reserves return to that wallet.</div>}
    {mode === "swap" ? <div className="swap-submit">{!lucid ? <button className="primary-button" type="button" disabled={loading || status === "connecting" || Boolean(pendingHash)} onClick={() => void connect()}>{status === "connecting" ? "Connecting…" : "Connect wallet"}</button> : <button className="primary-button" type="submit" disabled={loading || Boolean(pendingHash) || !pool || !amount.trim() || Boolean(preview?.error) || !estimate}>{loading ? "Working…" : pendingHash ? "Awaiting confirmation" : !pool ? "No available pairs" : !amount.trim() ? "Enter an amount" : "Swap"}</button>}{walletError && !lucid && <p className="form-message error-message" role="alert">{walletError}</p>}</div> : <div className="form-footer"><p><span className="status-dot" /> {pools.length} active pool{pools.length === 1 ? "" : "s"}</p><button className="primary-button" type="submit" disabled={loading || Boolean(pendingHash) || !lucid || Boolean(preview?.error) || (mode === "admin" && !isAdmin) || (action === "create" && !canCreatePool) || (!pool && action !== "create")}>{loading ? "Working…" : availableActions.find((item) => item.id === action)?.label} <span className="button-arrow">↗</span></button></div>}
  </fieldset></form>{pendingHash && <p className="form-message" role="status">Submitted; waiting for confirmation. <a href={`https://preprod.cardanoscan.io/transaction/${pendingHash}`} target="_blank" rel="noreferrer">View transaction</a> <button type="button" onClick={() => void checkPending().catch(() => setMessage({ kind: "error", text: "Unable to check confirmation. Try again." }))} disabled={loading}>Check confirmation</button></p>}{sessionError && <p className="form-message error-message" role="alert">{sessionError}</p>}{message && <p className={`form-message ${message.kind === "error" ? "error-message" : "success-message"}`}>{message.text}</p>}</div>
  <div className="dex-pools"><div className="dex-pools-head"><div><span className="section-kicker">On-chain state</span><h3>Active pools</h3></div><button type="button" className="refresh-button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>{!lucid ? <p className="dex-empty">Connect Eternl to read and operate the deployed pools.</p> : pools.length === 0 ? <p className="dex-empty">No active pool is currently indexed.</p> : pools.map((item) => <article className="dex-pool" key={item.id}><div><strong>{displayName(item.assetB)} / {displayName(item.assetA)}</strong><code>{assetUnit(item.assetB)}</code></div><dl><div><dt>{displayName(item.assetA)} reserve</dt><dd>{item.assetA.policyId ? format(item.reserveA) : formatAda(item.reserveA)}</dd></div><div><dt>Fraction reserve</dt><dd>{format(item.reserveB)}</dd></div><div><dt>LP supply</dt><dd>{format(item.liquidity)}</dd></div><div><dt>Fee</dt><dd>{Number(item.feeD - item.feeN) / Number(item.feeD) * 100}%</dd></div></dl></article>)}{deployment && <a className="explorer-link" href={`https://preprod.cardanoscan.io/address/${deployment.ammAddress}`} target="_blank" rel="noreferrer">Inspect DEX on Cardanoscan <span className="button-arrow">↗</span></a>}</div></section>;
}
