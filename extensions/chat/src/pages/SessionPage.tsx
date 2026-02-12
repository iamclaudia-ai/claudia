import { ClaudiaChat, navigate } from "@claudia/ui";
import { bridge } from "../app";

export function SessionPage({ sessionId }: { sessionId: string }) {
  return (
    <ClaudiaChat
      bridge={bridge}
      gatewayOptions={{ sessionId }}
      onBack={() => navigate("/")}
    />
  );
}
