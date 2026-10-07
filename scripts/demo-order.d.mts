export interface DemoOrderDeps {
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }>;
  confirm(question: string): Promise<boolean>;
  /** Presses Execute on the approval page at `url`; resolves the HTTP status of the answer. */
  approve(url: string): Promise<number>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}
export interface DemoOrderOptions {
  symbol: string;
  amountUsd?: number;
  side?: "buy" | "sellShort";
  settlementType?: "real" | "cfd";
  close?: boolean;
  yes?: boolean;
  pollAttempts?: number;
  pollMs?: number;
  statusAttempts?: number;
  statusPollMs?: number;
}
export interface DemoOrderResult {
  ok: boolean;
  stage: string;
  orderId?: number;
  positionId?: number;
}
export function runDemoOrder(deps: DemoOrderDeps, opts: DemoOrderOptions): Promise<DemoOrderResult>;
export interface DemoCloseOptions {
  positionId: number;
  yes?: boolean;
  pollAttempts?: number;
  pollMs?: number;
}
export function runDemoClose(deps: DemoOrderDeps, opts: DemoCloseOptions): Promise<DemoOrderResult>;
export function pressExecute(url: string, fetchFn?: typeof fetch): Promise<number>;
export function parseCli(argv: string[]): {
  value(name: string): string | undefined;
  flag(name: string, short?: string): boolean;
  yes: boolean;
};
