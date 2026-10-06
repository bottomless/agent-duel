import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { environment } from "./preview"

/** Inject the aliases owned by this contestant directory into every shell. */
export async function ArenaPreviewPlugin(input: PluginInput): Promise<Hooks> {
  return {
    "shell.env": async (hookInput, output) => {
      Object.assign(output.env, environment(input.directory, process.env, hookInput.cwd))
    },
  }
}

export * as ArenaPreviewPluginModule from "./preview-plugin"
