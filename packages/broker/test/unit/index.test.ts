import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SPEC_VERSION } from "../../src/index.ts";

describe("broker placeholder", () => {
  it("names a draft spec version", () => {
    assert.match(SPEC_VERSION, /-draft$/);
  });
});
