/**
 * Network tripwire for scripts/security-check.mjs, loaded with `node --import`.
 *
 * It replaces fetch so the server under test can never reach the network. Every attempted request is
 * appended to the file named by SECURITY_CHECK_FETCH_LOG (method, URL after normalisation, the key
 * headers it carried), then fails with an error that deliberately contains the request headers: that
 * is the worst case for secret leakage, and the checks assert the server still redacts it.
 */
import { appendFileSync } from "node:fs";

const logFile = process.env.SECURITY_CHECK_FETCH_LOG;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = init.headers ?? {};
  if (logFile) {
    const entry = { method: init.method ?? "GET", url: url.href, path: url.pathname, apiKey: headers["x-api-key"], userKey: headers["x-user-key"] };
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  }
  throw new Error(`tripwire: network is blocked in security checks (${url.href}) headers=${JSON.stringify(headers)}`);
};
