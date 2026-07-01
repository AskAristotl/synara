import { describe, expect, it } from "vitest";

import { mapTransportStateToHostStatus } from "./hostConnectionStatus";

describe("mapTransportStateToHostStatus", () => {
  it("maps open -> connected", () => {
    expect(mapTransportStateToHostStatus("open")).toBe("connected");
  });
  it("maps connecting -> connecting", () => {
    expect(mapTransportStateToHostStatus("connecting")).toBe("connecting");
  });
  it("maps closed/disposed -> unreachable", () => {
    expect(mapTransportStateToHostStatus("closed")).toBe("unreachable");
    expect(mapTransportStateToHostStatus("disposed")).toBe("unreachable");
  });
});
