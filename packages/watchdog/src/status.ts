/**
 * Status aggregation — composes service + client health into a single status object.
 */

import { HEALTH_HISTORY_SIZE } from "./constants";
import { services, isProcessAlive, checkHealth } from "./services";
import { lastClientHealth } from "./client-health";

export async function getStatus(): Promise<Record<string, unknown>> {
  const status: Record<string, unknown> = {};

  for (const [id, service] of Object.entries(services)) {
    const processAlive = isProcessAlive(service);
    const healthy = processAlive ? await checkHealth(service) : false;
    status[id] = {
      name: service.name,
      pid: service.proc?.pid ?? null,
      processAlive,
      healthy,
      consecutiveFailures: service.consecutiveFailures,
      lastRestart: service.lastRestart ? new Date(service.lastRestart).toISOString() : null,
      history: service.history.slice(-HEALTH_HISTORY_SIZE),
    };
  }

  // Include client health in status
  if (lastClientHealth) {
    status.client = {
      name: "Web Client",
      healthy: lastClientHealth.healthy,
      recentErrors: lastClientHealth.recentErrors,
      lastHeartbeat: lastClientHealth.lastHeartbeat,
      heartbeatAge: lastClientHealth.heartbeatAge,
      errors: lastClientHealth.errors,
    };
  }

  return status;
}
