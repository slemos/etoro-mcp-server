import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const json = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));

describe("version", () => {
  it("is consistent across package.json and manifest.json", () => {
    expect(json("package.json").version).toBe(VERSION);
    expect(json("manifest.json").version).toBe(VERSION);
  });
});
