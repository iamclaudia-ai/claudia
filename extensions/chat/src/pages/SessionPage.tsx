import { ClaudiaChat, navigate } from "@claudia/ui";
import { bridge } from "../app";

export function SessionPage({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  return (
    <ClaudiaChat
      bridge={bridge}
      gatewayOptions={{ sessionId, workspaceId }}
      onBack={() => navigate(`/workspace/${workspaceId}`)}
    />
  );
}
