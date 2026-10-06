import { Bot } from "lucide-react-native";
import { SvgXml } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { MODEL_VENDOR_ICON_SVGS } from "@/assets/model-vendor-icons";
import type { Theme } from "@/styles/theme";
import { arenaModelVendor } from "./model-vendor";

// The marks draw in `currentColor`, so the vendor's shape reads in either
// theme instead of a brand colour that only works on one of them.
const ThemedVendorMark = withUnistyles(SvgXml);
const ThemedBot = withUnistyles(Bot);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The mark of whoever made a revealed contestant's model.
 *
 * Falls back to a generic agent glyph rather than to nothing, so both sides of
 * a battle keep the same shape when only one of them is a vendor we ship a
 * mark for. `tone` follows the label the mark sits against — a mark brighter
 * than its own model name reads as the more important half of the pair.
 */
export function ArenaModelVendorIcon({
  model,
  size,
  tone = "default",
}: {
  model: string | undefined;
  size: number;
  tone?: "default" | "muted";
}) {
  const colorMapping = tone === "muted" ? mutedColorMapping : foregroundColorMapping;
  const vendor = arenaModelVendor(model);
  if (!vendor) return <ThemedBot size={size} uniProps={colorMapping} />;
  return (
    <ThemedVendorMark
      xml={MODEL_VENDOR_ICON_SVGS[vendor]}
      width={size}
      height={size}
      uniProps={colorMapping}
    />
  );
}
