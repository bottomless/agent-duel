const ACTIVE_LOCAL_STATES = new Set(["running", "unresponsive"]);

function normalizeListen(value) {
  return typeof value === "string" ? value.trim() : "";
}

function daemonUrl(listen, pathname) {
  const normalized = normalizeListen(listen);
  if (!normalized || normalized.startsWith("/")) return null;
  if (/^\d+$/.test(normalized)) return `http://127.0.0.1:${normalized}${pathname}`;

  const separator = normalized.lastIndexOf(":");
  if (separator <= 0 || separator === normalized.length - 1) return null;

  let host = normalized.slice(0, separator);
  const port = normalized.slice(separator + 1);
  if (!/^\d+$/.test(port)) return null;
  if (host === "0.0.0.0" || host === "127.0.0.1") host = "localhost";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port}${pathname}`;
}

export async function fetchDaemonIdentity(listen, options = {}) {
  const url = daemonUrl(listen, "/api/status");
  if (!url) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1000;
  const password = options.password ?? process.env.PASEO_PASSWORD;
  try {
    const response = await fetchImpl(url, {
      headers: password ? { authorization: `Bearer ${password}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.serverId !== "string" ||
      payload.serverId.trim().length === 0
    ) {
      return null;
    }
    return {
      serverId: payload.serverId.trim(),
      listen: normalizeListen(payload.listen),
    };
  } catch {
    return null;
  }
}

// A daemon without a control plane answers that sign-in is disabled; any other answer, including
// an unreachable control plane, means it was not started for --byok.
async function fetchAccountsEnabled(listen, options = {}) {
  const url = daemonUrl(listen, "/api/auth/methods");
  if (!url) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1000),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return typeof payload?.enabled === "boolean" ? payload.enabled : null;
  } catch {
    return null;
  }
}

function planOwnedDaemon({ expectedServerId, configuredListen, explicitListen, pid, byokRefused }) {
  if (explicitListen && explicitListen !== configuredListen) {
    return {
      action: "refuse",
      expectedServerId,
      reason: `Paseo home already has daemon ${expectedServerId} at ${configuredListen}; refusing PASEO_LISTEN=${explicitListen}`,
    };
  }
  if (byokRefused) {
    return {
      action: "refuse",
      expectedServerId,
      reason: `Daemon ${expectedServerId} at ${configuredListen} was started with a control plane; stop it with "npm run cli -- daemon stop" before using --byok`,
    };
  }
  return {
    action: "reuse",
    expectedServerId,
    listen: configuredListen,
    pid,
  };
}

export function planDesktopDaemon(
  status,
  liveIdentity,
  requestedListen = "",
  { byok = false } = {},
) {
  const expectedServerId = typeof status?.serverId === "string" ? status.serverId.trim() : "";
  const configuredListen = normalizeListen(status?.listen);
  const explicitListen = normalizeListen(requestedListen);
  const pid = typeof status?.pid === "number" ? status.pid : null;
  const localState = typeof status?.localDaemon === "string" ? status.localDaemon : "stopped";

  if (!expectedServerId) {
    return {
      action: "refuse",
      expectedServerId,
      reason: "Desktop dev could not resolve the server ID for its Paseo home",
    };
  }

  const identityMatches = liveIdentity?.serverId === expectedServerId;
  if (identityMatches) {
    return planOwnedDaemon({
      expectedServerId,
      configuredListen,
      explicitListen,
      pid,
      byokRefused: byok && liveIdentity.accountsEnabled !== false,
    });
  }

  if (ACTIVE_LOCAL_STATES.has(localState) && pid !== null) {
    const liveDescription = liveIdentity
      ? `port ${configuredListen} belongs to ${liveIdentity.serverId}`
      : `no matching daemon answered at ${configuredListen}`;
    return {
      action: "refuse",
      expectedServerId,
      reason: `Local daemon PID ${pid} is still ${localState}, but ${liveDescription}; refusing to stop it or launch a duplicate`,
    };
  }

  return {
    action: "start",
    expectedServerId,
    requestedListen: explicitListen,
  };
}

export async function inspectDesktopDaemon(status, requestedListen = "", options = {}) {
  const byok = options.byok === true;
  let liveIdentity = await fetchDaemonIdentity(status?.listen, options);
  if (liveIdentity && byok) {
    const accountsEnabled = await fetchAccountsEnabled(status?.listen, options);
    liveIdentity = { ...liveIdentity, accountsEnabled };
  }
  return planDesktopDaemon(status, liveIdentity, requestedListen, { byok });
}

async function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    let status;
    try {
      status = JSON.parse(args[0]);
    } catch {
      status = {};
    }
    const plan = await inspectDesktopDaemon(status, args[1] ?? "", {
      byok: process.env.PASEO_DEV_BYOK === "1",
    });
    process.stdout.write(JSON.stringify(plan));
    return;
  }

  if (command === "verify") {
    const [listen, expectedServerId] = args;
    const identity = await fetchDaemonIdentity(listen);
    if (identity?.serverId !== expectedServerId) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown dev daemon command: ${command ?? "<missing>"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCli();
}
