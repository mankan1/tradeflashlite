// src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ===================== Types ===================== */
type EquityTick = {
  symbol: string;
  last?: number;
  bid?: number;
  ask?: number;
  iv?: number;
  ts?: number;
};
type OptionRow = {
  underlying: string;
  expiration: string;
  strike: number;
  right: "C" | "P";
  last?: number | null;
  bid?: number;
  ask?: number;
  ts?: number;
};
type FlowBase = {
  ul: string;
  right: "CALL" | "PUT";
  strike: number;
  expiry: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  notional?: number;   // optional from server
  prints?: number;
  venue?: string;
  ts: number;
};
type Sweep = FlowBase & { kind: "SWEEP" };
type Block = FlowBase & { kind: "BLOCK" };
type Watchlist = {
  equities: string[];
  options: { underlying: string; expiration: string; strike: number; right: "C" | "P" }[];
};

/* ===================== Config ===================== */
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8080";
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8080/ws";

/* ===================== Helpers ===================== */
function fmt(n?: number | null, d = 2) {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  return n.toFixed(d);
}
function tsAgo(ts?: number) {
  if (!ts) return "–";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}
const notionalOf = (m: { notional?: number; qty?: number; price?: number }) =>
  Math.round(m.notional ?? ((m.qty || 0) * (m.price || 0) * 100));

/* ===================== App ===================== */
export default function App() {
  const wsRef = useRef<WebSocket | null>(null);

  // --- Local filters ---
//   const [minNotional, setMinNotional] = useState<number>(20000);
//   const [minQty, setMinQty] = useState<number>(50);
  const [minNotional, setMinNotional] = useState<number>(0);
  const [minQty, setMinQty] = useState<number>(1);

  const [wsState, setWsState] = useState<"idle" | "connecting" | "open" | "closed" | "error">("idle");
  const [equity, setEquity] = useState<Record<string, EquityTick>>({});
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [sweeps, setSweeps] = useState<Sweep[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [wl, setWl] = useState<Watchlist>({ equities: [], options: [] });
  const [err, setErr] = useState<string | undefined>();

  // --- WS connect ---
  useEffect(() => {
    let stopped = false;
    let retry = 0;
    const connect = () => {
      if (stopped) return;
      setWsState("connecting");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsState("open");
        retry = 0;
      };
      ws.onclose = () => {
        setWsState("closed");
        if (!stopped) {
          const backoff = Math.min(1000 * Math.pow(2, retry++), 10000);
          setTimeout(connect, backoff);
        }
      };
      ws.onerror = () => setWsState("error");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          switch (msg.topic) {
            case "equity_ts": {
              const arr = msg.data as EquityTick[];
              setEquity((prev) => {
                const next = { ...prev };
                arr.forEach((t) => {
                  next[t.symbol] = t;
                });
                return next;
              });
              break;
            }
            case "options_ts": {
              setOptions(msg.data as OptionRow[]);
              break;
            }
            case "sweeps": {
              setSweeps((prev) => [...prev.slice(-400), ...(msg.data as Sweep[])]);
              break;
            }
            case "blocks": {
              setBlocks((prev) => [...prev.slice(-400), ...(msg.data as Block[])]);
              break;
            }
            case "watchlist": {
              setWl(msg.data as Watchlist);
              break;
            }
            default:
              break;
          }
        } catch (e: any) {
          setErr(String(e?.message ?? e));
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      wsRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Derived views ---
  const equityRows = useMemo(
    () => Object.values(equity).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [equity]
  );

  const optGrouped = useMemo(() => {
    const m = new Map<string, OptionRow[]>();
    for (const r of options) {
      const k = `${r.underlying}:${r.expiration}`;
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return Array.from(m.entries()).map(([k, rows]) => ({
      key: k,
      rows: rows.sort((a, b) => a.strike - b.strike),
    }));
  }, [options]);

  const filteredSweeps = useMemo(
    () => sweeps.filter((m) => notionalOf(m) >= minNotional && (m.qty || 0) >= minQty),
    [sweeps, minNotional, minQty]
  );

  const filteredBlocks = useMemo(
    () => blocks.filter((m) => notionalOf(m) >= minNotional && (m.qty || 0) >= minQty),
    [blocks, minNotional, minQty]
  );

  // --- REST actions (watchlist) ---
  async function addEquity(sym: string) {
    try {
      const res = await fetch(`${API_BASE}/watchlist/equities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym.trim().toUpperCase() }),
      });
      if (!res.ok) throw new Error(`POST /watchlist/equities ${res.status}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }
  async function delEquity(sym: string) {
    try {
      const res = await fetch(`${API_BASE}/watchlist/equities/${encodeURIComponent(sym)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`DELETE /watchlist/equities ${res.status}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  // --- Local input state ---
  const [newSym, setNewSym] = useState("");

  return (
    <>
      {/* Header */}
      <div className="p-4 border-b flex items-center gap-3">
        <div className="text-xl font-bold">TradeFlash Lite</div>
        <div className="text-sm px-2 py-1 rounded bg-gray-100">
          WS:{" "}
          <span
            className={
              wsState === "open"
                ? "text-green-600"
                : wsState === "connecting"
                ? "text-amber-600"
                : wsState === "error"
                ? "text-red-600"
                : "text-gray-600"
            }
          >
            {wsState}
          </span>
        </div>
        {err && <div className="text-sm text-red-600 ml-2">Error: {err}</div>}
        <div className="ml-auto text-xs text-gray-500">
          API_BASE: {API_BASE} · WS_URL: {WS_URL}
        </div>
      </div>

      {/* Layout */}
      <div className="p-4 grid gap-4" style={{ gridTemplateColumns: "1.2fr 1fr" }}>
        {/* Left column */}
        <div className="grid gap-4">
          {/* Overview (Equities) */}
          <section className="border rounded-lg p-3">
            <div className="font-semibold mb-2">Overview (Equities)</div>
            <div className="overflow-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1 pr-3">Symbol</th>
                    <th className="py-1 pr-3">Last</th>
                    <th className="py-1 pr-3">Bid</th>
                    <th className="py-1 pr-3">Ask</th>
                    <th className="py-1 pr-3">IV</th>
                    <th className="py-1 pr-3">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {equityRows.map((r) => (
                    <tr key={r.symbol} className="border-b last:border-0">
                      <td className="py-1 pr-3 font-mono">{r.symbol}</td>
                      <td className="py-1 pr-3">{fmt(r.last, 2)}</td>
                      <td className="py-1 pr-3">{fmt(r.bid, 2)}</td>
                      <td className="py-1 pr-3">{fmt(r.ask, 2)}</td>
                      <td className="py-1 pr-3">{fmt(r.iv, 0)}</td>
                      <td className="py-1 pr-3">{tsAgo(r.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Options T&S (grouped) */}
          <section className="border rounded-lg p-3">
            <div className="font-semibold mb-2">Options (read-only demo)</div>
            {optGrouped.length === 0 ? (
              <div className="text-sm text-gray-500">Waiting for chain snapshots…</div>
            ) : (
              <div className="flex flex-col gap-4">
                {optGrouped.map(({ key, rows }) => (
                  <div key={key} className="border rounded-md p-2">
                    <div className="text-sm font-semibold mb-2">{key}</div>
                    <div className="overflow-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="text-left border-b">
                            <th className="py-1 pr-3">Strike</th>
                            <th className="py-1 pr-3">Right</th>
                            <th className="py-1 pr-3">Last</th>
                            <th className="py-1 pr-3">Bid</th>
                            <th className="py-1 pr-3">Ask</th>
                            <th className="py-1 pr-3">Age</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={`${key}:${i}`} className="border-b last:border-0">
                              <td className="py-1 pr-3">{r.strike}</td>
                              <td className="py-1 pr-3">{r.right}</td>
                              <td className="py-1 pr-3">{fmt(r.last, 2)}</td>
                              <td className="py-1 pr-3">{fmt(r.bid, 2)}</td>
                              <td className="py-1 pr-3">{fmt(r.ask, 2)}</td>
                              <td className="py-1 pr-3">{tsAgo(r.ts)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right column */}
        <div className="grid gap-4">
          {/* Watchlist */}
          <section className="border rounded-lg p-3">
            <div className="font-semibold mb-2">Watchlist</div>
            <div className="flex gap-2 mb-2">
              <input
                value={newSym}
                onChange={(e) => setNewSym(e.target.value)}
                placeholder="Add symbol (e.g., NVDA)"
                className="border rounded px-2 py-1 text-sm"
              />
              <button
                className="border rounded px-2 py-1 text-sm"
                onClick={() => {
                  if (newSym.trim()) addEquity(newSym);
                  setNewSym("");
                }}
              >
                Add
              </button>
            </div>
            <div className="text-sm font-medium mb-1">Equities</div>
            <ul className="list-disc ml-6 mb-3">
              {wl.equities.map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <span className="font-mono">{s}</span>
                  <button className="text-xs text-red-600 underline" onClick={() => delEquity(s)}>
                    remove
                  </button>
                </li>
              ))}
              {wl.equities.length === 0 && <li className="text-gray-500">Empty</li>}
            </ul>

            <div className="text-sm font-medium mb-1">Options (read-only)</div>
            <ul className="list-disc ml-6">
              {wl.options.map((o, i) => (
                <li key={i} className="font-mono">
                  {o.underlying} {o.right} {o.strike} {o.expiration}
                </li>
              ))}
              {wl.options.length === 0 && <li className="text-gray-500">Empty</li>}
            </ul>
          </section>

          {/* Filters */}
          <section className="border rounded-lg p-3">
            <div className="font-semibold mb-2">Filters</div>
            <div className="flex items-end gap-4 flex-wrap">
              <label className="text-sm">
                <div className="text-gray-600 mb-1">Min notional ($)</div>
                <input
                  type="number"
                  className="border rounded px-2 py-1 text-sm w-36"
                  value={minNotional}
                  onChange={(e) => setMinNotional(Math.max(0, Number(e.target.value || 0)))}
                  min={0}
                  step={1000}
                />
              </label>
              <label className="text-sm">
                <div className="text-gray-600 mb-1">Min contracts (qty)</div>
                <input
                  type="number"
                  className="border rounded px-2 py-1 text-sm w-36"
                  value={minQty}
                  onChange={(e) => setMinQty(Math.max(0, Number(e.target.value || 0)))}
                  min={0}
                  step={10}
                />
              </label>
              <button
                className="border rounded px-3 py-1 text-sm"
                onClick={() => {
                  setMinNotional(20000);
                  setMinQty(50);
                }}
              >
                Reset
              </button>
              <div className="text-xs text-gray-500 ml-auto">Applies to Sweeps &amp; Blocks lists</div>
            </div>
          </section>

          {/* Sweeps */}
          <section className="border rounded-lg p-3">
            <div className="font-semibold mb-2">Sweeps</div>
            <div className="text-xs text-gray-500 mb-2">
              Showing {filteredSweeps.length} of {sweeps.length}
            </div>
            <div className="overflow-auto max-h-[360px]">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1 pr-3">UL</th>
                    <th className="py-1 pr-3">Right</th>
                    <th className="py-1 pr-3">Strike</th>
                    <th className="py-1 pr-3">Expiry</th>
                    <th className="py-1 pr-3">Side</th>
                    <th className="py-1 pr-3">Qty</th>
                    <th className="py-1 pr-3">Price</th>
                    <th className="py-1 pr-3">Notional</th>
                    <th className="py-1 pr-3">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSweeps.slice(-200).reverse().map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1 pr-3 font-mono">{r.ul}</td>
                      <td className="py-1 pr-3">{r.right}</td>
                      <td className="py-1 pr-3">{r.strike}</td>
                      <td className="py-1 pr-3">{r.expiry}</td>
                      <td className="py-1 pr-3">{r.side}</td>
                      <td className="py-1 pr-3">{r.qty}</td>
                      <td className="py-1 pr-3">{fmt(r.price, 2)}</td>
                      <td className="py-1 pr-3">{fmt(notionalOf(r), 0)}</td>
                      <td className="py-1 pr-3">{tsAgo(r.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Blocks */}
          <section className="border rounded-lg p-3">
            <div className="font-semibold mb-2">Blocks</div>
            <div className="text-xs text-gray-500 mb-2">
              Showing {filteredBlocks.length} of {blocks.length}
            </div>
            <div className="overflow-auto max-h-[360px]">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1 pr-3">UL</th>
                    <th className="py-1 pr-3">Right</th>
                    <th className="py-1 pr-3">Strike</th>
                    <th className="py-1 pr-3">Expiry</th>
                    <th className="py-1 pr-3">Side</th>
                    <th className="py-1 pr-3">Qty</th>
                    <th className="py-1 pr-3">Price</th>
                    <th className="py-1 pr-3">Notional</th>
                    <th className="py-1 pr-3">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBlocks.slice(-200).reverse().map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1 pr-3 font-mono">{r.ul}</td>
                      <td className="py-1 pr-3">{r.right}</td>
                      <td className="py-1 pr-3">{r.strike}</td>
                      <td className="py-1 pr-3">{r.expiry}</td>
                      <td className="py-1 pr-3">{r.side}</td>
                      <td className="py-1 pr-3">{r.qty}</td>
                      <td className="py-1 pr-3">{fmt(r.price, 2)}</td>
                      <td className="py-1 pr-3">{fmt(notionalOf(r), 0)}</td>
                      <td className="py-1 pr-3">{tsAgo(r.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
