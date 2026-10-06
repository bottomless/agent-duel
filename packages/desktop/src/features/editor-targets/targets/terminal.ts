import type { EditorTarget } from "../target.js";

export const terminalTarget: EditorTarget = {
  id: "terminal",
  async describe() {
    return {
      id: this.id,
      label: "Terminal",
      kind: "terminal",
      icon: { kind: "symbol", name: "terminal" },
    };
  },
  async isInstalled(runtime) {
    return runtime.platform === "darwin" && runtime.hasMacApplication("Terminal");
  },
  async launch(input, runtime) {
    if (runtime.platform !== "darwin" || !runtime.hasMacApplication("Terminal")) {
      throw new Error("Terminal is unavailable");
    }
    await runtime.openMacApplication({
      applicationName: "Terminal",
      paths: [input.workspacePath],
    });
  },
};
