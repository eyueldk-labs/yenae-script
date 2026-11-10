import { describe, expect, test } from "bun:test";
import { coerceParams, defineScript, text, number, boolean, select } from "yenae-script";
import { insideWorkspace, parseEvery } from "../src/paths";

describe("parseEvery", () => {
  test("reads common intervals", () => {
    expect(parseEvery("30s")).toBe(30_000);
    expect(parseEvery("10m")).toBe(600_000);
    expect(parseEvery("10")).toBe(600_000);
    expect(parseEvery("2h")).toBe(7_200_000);
    expect(parseEvery("1d")).toBe(86_400_000);
  });
  test("rejects nonsense and tiny intervals", () => {
    expect(() => parseEvery("soon")).toThrow();
    expect(() => parseEvery("5s")).toThrow();
  });
});

test("insideWorkspace refuses escapes", () => {
  expect(insideWorkspace("/ws", "a/b.ts")).toBe("/ws/a/b.ts");
  expect(() => insideWorkspace("/ws", "../etc/passwd")).toThrow();
});

describe("params", () => {
  const s = defineScript({
    name: "t",
    params: { a: text(), n: number().default(3), b: boolean(), c: select(["x", "y"]).default("y"), o: text().optional() },
    run: () => {},
  });
  test("metadata is plain data", () => {
    expect(JSON.parse(JSON.stringify(s.meta.params)).n).toEqual({ kind: "number", default: 3 });
  });
  test("coerce fills defaults and converts types", () => {
    expect(coerceParams(s.meta.params, { a: "hi", n: "7", b: "true" })).toEqual({ a: "hi", n: 7, b: true, c: "y" });
  });
  test("coerce reports missing required values", () => {
    expect(() => coerceParams(s.meta.params, {})).toThrow(/Missing value for "a"/);
  });
});
