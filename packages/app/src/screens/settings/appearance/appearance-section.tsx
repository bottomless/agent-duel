import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, TextInput, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Monitor, Moon, Sun } from "lucide-react-native";
import {
  SYNTAX_THEME_OPTIONS,
  type SyntaxThemeId,
  type SyntaxThemeOption,
} from "@getpaseo/highlight";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { toErrorMessage } from "@/utils/error-messages";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import {
  MAX_CODE_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  sanitizeFontFamily,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import {
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  ICON_SIZE,
  THEME_OPTIONS,
  THEME_SWATCHES,
  type Theme,
} from "@/styles/theme";
import { isNative } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { matchesSettingsSearch } from "../settings-search";
import { AppearancePreview } from "./appearance-preview";

// ---------------------------------------------------------------------------
// Theme-reactive leaf icons (withUnistyles + uniProps color mapping — no
// useUnistyles). Icon sizes read the static ICON_SIZE token; the appearance
// feature does not scale icons.
// ---------------------------------------------------------------------------

const ThemedSun = withUnistyles(Sun);
const ThemedMoon = withUnistyles(Moon);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function getThemeLabel(t: TFunction, value: AppSettings["theme"]): string {
  return t(`settings.appearance.theme.options.${value}`);
}

// Platform default stacks can be the bare native tokens ("normal"/"monospace");
// those read as a bug, so show a human label in the placeholder instead.
const BARE_DEFAULT_STACKS: ReadonlySet<string> = new Set(["normal", "monospace"]);

function resolveDefaultStackPlaceholder(t: TFunction, stack: string): string {
  return BARE_DEFAULT_STACKS.has(stack) ? t("settings.appearance.fonts.systemDefault") : stack;
}

// Local size string (digits only) -> preview override number. Empty/invalid
// yields undefined so the preview falls back to the committed theme value.
function sizeDraftToOverride(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const parsed = Number(value);
  return /^\d+$/.test(value) && parsed >= MIN_CODE_FONT_SIZE && parsed <= MAX_CODE_FONT_SIZE
    ? parsed
    : undefined;
}

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

// ---------------------------------------------------------------------------
// Theme picker
// ---------------------------------------------------------------------------

interface ThemeLeadingProps {
  themeValue: AppSettings["theme"];
}

function ThemeLeading({ themeValue }: ThemeLeadingProps) {
  switch (themeValue) {
    case "light":
      return <ThemedSun size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    case "dark":
      return <ThemedMoon size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    case "auto":
      return <ThemedMonitor size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    default:
      return <ThemeSwatch color={THEME_SWATCHES[themeValue]} />;
  }
}

interface ThemeSwatchProps {
  color: string;
}

function ThemeSwatch({ color }: ThemeSwatchProps) {
  const swatchStyle = useMemo(() => [styles.swatch, { backgroundColor: color }], [color]);
  return <View style={swatchStyle} />;
}

interface ThemeMenuItemProps {
  themeValue: AppSettings["theme"];
  selected: boolean;
  onChange: (theme: AppSettings["theme"]) => void;
}

function ThemeMenuItem({ themeValue, selected, onChange }: ThemeMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(themeValue);
  }, [onChange, themeValue]);
  const leading = useMemo(() => <ThemeLeading themeValue={themeValue} />, [themeValue]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {getThemeLabel(t, themeValue)}
    </DropdownMenuItem>
  );
}

interface ThemeRowProps {
  value: AppSettings["theme"];
  onChange: (theme: AppSettings["theme"]) => void;
}

function ThemeRow({ value, onChange }: ThemeRowProps) {
  const { t } = useTranslation();
  const selectedLabel = getThemeLabel(t, value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.theme.title")}</Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.theme.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          <ThemeLeading themeValue={value} />
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {THEME_OPTIONS.map((option, index) => {
            const previousOption = THEME_OPTIONS[index - 1];
            return (
              <Fragment key={option.name}>
                {previousOption && previousOption.group !== option.group ? (
                  <DropdownMenuSeparator />
                ) : null}
                <ThemeMenuItem
                  themeValue={option.name}
                  selected={value === option.name}
                  onChange={onChange}
                />
              </Fragment>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface SidePanelPlacementRowProps {
  value: AppSettings["sidePanelPlacement"];
  onChange: (placement: AppSettings["sidePanelPlacement"]) => void;
}

/**
 * The same choice the panel's own "+" menu offers. It is repeated here because an empty side
 * panel draws no tab row, and the reader should not have to open something first to move it.
 */
function SidePanelPlacementRow({ value, onChange }: SidePanelPlacementRowProps) {
  const { t } = useTranslation();
  const selectedLabel = t(`settings.appearance.sidePanel.options.${value}`);
  const dockRight = useCallback(() => onChange("right"), [onChange]);
  const dockBottom = useCallback(() => onChange("bottom"), [onChange]);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.sidePanel.placement")}</Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.sidePanel.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          <DropdownMenuItem selected={value === "right"} showSelectedCheck onSelect={dockRight}>
            {t("settings.appearance.sidePanel.options.right")}
          </DropdownMenuItem>
          <DropdownMenuItem selected={value === "bottom"} showSelectedCheck onSelect={dockBottom}>
            {t("settings.appearance.sidePanel.options.bottom")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface AutoExpandReasoningRowProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

function AutoExpandReasoningRow({ value, onChange }: AutoExpandReasoningRowProps) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.general.autoExpandReasoning.label")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.general.autoExpandReasoning.description")}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={t("settings.general.autoExpandReasoning.label")}
      />
    </View>
  );
}

interface ChatOutlineRowProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

function ChatOutlineRow({ value, onChange }: ChatOutlineRowProps) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.chatOutline.title")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.chatOutline.description")}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={t("settings.appearance.chatOutline.title")}
      />
    </View>
  );
}

const TOOL_CALL_DETAIL_LEVELS: readonly AppSettings["toolCallDetailLevel"][] = [
  "detailed",
  "overview",
];

function getToolCallDetailLevelLabel(
  t: TFunction,
  value: AppSettings["toolCallDetailLevel"],
): string {
  return t(`settings.general.toolCallDetail.options.${value}`);
}

interface ToolCallDetailMenuItemProps {
  value: AppSettings["toolCallDetailLevel"];
  selected: boolean;
  onChange: (value: AppSettings["toolCallDetailLevel"]) => void;
}

function ToolCallDetailMenuItem({ value, selected, onChange }: ToolCallDetailMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {getToolCallDetailLevelLabel(t, value)}
    </DropdownMenuItem>
  );
}

interface ToolCallDetailRowProps {
  value: AppSettings["toolCallDetailLevel"];
  onChange: (value: AppSettings["toolCallDetailLevel"]) => void;
}

function ToolCallDetailRow({ value, onChange }: ToolCallDetailRowProps) {
  const { t } = useTranslation();
  const selectedLabel = getToolCallDetailLevelLabel(t, value);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.general.toolCallDetail.label")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.general.toolCallDetail.description")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.general.toolCallDetail.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {TOOL_CALL_DETAIL_LEVELS.map((option) => (
            <ToolCallDetailMenuItem
              key={option}
              value={option}
              selected={value === option}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fonts: family text fields + numeric size fields (commit on blur/submit)
// ---------------------------------------------------------------------------

const UI_FONT_PRESETS = [
  { label: "System default", value: "" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
];
const CODE_FONT_PRESETS = [
  { label: "System monospace", value: "" },
  { label: "Menlo", value: "Menlo, monospace" },
  { label: "Courier New", value: '"Courier New", monospace' },
];
function FontPresetItem({
  label,
  value,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {label}
    </DropdownMenuItem>
  );
}

interface FontFamilyRowProps {
  kind: "interface" | "code";
  title: string;
  hint: string;
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  draft: string;
  withBorder: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: (value: string) => void;
}

function FontFamilyRow({
  kind,
  title,
  hint,
  accessibilityLabel,
  placeholder,
  value,
  draft,
  withBorder,
  onChangeDraft,
  onCommit,
}: FontFamilyRowProps) {
  const presets = kind === "code" ? CODE_FONT_PRESETS : UI_FONT_PRESETS;
  const preset = presets.find((option) => option.value === value);
  const [custom, setCustom] = useState(!preset);
  const showCustom = useCallback(() => setCustom(true), []);
  const selectPreset = useCallback(
    (font: string) => {
      setCustom(false);
      onCommit(font);
    },
    [onCommit],
  );
  const handleCommit = useCallback(() => {
    onCommit(draft);
  }, [draft, onCommit]);

  // Resync from the committed value when it changes elsewhere.
  useEffect(() => {
    onChangeDraft(value);
    // Only resync on external value changes, not on local keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <View style={styles.fontPicker}>
        <DropdownMenu>
          <DropdownMenuTrigger style={dropdownTriggerStyle} accessibilityLabel={accessibilityLabel}>
            <Text style={styles.triggerText}>
              {custom ? "Custom font" : (preset?.label ?? "Custom font")}
            </Text>
            <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" width={220}>
            {presets.map((option) => (
              <FontPresetItem
                key={option.label}
                {...option}
                selected={value === option.value && !custom}
                onSelect={selectPreset}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={showCustom}>Custom font…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {custom ? (
          <>
            <TextInput
              value={draft}
              onChangeText={onChangeDraft}
              onBlur={handleCommit}
              onSubmitEditing={handleCommit}
              blurOnSubmit={false}
              placeholder={placeholder}
              placeholderTextColor={styles.placeholderColor.color}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.fontFamilyInput}
              accessibilityLabel={accessibilityLabel}
            />
            <Text style={settingsStyles.rowHint}>
              Enter an installed font family or CSS font stack
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

interface FontSizeRowProps {
  title: string;
  accessibilityLabel: string;
  draft: string;
  error: string | null;
  min: number;
  max: number;
  withBorder?: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: () => void;
}

function FontSizeRow({
  title,
  accessibilityLabel,
  draft,
  error,
  min,
  max,
  withBorder = true,
  onChangeDraft,
  onCommit,
}: FontSizeRowProps) {
  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text
          style={error ? styles.fieldError : settingsStyles.rowHint}
          accessibilityLiveRegion="polite"
        >
          {error ?? `${min}–${max} px`}
        </Text>
      </View>
      <View style={styles.sizeField}>
        <TextInput
          value={draft}
          onChangeText={onChangeDraft}
          onBlur={onCommit}
          onSubmitEditing={onCommit}
          blurOnSubmit={false}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.sizeInput}
          accessibilityLabel={accessibilityLabel}
          aria-invalid={Boolean(error)}
        />
        <Text style={styles.unit}>px</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Syntax highlight theme picker (commits immediately)
// ---------------------------------------------------------------------------

function syntaxLabelForId(id: SyntaxThemeId): string {
  const option = SYNTAX_THEME_OPTIONS.find((entry) => entry.id === id);
  return option ? option.label : id;
}

interface SyntaxMenuItemProps {
  option: SyntaxThemeOption;
  selected: boolean;
  onChange: (id: SyntaxThemeId) => void;
}

function SyntaxMenuItem({ option, selected, onChange }: SyntaxMenuItemProps) {
  const handleSelect = useCallback(() => {
    onChange(option.id);
  }, [onChange, option.id]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

interface SyntaxRowProps {
  value: SyntaxThemeId;
  onChange: (id: SyntaxThemeId) => void;
}

function SyntaxRow({ value, onChange }: SyntaxRowProps) {
  const { t } = useTranslation();
  const selectedLabel = syntaxLabelForId(value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.syntax.highlightTheme")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.syntax.highlightThemeHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.syntax.highlightThemeAccessibility", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {SYNTAX_THEME_OPTIONS.map((option) => (
            <SyntaxMenuItem
              key={option.id}
              option={option}
              selected={value === option.id}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AppearanceSection({ search: inputSearch = "" }: { search?: string }) {
  const { t } = useTranslation();
  const search = matchesSettingsSearch(inputSearch, t("settings.sections.appearance"))
    ? ""
    : inputSearch;
  const { settings, updateSettings: persistSettings } = useAppSettings();
  const [saveFailure, setSaveFailure] = useState<{
    patch: Partial<AppSettings>;
    message: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSaving(true);
      setSaveFailure(null);
      try {
        await persistSettings(patch);
      } catch (error) {
        setSaveFailure({ patch, message: toErrorMessage(error) });
      } finally {
        setSaving(false);
      }
    },
    [persistSettings],
  );
  const retrySave = useCallback(() => {
    if (saveFailure) void updateSettings(saveFailure.patch);
  }, [saveFailure, updateSettings]);
  const [uiSizeError, setUiSizeError] = useState<string | null>(null);
  const [codeSizeError, setCodeSizeError] = useState<string | null>(null);
  const showFontFamilyRows = !isNative;
  const uiFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_UI_FONT_STACK);
  const monoFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_MONO_FONT_STACK);

  const [uiFontDraft, setUiFontDraft] = useState(settings.uiFontFamily);
  const [monoFontDraft, setMonoFontDraft] = useState(settings.monoFontFamily);
  const [uiSizeDraft, setUiSizeDraft] = useState(String(settings.uiFontSize));
  const [codeSizeDraft, setCodeSizeDraft] = useState(String(settings.codeFontSize));

  // Resync numeric drafts when the committed value changes elsewhere.
  useEffect(() => {
    setUiSizeDraft(String(settings.uiFontSize));
  }, [settings.uiFontSize]);
  useEffect(() => {
    setCodeSizeDraft(String(settings.codeFontSize));
  }, [settings.codeFontSize]);

  const handleThemeChange = useCallback(
    (theme: AppSettings["theme"]) => {
      void updateSettings({ theme });
    },
    [updateSettings],
  );

  const handleSidePanelPlacementChange = useCallback(
    (sidePanelPlacement: AppSettings["sidePanelPlacement"]) => {
      void updateSettings({ sidePanelPlacement });
    },
    [updateSettings],
  );

  const handleSyntaxThemeChange = useCallback(
    (syntaxTheme: SyntaxThemeId) => {
      void updateSettings({ syntaxTheme });
    },
    [updateSettings],
  );

  const handleAutoExpandReasoningChange = useCallback(
    (autoExpandReasoning: boolean) => {
      void updateSettings({ autoExpandReasoning });
    },
    [updateSettings],
  );

  const handleToolCallDetailLevelChange = useCallback(
    (toolCallDetailLevel: AppSettings["toolCallDetailLevel"]) => {
      void updateSettings({ toolCallDetailLevel });
    },
    [updateSettings],
  );

  const handleChatOutlineChange = useCallback(
    (chatOutlineEnabled: boolean) => {
      void updateSettings({ chatOutlineEnabled });
    },
    [updateSettings],
  );

  const commitUiFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setUiFontDraft(settings.uiFontFamily);
        return;
      }
      setUiFontDraft(sanitized);
      if (sanitized !== settings.uiFontFamily) {
        void updateSettings({ uiFontFamily: sanitized });
      }
    },
    [settings.uiFontFamily, updateSettings],
  );

  const commitMonoFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setMonoFontDraft(settings.monoFontFamily);
        return;
      }
      setMonoFontDraft(sanitized);
      if (sanitized !== settings.monoFontFamily) {
        void updateSettings({ monoFontFamily: sanitized });
      }
    },
    [settings.monoFontFamily, updateSettings],
  );

  const handleUiSizeChange = useCallback((value: string) => {
    setUiSizeDraft(value);
  }, []);

  const handleCodeSizeChange = useCallback((value: string) => {
    setCodeSizeDraft(value);
  }, []);

  const commitUiSize = useCallback(() => {
    const next = Number(uiSizeDraft);
    if (
      !/^\d+$/.test(uiSizeDraft) ||
      !Number.isInteger(next) ||
      next < MIN_UI_FONT_SIZE ||
      next > MAX_UI_FONT_SIZE
    ) {
      setUiSizeError(`Enter a whole number from ${MIN_UI_FONT_SIZE} to ${MAX_UI_FONT_SIZE} px`);
      return;
    }
    setUiSizeError(null);
    if (next !== settings.uiFontSize) void updateSettings({ uiFontSize: next });
  }, [settings.uiFontSize, uiSizeDraft, updateSettings]);

  const commitCodeSize = useCallback(() => {
    const next = Number(codeSizeDraft);
    if (
      !/^\d+$/.test(codeSizeDraft) ||
      !Number.isInteger(next) ||
      next < MIN_CODE_FONT_SIZE ||
      next > MAX_CODE_FONT_SIZE
    ) {
      setCodeSizeError(
        `Enter a whole number from ${MIN_CODE_FONT_SIZE} to ${MAX_CODE_FONT_SIZE} px`,
      );
      return;
    }
    setCodeSizeError(null);
    if (next !== settings.codeFontSize) void updateSettings({ codeFontSize: next });
  }, [codeSizeDraft, settings.codeFontSize, updateSettings]);

  // Live-while-typing: the in-progress drafts drive the preview without
  // committing to the global theme. Empty/invalid fields fall back to the
  // theme value inside the preview.
  const previewOverrides = useMemo(
    () => ({
      monoFontFamily: monoFontDraft,
      codeFontSize: sizeDraftToOverride(codeSizeDraft),
    }),
    [codeSizeDraft, monoFontDraft],
  );

  return (
    <View>
      {saveFailure ? (
        <View style={styles.saveError} accessibilityRole="alert">
          <Alert
            variant="error"
            title="Appearance change was not saved"
            description={saveFailure.message}
          />
          <Button size="sm" variant="outline" loading={saving} onPress={retrySave}>
            Retry save
          </Button>
        </View>
      ) : null}
      {matchesSettingsSearch(search, t("settings.appearance.theme", { returnObjects: true })) ? (
        <SettingsSection title={t("settings.appearance.theme.title")}>
          <View style={settingsStyles.card}>
            <ThemeRow value={settings.theme} onChange={handleThemeChange} />
          </View>
        </SettingsSection>
      ) : null}
      {matchesSettingsSearch(
        search,
        t("settings.appearance.sidePanel", { returnObjects: true }),
      ) ? (
        <SettingsSection title={t("settings.appearance.sidePanel.title")}>
          <View style={settingsStyles.card}>
            <SidePanelPlacementRow
              value={settings.sidePanelPlacement}
              onChange={handleSidePanelPlacementChange}
            />
          </View>
        </SettingsSection>
      ) : null}
      {matchesSettingsSearch(
        search,
        t("settings.general.autoExpandReasoning", { returnObjects: true }),
        t("settings.general.toolCallDetail", { returnObjects: true }),
        t("settings.appearance.chatOutline", { returnObjects: true }),
      ) ? (
        <SettingsSection title={t("settings.appearance.detailLevel.title")}>
          <View style={settingsStyles.card}>
            {matchesSettingsSearch(
              search,
              t("settings.general.autoExpandReasoning", { returnObjects: true }),
            ) ? (
              <AutoExpandReasoningRow
                value={settings.autoExpandReasoning}
                onChange={handleAutoExpandReasoningChange}
              />
            ) : null}
            {matchesSettingsSearch(
              search,
              t("settings.general.toolCallDetail", { returnObjects: true }),
            ) ? (
              <ToolCallDetailRow
                value={settings.toolCallDetailLevel}
                onChange={handleToolCallDetailLevelChange}
              />
            ) : null}
            {!isNative &&
            matchesSettingsSearch(
              search,
              t("settings.appearance.chatOutline", { returnObjects: true }),
            ) ? (
              <ChatOutlineRow
                value={settings.chatOutlineEnabled}
                onChange={handleChatOutlineChange}
              />
            ) : null}
          </View>
        </SettingsSection>
      ) : null}
      {matchesSettingsSearch(search, t("settings.appearance.fonts", { returnObjects: true })) ? (
        <SettingsSection title={t("settings.appearance.fonts.title")}>
          <View style={settingsStyles.card}>
            {showFontFamilyRows &&
            matchesSettingsSearch(
              search,
              t("settings.appearance.fonts.interfaceFont"),
              t("settings.appearance.fonts.interfaceFontHint"),
            ) ? (
              <FontFamilyRow
                kind="interface"
                title={t("settings.appearance.fonts.interfaceFont")}
                hint={t("settings.appearance.fonts.interfaceFontHint")}
                accessibilityLabel={t("settings.appearance.fonts.interfaceFontAccessibility")}
                placeholder={uiFontPlaceholder}
                value={settings.uiFontFamily}
                draft={uiFontDraft}
                withBorder={false}
                onChangeDraft={setUiFontDraft}
                onCommit={commitUiFontFamily}
              />
            ) : null}
            {matchesSettingsSearch(search, t("settings.appearance.fonts.interfaceSize")) ? (
              <FontSizeRow
                title={t("settings.appearance.fonts.interfaceSize")}
                accessibilityLabel={t("settings.appearance.fonts.interfaceSizeAccessibility")}
                draft={uiSizeDraft}
                error={uiSizeError}
                min={MIN_UI_FONT_SIZE}
                max={MAX_UI_FONT_SIZE}
                withBorder={showFontFamilyRows}
                onChangeDraft={handleUiSizeChange}
                onCommit={commitUiSize}
              />
            ) : null}
            {showFontFamilyRows &&
            matchesSettingsSearch(
              search,
              t("settings.appearance.fonts.codeFont"),
              t("settings.appearance.fonts.codeFontHint"),
            ) ? (
              <FontFamilyRow
                kind="code"
                title={t("settings.appearance.fonts.codeFont")}
                hint={t("settings.appearance.fonts.codeFontHint")}
                accessibilityLabel={t("settings.appearance.fonts.codeFontAccessibility")}
                placeholder={monoFontPlaceholder}
                value={settings.monoFontFamily}
                draft={monoFontDraft}
                withBorder
                onChangeDraft={setMonoFontDraft}
                onCommit={commitMonoFontFamily}
              />
            ) : null}
            {matchesSettingsSearch(search, t("settings.appearance.fonts.codeSize")) ? (
              <FontSizeRow
                title={t("settings.appearance.fonts.codeSize")}
                accessibilityLabel={t("settings.appearance.fonts.codeSizeAccessibility")}
                draft={codeSizeDraft}
                error={codeSizeError}
                min={MIN_CODE_FONT_SIZE}
                max={MAX_CODE_FONT_SIZE}
                onChangeDraft={handleCodeSizeChange}
                onCommit={commitCodeSize}
              />
            ) : null}
          </View>
        </SettingsSection>
      ) : null}
      {matchesSettingsSearch(search, t("settings.appearance.syntax", { returnObjects: true })) ? (
        <SettingsSection title={t("settings.appearance.syntax.title")}>
          <View style={settingsStyles.card}>
            <SyntaxRow value={settings.syntaxTheme} onChange={handleSyntaxThemeChange} />
          </View>
          <View style={styles.preview}>
            <AppearancePreview overrides={previewOverrides} />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fontPicker: { flex: 1, minWidth: 0, alignItems: "flex-end", gap: theme.spacing[2] },
  fieldError: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  saveError: { gap: theme.spacing[2], marginBottom: theme.spacing[4] },
  preview: {
    marginTop: theme.spacing[4],
  },
  rowWithBorder: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  swatch: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    borderRadius: ICON_SIZE.md / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  fontFamilyInput: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: 280,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "left",
  },
  sizeField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sizeInput: {
    width: 64,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
}));
