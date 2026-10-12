// P3-20a — every registry key resolves to a provider that answers to
// that id, and an unregistered id is refused by name. No database.

import { describe, expect, it } from "vitest";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import { EXECUTION_PROVIDER_IDS, UnknownExecutionProviderError, executionProvider } from "./index";

describe("P3-20a — provider resolution", () => {
  it("THE BUILD GATE: every registered provider id resolves, and the provider owns that id", () => {
    expect([...EXECUTION_PROVIDER_IDS].sort()).toEqual(
      Object.keys(EXECUTION_SCOPE_REGISTRY).sort(),
    );
    for (const id of EXECUTION_PROVIDER_IDS) {
      const provider = executionProvider(id);
      expect(provider.id).toBe(id);
      expect(typeof provider.captureUndo).toBe("function");
      expect(typeof provider.execute).toBe("function");
      expect(typeof provider.undo).toBe("function");
    }
  });

  it("an unregistered id is refused by name, never mapped to a fallback", () => {
    expect(() => executionProvider("meta")).toThrow(UnknownExecutionProviderError);
    expect(() => executionProvider("meta")).toThrow(
      '"meta" is not a registered execution provider',
    );
    expect(() => executionProvider("")).toThrow(UnknownExecutionProviderError);
  });
});
