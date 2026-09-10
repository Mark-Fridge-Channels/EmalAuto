import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTemplate, shouldUsePrefilledCopy } from "../src/campaign/template-render.js";

describe("template-render", () => {
  it("replaces known vars and leaves unknown intact", () => {
    const out = renderTemplate("Hi {{First Name}} / {{Missing}}", {
      "First Name": "Alex",
    });
    assert.equal(out, "Hi Alex / {{Missing}}");
  });

  it("requires both subject and body for prefilled send", () => {
    assert.equal(shouldUsePrefilledCopy("s", "b"), true);
    assert.equal(shouldUsePrefilledCopy("s", ""), false);
    assert.equal(shouldUsePrefilledCopy("", "b"), false);
    assert.equal(shouldUsePrefilledCopy("  ", "b"), false);
  });
});
