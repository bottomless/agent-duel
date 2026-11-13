import type { SessionInfo, PermissionRuleset, ModelRef } from "@opencode/client";
import type { V2Api } from "./api.js";

import type {
  AgentFeature,
  AgentLaunchContext,
  AgentSessionConfig,
} from "../../../agent-sdk-types.js";

import { OpenCodeProviderOptionsSchema, buildOpenCodePermissionRules } from "../options.js";

import { modelRef } from "./mapping.js";

function isArenaModel(model: ModelRef) {
  return model.providerID === "arena" && ["medium", "contestant"].includes(model.id);
}

export function arenaModelRef(id?: string | null): ModelRef {
  const model = modelRef(id ?? "arena/medium");
  if (!isArenaModel(model)) throw new Error("Choose an Arena Medium or frontier model");
  return { ...model, variant: model.id === "medium" ? "xhigh" : "high" };
}

export function features(config: AgentSessionConfig): AgentFeature[] {
  return [
    {
      type: "toggle",
      id: "auto_accept",
      label: "Auto-accept",
      value: config.featureValues?.["auto_accept"] === true,
    },
  ];
}
export function permissionRules(config: AgentSessionConfig): PermissionRuleset {
  const rules =
    buildOpenCodePermissionRules(
      OpenCodeProviderOptionsSchema.parse(config.providerOptions ?? {}),
      undefined,
    ) ?? [];
  const grants: PermissionRuleset = (config.toolPolicy?.preapproved ?? []).map((grant) => ({
    action: `${grant.server.replace(/[^a-zA-Z0-9_-]/g, "_")}_${grant.tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
    resource: "*",
    effect: "allow",
  }));
  return [
    ...grants,
    ...rules.map((rule) => ({
      action: nativePermissionAction(rule.permission),
      resource: rule.pattern,
      effect: rule.action,
    })),
  ];
}
function nativePermissionAction(action: string): string {
  if (action === "bash") return "shell";
  if (action === "task") return "subagent";
  return action;
}
/**
 * The agent and model a resume could not apply because Arena refused them.
 *
 * The engine refuses an agent or model change to a chat whose battle is unresolved, since the
 * canonical session has to stay as it was until the winner is grafted. A chat migrated from
 * OpenCode 1.x can also store a value its session does not hold (1.x sessions carry no model).
 * Resume keeps the session's own value then, because the chat has to open so the user can vote.
 * The session applies what is left before its next agent, model, or prompt action, which comes
 * after the battle resolves.
 *
 * An Arena size chosen while a turn runs waits here too, because the running turn reads the session
 * model at each step and its assignment is for the size it started on. It applies when the turn ends.
 */
export interface DeferredSelection {
  agent?: string;
  model?: ModelRef;
}

async function appliedUnlessArenaRefused(arenaMode: boolean, apply: () => Promise<unknown>) {
  try {
    await apply();
    return true;
  } catch (error) {
    if (arenaMode && error instanceof Error && error.name === "ArenaRefusal") return false;
    throw error;
  }
}

/** Apply a selection to the session. Return the part Arena refused; other failures throw. */
export async function applySelection(
  client: V2Api,
  info: SessionInfo,
  selection: DeferredSelection,
  arenaMode: boolean,
  requestOptions?: { signal?: AbortSignal },
): Promise<DeferredSelection> {
  const deferred: DeferredSelection = {};
  const { agent, model } = selection;
  if (agent) {
    if (
      await appliedUnlessArenaRefused(arenaMode, () =>
        client.session.switchAgent({ sessionID: info.id, agent }, requestOptions),
      )
    )
      info.agent = agent;
    else deferred.agent = agent;
  }
  if (model) {
    if (
      await appliedUnlessArenaRefused(arenaMode, () =>
        client.session.switchModel({ sessionID: info.id, model }, requestOptions),
      )
    )
      info.model = model;
    else deferred.model = model;
  }
  return deferred;
}

export async function applyResumeOverrides(
  client: V2Api,
  info: SessionInfo,
  overrides?: Partial<AgentSessionConfig>,
  arenaMode = false,
): Promise<DeferredSelection> {
  // A chat saved before chats became Arena-only still stores the OpenRouter model it first ran on,
  // which Arena no longer offers. Keep the session's own model then, or give a session with none
  // the default size, because the chat has to open.
  if (arenaMode && overrides?.model && !isArenaModel(modelRef(overrides.model)))
    overrides = {
      ...overrides,
      model: info.model ? undefined : "arena/medium",
      thinkingOptionId: undefined,
    };
  let model: ModelRef | undefined;
  if (overrides?.model || overrides?.thinkingOptionId !== undefined) {
    model = info.model && { ...info.model, variant: overrides.thinkingOptionId };
    if (overrides.model)
      model = arenaMode
        ? arenaModelRef(overrides.model)
        : modelRef(overrides.model, overrides.thinkingOptionId ?? info.model?.variant);
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
  }
  return applySelection(client, info, { agent: overrides?.modeId, model }, arenaMode);
}

// Agent identity env is applied per session through `session.environment`, so
// it must not force a dedicated server. Custom MCP is location-scoped, and any
// other env key belongs to the process, so both need isolation. Mirrors the v1
// adapter's `requiresDedicatedOpenCodeServer`.
const V2_SESSION_ENV_KEYS = new Set(["PASEO_AGENT_ID", "PASEO_AGENT_CWD"]);

export function requiresDedicatedV2Server(
  config: AgentSessionConfig,
  launch?: AgentLaunchContext,
): boolean {
  if (Object.keys(config.mcpServers ?? {}).length > 0) return true;
  return Object.keys(launch?.env ?? {}).some((key) => !V2_SESSION_ENV_KEYS.has(key));
}
