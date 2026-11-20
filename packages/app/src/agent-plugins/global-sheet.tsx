import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AgentPluginsReviewSheet, type AgentPluginsDecision } from "./review-sheet";
import type { AgentPluginsController } from "./use-agent-plugins";

const NO_NATIVE_SKILLS: readonly string[] = [];

/** The review sheet for the plugins that load in every project. */
export function GlobalPluginsSheet({
  controller,
  visible,
  onClose,
}: {
  controller: AgentPluginsController;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { status, save, isSaving } = controller;
  const handleSave = useCallback(
    (decision: AgentPluginsDecision) => save({ scope: { kind: "global" }, ...decision }),
    [save],
  );
  if (!status) return null;
  return (
    <AgentPluginsReviewSheet
      visible={visible}
      title={t("agentPlugins.sheet.globalTitle")}
      hint={t("agentPlugins.sheet.globalHint")}
      plugins={status.global.plugins}
      nativeSkills={NO_NATIVE_SKILLS}
      footnote={null}
      isSaving={isSaving}
      onSave={handleSave}
      onClose={onClose}
      testID="agent-plugins-global-sheet"
    />
  );
}
