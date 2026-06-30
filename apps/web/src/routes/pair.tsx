// apps/web/src/routes/pair.tsx
// FILE: pair.tsx
// Purpose: Public route that redeems a pairing link, then enters the app.
// Layer: Route
// Exports: Route

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { pairRedeemFromLocation } from "./pairRedeem";

function PairView() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"pairing" | "error">("pairing");
  const [message, setMessage] = useState("Pairing this device…");

  useEffect(() => {
    let cancelled = false;
    void pairRedeemFromLocation(window.location.href).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        // Reload at the app root so the active host connection is built fresh.
        window.location.replace("/");
      } else {
        setStatus("error");
        setMessage(result.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="flex h-dvh items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-sm text-muted-foreground">{message}</p>
        {status === "error" ? (
          <a className="mt-4 inline-block text-sm underline" href="/">
            Go back
          </a>
        ) : null}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/pair")({
  component: PairView,
});
