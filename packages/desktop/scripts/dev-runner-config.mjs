export function createElectronSpawnOptions({ env, colorEnv, expoDevUrl }) {
  return {
    // Electron must stay in the runner's process group. Agent Duel workspace scripts
    // own the terminal process group, so detaching Electron lets it survive a
    // service stop with broken stdout/stderr pipes and block the next launch.
    detached: false,
    env: {
      ...env,
      ...colorEnv,
      EXPO_DEV_URL: expoDevUrl,
    },
  };
}

export function findElectronPage(targets, expoDevUrl) {
  return Array.isArray(targets)
    ? targets.find(
        (target) =>
          target &&
          typeof target === "object" &&
          target.type === "page" &&
          typeof target.url === "string" &&
          target.url.startsWith(expoDevUrl),
      )
    : undefined;
}

export function hasElectronPage(targets, expoDevUrl) {
  return Boolean(findElectronPage(targets, expoDevUrl));
}

export function resolveChildKillTarget(pid, detached) {
  return detached ? -pid : pid;
}

export function shouldStopDevDaemonOnSignal(env) {
  return env.PASEO_DEV_OWNS_DAEMON === "1" && Boolean(env.PASEO_HOME?.trim());
}

export function registerDevRunnerShutdownSignals({ signalSource, stop }) {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    signalSource.on(signal, () => stop("SIGTERM"));
  }
}
