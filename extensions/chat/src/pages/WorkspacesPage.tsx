import { WorkspaceList } from "@claudia/ui";
import { navigate } from "@claudia/ui";
import { GATEWAY_URL } from "../app";

export function WorkspacesPage() {
  return (
    <WorkspaceList
      gatewayUrl={GATEWAY_URL}
      onSelectWorkspace={(id) => navigate(`/workspace/${id}`)}
      onSessionReady={(id) => navigate(`/session/${id}`)}
    />
  );
}
