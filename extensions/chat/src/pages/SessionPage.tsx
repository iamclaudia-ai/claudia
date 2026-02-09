import { ClaudiaChat } from "@claudia/ui";
import { bridge } from "../app";

export function SessionPage({ sessionId }: { sessionId: string }) {
  return (
    <ClaudiaChat
      bridge={bridge}
      gatewayOptions={{ sessionId }}
    />
  );
}
