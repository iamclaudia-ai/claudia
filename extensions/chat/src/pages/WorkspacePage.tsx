import { SessionList } from "@claudia/ui";
import { navigate } from "@claudia/ui";
import { GATEWAY_URL } from "../app";

export function WorkspacePage({ workspaceId }: { workspaceId: string }) {
  return (
    <SessionList
      gatewayUrl={GATEWAY_URL}
      workspaceId={workspaceId}
      onSelectSession={(sessionId, wsId) => navigate(`/workspace/${wsId}/session/${sessionId}`)}
      onBack={() => navigate("/")}
    />
  );
}
