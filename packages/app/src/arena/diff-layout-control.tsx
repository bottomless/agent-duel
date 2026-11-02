import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  diffLayoutOptions,
  useArenaDiffLayout,
  useArenaDiffLayoutStore,
  type ArenaDiffLayout,
} from "./diff-layout";

/**
 * The one control over how a chat's diffs are laid out: A beside B, or one
 * column. The width picks until the reader does; the choice holds for the chat.
 */
export function DiffLayoutControl({ agentId, width }: { agentId: string; width: number | null }) {
  const { t } = useTranslation();
  const layout = useArenaDiffLayout(agentId, width);
  const setLayout = useArenaDiffLayoutStore((state) => state.setLayout);
  const onChange = useCallback(
    (next: ArenaDiffLayout) => setLayout(agentId, next),
    [agentId, setLayout],
  );
  return (
    <SegmentedControl
      options={diffLayoutOptions(t)}
      value={layout}
      onValueChange={onChange}
      size="xs"
      testID="arena-diff-layout"
    />
  );
}
