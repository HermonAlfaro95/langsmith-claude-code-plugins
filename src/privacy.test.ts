import { describe, expect, it } from "vitest";
import { runConfigForMode } from "./privacy.js";

describe("runConfigForMode replicas", () => {
  const replica = {
    apiUrl: "https://replica.example.com",
    apiKey: "key",
    projectName: "replica",
    updates: { metadata: { environment: "secret" }, inputs: { secret: true } },
  };

  it("drops replica updates when muted", () => {
    const config = runConfigForMode(
      { replicas: [replica, ["tuple-project", { inputs: { secret: true } }]] },
      "metadata",
    );
    expect(config.replicas).toEqual([
      { apiUrl: "https://replica.example.com", apiKey: "key", projectName: "replica" },
      { projectName: "tuple-project" },
    ]);
  });
});
