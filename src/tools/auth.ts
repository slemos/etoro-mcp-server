import { z } from "zod";
import { type ToolContext, fail, guarded, ok } from "./common.js";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Sign-in tools, registered only when the server uses OAuth. They cannot reach beyond what the user's own eToro
 * application is allowed to ask for: the scopes come from the configuration, never from the model, and the person still
 * has to press "authorise" on eToro's page.
 */
export function registerAuthTools({ mcp, cfg, signIn }: ToolContext): void {
  if (cfg.auth.mode !== "oauth" || !signIn) return;

  mcp.registerTool(
    "etoro_sign_in",
    {
      title: "Sign in to eToro",
      description:
        "Starts the eToro sign-in: opens eToro's permission page in the user's browser. The user decides there; this tool cannot approve anything and returns at once. " +
        "Afterwards run etoro_check_connection to see the result. Does nothing if the user is already signed in, unless force is true.",
      inputSchema: { force: z.boolean().default(false).describe("Sign in again even though a valid sign-in exists (for example after changing the permissions).") },
      annotations: { title: "Sign in to eToro", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded(async ({ force }) => {
      const before = signIn.status();
      if (before.signedIn && !force && before.missingScopes.length === 0) {
        return ok({ signedIn: true, started: false, scopes: before.scopes, accessExpiresAt: iso(before.accessExpiresAt), note: "Already signed in." });
      }
      const r = await signIn.begin();
      return ok({
        signedIn: before.signedIn,
        started: r.started,
        browserOpened: r.opened,
        requestedScopes: cfg.auth.mode === "oauth" ? cfg.auth.scopes : [],
        ...(cfg.showApprovalUrl || !r.opened ? { openThisAddress: r.url } : {}),
        next: r.opened
          ? "A page on eToro was opened in the browser. Ask the user to review the permissions and approve, then run etoro_check_connection."
          : "No browser could be opened. Ask the user to open the address in openThisAddress, approve, then run etoro_check_connection.",
      });
    }),
  );

  mcp.registerTool(
    "etoro_sign_out",
    {
      title: "Sign out of eToro",
      description: "Revokes this server's access at eToro and deletes the stored tokens. Afterwards every eToro tool fails until the user signs in again. Safe: it only removes access.",
      inputSchema: {},
      annotations: { title: "Sign out of eToro", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded(async () => {
      const r = await signIn.signOut();
      if (!r.wasSignedIn) return ok({ signedIn: false, note: "There was no sign-in to remove." });
      if (!r.revoked) return fail("The tokens were deleted from this computer, but eToro could not be reached to revoke them. Revoke the application's access in eToro to be sure.");
      return ok({ signedIn: false, revokedAtEtoro: true });
    }),
  );
}
