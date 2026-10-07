import { describe, expect, it } from "vitest";
import { scanText } from "../scripts/privacy-check.mjs";

// The sample values are assembled at run time so that this file itself passes the check it tests.
const at = "@";
const realLooking = ["4", "5", "6", "7", "8", "9", "1", "2", "3"].join("");

describe("privacy check", () => {
  it("flags e-mail addresses except no-reply and example ones", () => {
    expect(scanText(`write to someone${at}mail.test`)).toHaveLength(1);
    expect(scanText(`1+name${at}users.noreply.github.com`)).toHaveLength(0);
    expect(scanText(`noreply${at}anthropic.com and user${at}evil.example and a${at}example.com`)).toHaveLength(0);
  });

  it("flags long numbers that look like real ids, not made-up looking ones", () => {
    expect(scanText(`order ${realLooking}`)).toEqual([{ line: 1, rule: expect.stringContaining("long number"), match: realLooking }]);
    expect(scanText("000000000000 111111111111 123456789 9876543210 100000000")).toHaveLength(0);
    expect(scanText("short 12345678 and 1234.56789012345")).toHaveLength(0);
  });

  it("ignores UUIDs and commit hashes, and accepts numbers a person declared invented", () => {
    expect(scanText("id 3f2c1a9e-5b7d-4e1f-8a6c-123456789012 and 0123456789abcdef0123456789abcdef01234567")).toHaveLength(0);
    expect(scanText(`order ${realLooking}`, { allow: new Set([realLooking]) })).toHaveLength(0);
  });

  it("applies a local denylist case-insensitively without echoing it back", () => {
    const found = scanText("Some Secret Name was here", { deny: ["secret name"] });
    expect(found).toHaveLength(1);
    expect(JSON.stringify(found)).not.toContain("Secret Name");
    expect(scanText("nothing here", { deny: ["secret name"] })).toHaveLength(0);
  });

  it("reports the line number", () => {
    expect(scanText(`fine\nalso fine\nbad ${realLooking}`)[0]).toMatchObject({ line: 3 });
  });
});
