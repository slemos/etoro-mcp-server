import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

export const API_KEY = "TEST_API_KEY_abcdef123456";
export const USER_KEY = "TEST_USER_KEY_ghijkl654321";

export function baseCfg(over: Partial<Config> = {}): Config {
  return {
    apiKey: API_KEY,
    userKey: USER_KEY,
    env: "demo",
    baseUrl: "https://public-api.etoro.com",
    enableWrite: false,
    allowRealWrite: false,
    allowTransfers: false,
    requireElicitation: false,
    maxOrderUsd: 100,
    maxSessionUsd: 500,
    maxWritesPerMinute: 5,
    confirmTtlMs: 300_000,
    requestTimeoutMs: 30_000,
    strictKeyScope: false,
    maxResponseChars: 120_000,
    debug: false,
    ...over,
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (call: RecordedCall) => MockResponse | undefined;

/** A fetch stub that records every request and answers through `handler`. */
export function mockFetch(handler: Handler): { fn: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input.toString());
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const res = handler(call) ?? { status: 404, json: { title: "no mock" } };
    return new Response(res.json === undefined ? "" : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: res.headers,
    });
  }) as typeof fetch;
  return { fn, calls };
}

/** What GET /api/v1/me returns for a Demo key with Read+Write (the default in tests). */
export const ME = {
  gcid: 9000111,
  realCid: 2001,
  demoCid: 3001,
  username: "tester",
  scopes: ["etoro-public:demo:read", "etoro-public:demo:write"],
};

/** The shape of eToro's eligibility answer: one long configuration per settlement type, plus a short CFD one. */
export function eligibilityFor(instrumentId: number, settlements: Array<"cfd" | "real">) {
  const config = (settlementType: string, direction: string, leverageValues: number[]) => ({ settlementType, direction, leverageValues, minPositionAmount: 10 });
  return {
    currency: "usd",
    eligibilities: [
      {
        instrumentId,
        allowOpenPosition: true,
        leverageConfigs: [
          ...settlements.map((s) => config(s, "long", s === "cfd" ? [1, 2, 5] : [1])),
          ...(settlements.includes("cfd") ? [config("cfd", "short", [1, 2, 5])] : []),
        ],
      },
    ],
    notFoundInstrumentIds: [],
    notFoundSymbols: [],
  };
}

/** Typical eToro answers for an order on instrument 1234 (CSPX.L). */
export function orderHandler(extra?: Handler): Handler {
  return (call) => {
    const custom = extra?.(call);
    if (custom) return custom;
    if (call.path === "/api/v1/me") return { json: ME };
    if (call.path === "/api/v1/trading/info/demo/aggregate-portfolio") return { json: { cid: ME.demoCid, accountTotals: {} } };
    if (call.path === "/api/v1/trading/info/aggregate-portfolio") return { status: 403, json: { title: "Forbidden" } };
    if (call.path === "/api/v2/market-data/instruments") {
      const symbols = call.query.symbols;
      if (symbols === "AMBIG") {
        return {
          json: {
            items: [
              { instrumentId: 1, symbol: "AMBIG", displayName: "A", type: "Stocks" },
              { instrumentId: 2, symbol: "AMBIG", displayName: "B", type: "ETF" },
            ],
          },
        };
      }
      return { json: { items: [{ instrumentId: 1234, symbol: "CSPX.L", displayName: "iShares Core S&P 500", type: "ETF", exchangeId: 5 }] } };
    }
    if (call.path === "/api/v1/market-data/instruments/rates") return { json: { rates: [{ instrumentID: 1234, ask: 846.35, bid: 846.1 }] } };
    if (call.path.endsWith("/eligibility")) return { json: eligibilityFor(1234, ["cfd"]) };
    if (call.path.endsWith("/costs")) return { json: { instrumentId: 1234, costs: [{ costType: "markup", amount: 0.15, currency: "USD" }] } };
    if (call.method === "POST" && call.path.endsWith("/orders")) return { json: { token: "t-1", orderId: 99, referenceId: "r-1" } };
    return undefined;
  };
}

export type ElicitMode = "accept" | "decline" | "none";

export async function connect(cfg: Config, handler: Handler, elicit: ElicitMode = "none") {
  const { fn, calls } = mockFetch(handler);
  const auditLines: string[] = [];
  const { mcp } = createServer(cfg, { fetchFn: fn, sleep: async () => {}, audit: (e) => auditLines.push(JSON.stringify(e)) });

  const client = new Client(
    { name: "test-client", version: "0.0.0" },
    { capabilities: elicit === "none" ? {} : { elicitation: {} } },
  );
  const prompts: string[] = [];
  if (elicit !== "none") {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(req.params.message);
      return elicit === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
  return { client, calls, auditLines, prompts, close: () => client.close() };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("\n");
}
