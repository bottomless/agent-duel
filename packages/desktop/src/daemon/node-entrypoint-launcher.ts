const PASEO_NODE_ENV = "PASEO_NODE_ENV";

export interface NodeEntrypointSpec {
  entryPath: string;
  execArgv: string[];
}

export interface NodeEntrypointInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type NodeEntrypointArgvMode = "bare" | "node-script";

interface CreateNodeEntrypointInvocationInput {
  execPath: string;
  isPackaged: boolean;
  packagedRunnerPath: string | null;
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}

/**
 * The AppImage's AppRun prepends `$APPDIR/usr/lib` to LD_LIBRARY_PATH for Electron's tray and
 * notification libraries. Electron-as-Node needs none of them, and everything the daemon starts
 * (supervisor, terminals, contestants' commands) would load them too. Empty entries mean the
 * current directory, so they go as well.
 */
function withoutAppImageLibraries(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const appDir = env.APPDIR;
  if (!appDir || env.LD_LIBRARY_PATH === undefined) return env;
  const kept = env.LD_LIBRARY_PATH.split(":").filter(
    (entry) => entry !== "" && entry !== appDir && !entry.startsWith(`${appDir}/`),
  );
  const { LD_LIBRARY_PATH: _dropped, ...rest } = env;
  return kept.length > 0 ? { ...rest, LD_LIBRARY_PATH: kept.join(":") } : rest;
}

export function createElectronNodeEnv(
  baseEnv: NodeJS.ProcessEnv,
  options?: { isPackaged?: boolean },
): NodeJS.ProcessEnv {
  return {
    ...withoutAppImageLibraries(baseEnv),
    ELECTRON_RUN_AS_NODE: "1",
    [PASEO_NODE_ENV]: options?.isPackaged === true ? "production" : "development",
  };
}

export function createNodeEntrypointInvocation(
  input: CreateNodeEntrypointInvocationInput,
): NodeEntrypointInvocation {
  const env = createElectronNodeEnv(input.baseEnv, { isPackaged: input.isPackaged });

  if (input.isPackaged) {
    if (!input.packagedRunnerPath) {
      throw new Error("Packaged node entrypoint runner is required for desktop launches.");
    }

    return {
      command: input.execPath,
      args: [
        "--disable-warning=DEP0040",
        input.packagedRunnerPath,
        input.argvMode,
        input.entrypoint.entryPath,
        ...input.args,
      ],
      env,
    };
  }

  return {
    command: input.execPath,
    args: [...input.entrypoint.execArgv, input.entrypoint.entryPath, ...input.args],
    env,
  };
}
