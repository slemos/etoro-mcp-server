/**
 * The permission that lets the HTTP client call a write route.
 *
 * Only the proposal store mints one, and only while running an action the user has just executed on the
 * approval page. The client consumes it on the write call, so no tool can reach eToro's write routes
 * without a human having pressed Execute: a new write tool that forgets this step simply fails.
 * (test/approval.test.ts checks that nothing else in src/ mints a grant.)
 */
const issued = new WeakSet<object>();

export class ApprovalGrant {
  private constructor() {}

  static mint(): ApprovalGrant {
    const grant = new ApprovalGrant();
    issued.add(grant);
    return grant;
  }
}

/** True once per grant: a grant that was minted by the store and not used yet. */
export function consumeGrant(grant: unknown): boolean {
  if (grant instanceof ApprovalGrant && issued.has(grant)) {
    issued.delete(grant);
    return true;
  }
  return false;
}
