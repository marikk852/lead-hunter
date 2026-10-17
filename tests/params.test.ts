/**
 * Regression coverage for a bug found by driving the real UI: a redirect reason
 * like "same author, 91% text overlap" crashed the lead page with
 * `URIError: URI malformed`, because the value was decoded twice.
 */
import { describe, expect, it } from "vitest";
import { readNumberParam, readParam } from "@/src/lib/params";

describe("readParam", () => {
  it("passes an already-decoded percent sign through untouched", () => {
    expect(readParam({ duplicate: "same author, 91% text overlap" }, "duplicate")).toBe(
      "same author, 91% text overlap",
    );
  });

  it("does not attempt another decoding pass", () => {
    // Would throw URIError if the value were decoded again.
    expect(() => readParam({ q: "100% legit %zz %" }, "q")).not.toThrow();
    expect(readParam({ q: "100% legit %zz %" }, "q")).toBe("100% legit %zz %");
  });

  it("keeps a literal plus sign", () => {
    expect(readParam({ q: "php + wordpress" }, "q")).toBe("php + wordpress");
  });

  it("treats blank, missing and array values as absent", () => {
    expect(readParam({}, "q")).toBeNull();
    expect(readParam({ q: "" }, "q")).toBeNull();
    expect(readParam({ q: "   " }, "q")).toBeNull();
    expect(readParam({ q: ["a", "b"] }, "q")).toBeNull();
  });
});

describe("readNumberParam", () => {
  it("parses numbers and rejects junk", () => {
    expect(readNumberParam({ minScore: "80" }, "minScore")).toBe(80);
    expect(readNumberParam({ minScore: "abc" }, "minScore")).toBeUndefined();
    expect(readNumberParam({}, "minScore")).toBeUndefined();
  });
});
