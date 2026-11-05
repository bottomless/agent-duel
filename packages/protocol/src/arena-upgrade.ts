export interface ArenaDatabaseUpgrade {
  /** Engine spawn time and its absolute startup deadline, in Unix milliseconds. */
  startedAt: number;
  deadline: number;
  /** Import continues after readiness; this state does not extend request deadlines. */
  backgroundImport?: true;
}

export function waitsForArenaEngine(type: string): boolean {
  return (
    (type.startsWith("arena.") &&
      !type.startsWith("arena.byok.") &&
      !type.startsWith("arena.environments.") &&
      type !== "arena.stream.ack.request" &&
      type !== "arena.stream.unsubscribe.request") ||
    [
      "create_agent_request",
      "fetch_agent_request",
      "fetch_agent_timeline_request",
      "resume_agent_request",
      "send_agent_message_request",
      "refresh_agent_request",
      "get_providers_snapshot_request",
      "refresh_providers_snapshot_request",
      "list_provider_models_request",
      "list_provider_modes_request",
      "list_provider_features_request",
      "fetch_recent_provider_sessions_request",
      "list_commands_request",
      "clear_agent_attention",
      "agent.timeline.search.request",
      "agent.timeline.list_prompts.request",
      "agent.timeline.get_image.request",
    ].includes(type)
  );
}

/** Extend a caller's existing budget only for an observed database upgrade. */
export function arenaUpgradeTimeout(options: {
  timeoutMs: number;
  getUpgrade: () => ArenaDatabaseUpgrade | null;
  subscribe: (listener: () => void) => () => void;
  onTimeout: () => void;
}): () => void {
  let deadline = Date.now() + options.timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const upgrade = options.getUpgrade();
    // Keep the caller's ordinary budget after engine readiness (e.g. session.create).
    if (upgrade && !upgrade.backgroundImport)
      deadline = Math.max(deadline, upgrade.deadline + options.timeoutMs);
    clearTimeout(timer);
    timer = setTimeout(options.onTimeout, Math.max(0, deadline - Date.now()));
  };
  const unsubscribe = options.subscribe(arm);
  arm();
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
