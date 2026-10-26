import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Monitor, Moon, Sun } from "lucide-react-native";
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
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useContributedThemes } from "@/appearance/provider";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { toErrorMessage } from "@/utils/error-messages";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import {
  MAX_CODE_FONT_SIZE,
  MAX_CONTENT_FONT_SIZE,
  MAX_UI_BASE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  MIN_UI_BASE_FONT_SIZE,
  parseContentMaxWidth,
  resolveContentMaxWidth,
  sanitizeFontFamily,
  useAppSettings,
  type AppSettings,
  DEFAULT_THEME_PREFERENCE,
} from "@/hooks/use-settings";
import {
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  ICON_SIZE,
  PLUGIN_THEME_PREFERENCE,
  THEME_OPTIONS,
  THEME_SWATCHES,
  type Theme,
} from "@/styles/theme";
import { isNative } from "@/constants/platform";
import type { PluginThemeOption } from "@/plugins/themes";
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

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type BuiltInThemePreference = Exclude<AppSettings["theme"], typeof PLUGIN_THEME_PREFERENCE>;

function getThemeLabel(t: TFunction, value: BuiltInThemePreference): string {
  return t(`settings.appearance.theme.options.${value}`);
}

// Platform default stacks can be the bare native tokens ("normal"/"monospace");
// those read as a bug, so show a human label in the placeholder instead.
const BARE_DEFAULT_STACKS: ReadonlySet<string> = new Set(["normal", "monospace"]);

function resolveDefaultStackPlaceholder(t: TFunction, stack: string): string {
  return BARE_DEFAULT_STACKS.has(stack) ? t("settings.appearance.fonts.systemDefault") : stack;
}

// Local size string -> preview override number. Empty, invalid or out-of-range
// yields undefined so the preview falls back to the committed theme value.
function sizeDraftToOverride(value: string, min: number, max: number): number | undefined {
  if (value.length === 0) return undefined;
  const parsed = Number(value);
  return /^\d+$/.test(value) && parsed >= min && parsed <= max ? parsed : undefined;
}

// A typed size that is not a whole number in range is reported, not clamped, so
// the field never silently changes what the reader typed.
function validateFontSizeDraft(draft: string, min: number, max: number): number | null {
  const next = Number(draft);
  if (!/^\d+$/.test(draft) || !Number.isInteger(next) || next < min || next > max) {
    return null;
  }
  return next;
}

function fontSizeRangeError(min: number, max: number): string {
  return `Enter a whole number from ${min} to ${max} px`;
}

// ---------------------------------------------------------------------------
// Theme picker
// ---------------------------------------------------------------------------

interface ThemeLeadingProps {
  themeValue: BuiltInThemePreference;
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
  themeValue: BuiltInThemePreference;
  selected: boolean;
  onChange: (theme: BuiltInThemePreference) => void;
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

interface PluginThemeMenuItemProps {
  option: PluginThemeOption;
  selected: boolean;
  onSelect: (option: PluginThemeOption) => void;
}

function PluginThemeMenuItem({ option, selected, onSelect }: PluginThemeMenuItemProps) {
  const handleSelect = useCallback(() => {
    onSelect(option);
  }, [onSelect, option]);
  const leading = useMemo(() => <ThemeSwatch color={option.swatch} />, [option.swatch]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {option.name}
    </DropdownMenuItem>
  );
}

interface ThemeRowProps {
  value: AppSettings["theme"];
  pluginThemes: PluginThemeOption[];
  selectedPluginTheme: PluginThemeOption | null;
  onChange: (theme: BuiltInThemePreference) => void;
  onSelectPluginTheme: (option: PluginThemeOption) => void;
}

function ThemeRow({
  value,
  pluginThemes,
  selectedPluginTheme,
  onChange,
  onSelectPluginTheme,
}: ThemeRowProps) {
  const { t } = useTranslation();
  // A selected contribution that is no longer installed shows the fallback the app renders.
  const builtInValue = value === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : value;
  const selectedLabel = selectedPluginTheme
    ? selectedPluginTheme.name
    : getThemeLabel(t, builtInValue);
  const leading = useMemo(
    () =>
      selectedPluginTheme ? (
        <ThemeSwatch color={selectedPluginTheme.swatch} />
      ) : (
        <ThemeLeading themeValue={builtInValue} />
      ),
    [builtInValue, selectedPluginTheme],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.theme.title")}</Text>
      </View>
      <DropdownMenu>
        <DropdownTrigger
          accessibilityLabel={t("settings.appearance.theme.accessibilityLabel", {
            value: selectedLabel,
          })}
          leading={leading}
        >
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200} scrollable>
          {THEME_OPTIONS.map((option, index) => {
            const previousOption = THEME_OPTIONS[index - 1];
            return (
              <Fragment key={option.name}>
                {previousOption && previousOption.group !== option.group ? (
                  <DropdownMenuSeparator />
                ) : null}
                <ThemeMenuItem
                  themeValue={option.name}
                  selected={selectedPluginTheme === null && builtInValue === option.name}
                  onChange={onChange}
                />
              </Fragment>
            );
          })}
          {pluginThemes.length > 0 ? <DropdownMenuSeparator /> : null}
          {pluginThemes.map((option) => (
            <PluginThemeMenuItem
              key={option.id}
              option={option}
              selected={selectedPluginTheme?.id === option.id}
              onSelect={onSelectPluginTheme}
            />
          ))}
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
        <DropdownTrigger
          accessibilityLabel={t("settings.appearance.sidePanel.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          {selectedLabel}
        </DropdownTrigger>
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
  onCommit: (value: string) => string;
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
  const inputRef = useRef<EditingTextInputHandle>(null);
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
    const committed = onCommit(draft);
    inputRef.current?.replaceText(committed);
  }, [draft, onCommit]);

  // Resync from the committed value when it changes elsewhere.
  useEffect(() => {
    onChangeDraft(value);
    inputRef.current?.replaceText(value);
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
          <DropdownTrigger accessibilityLabel={accessibilityLabel}>
            {custom ? "Custom font" : (preset?.label ?? "Custom font")}
          </DropdownTrigger>
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
              ref={inputRef}
              initialValue={draft}
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
  hint: string;
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
  hint,
  accessibilityLabel,
  draft,
  error,
  min,
  max,
  withBorder = true,
  onChangeDraft,
  onCommit,
}: FontSizeRowProps) {
  const inputRef = useRef<EditingTextInputHandle>(null);

  // The field is uncontrolled: a draft resynced from a value saved elsewhere is
  // written into it, while the reader's own typing is left alone.
  useEffect(() => {
    if (inputRef.current?.isFocused()) return;
    inputRef.current?.replaceText(draft);
  }, [draft]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text
          style={error ? styles.fieldError : settingsStyles.rowHint}
          accessibilityLiveRegion="polite"
        >
          {error ?? `${hint} (${min}–${max} px)`}
        </Text>
      </View>
      <View style={styles.sizeField}>
        <TextInput
          ref={inputRef}
          initialValue={draft}
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
// Content width: numeric field (commit on blur/submit) + reset to the default
// ---------------------------------------------------------------------------

interface ContentWidthRowProps {
  value: AppSettings["contentMaxWidth"];
  onChange: (value: AppSettings["contentMaxWidth"]) => void;
}

function ContentWidthRow({ value, onChange }: ContentWidthRowProps) {
  const { t } = useTranslation();
  const width = resolveContentMaxWidth({ contentMaxWidth: value });
  // The field is uncontrolled, so a saved or reset width is written into it directly.
  const input = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    input.current?.replaceText(String(width));
  }, [width]);

  const commit = useCallback(() => {
    const next = parseContentMaxWidth(input.current?.getText()) ?? width;
    input.current?.replaceText(String(next));
    // Typing the width already in effect keeps following the default.
    if (next !== width) {
      onChange(next);
    }
  }, [onChange, width]);

  const reset = useCallback(() => {
    onChange(null);
  }, [onChange]);

  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.layout.contentWidth")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.layout.contentWidthHint")}
        </Text>
      </View>
      <View style={styles.sizeField}>
        {value === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            onPress={reset}
            accessibilityLabel={t("settings.appearance.layout.resetAccessibility")}
          >
            {t("settings.appearance.layout.reset")}
          </Button>
        )}
        <TextInput
          ref={input}
          initialValue={String(width)}
          onBlur={commit}
          onSubmitEditing={commit}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.widthInput}
          accessibilityLabel={t("settings.appearance.layout.contentWidthAccessibility")}
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
        <DropdownTrigger
          accessibilityLabel={t("settings.appearance.syntax.highlightThemeAccessibility", {
            value: selectedLabel,
          })}
        >
          {selectedLabel}
        </DropdownTrigger>
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
  // A search that names the page itself shows the whole page.
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
  const {
    options: pluginThemes,
    selected: selectedPluginTheme,
    select: selectPluginTheme,
  } = useContributedThemes();
  const showInterfaceFontFamilyRow = !isNative;
  const uiFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_UI_FONT_STACK);
  const monoFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_MONO_FONT_STACK);

  const [uiFontDraft, setUiFontDraft] = useState(settings.uiFontFamily);
  const [monoFontDraft, setMonoFontDraft] = useState(settings.monoFontFamily);
  const [uiBaseSizeDraft, setUiBaseSizeDraft] = useState(String(settings.uiBaseFontSize));
  const [contentSizeDraft, setContentSizeDraft] = useState(String(settings.contentFontSize));
  const [codeSizeDraft, setCodeSizeDraft] = useState(String(settings.codeFontSize));
  const [uiBaseSizeError, setUiBaseSizeError] = useState<string | null>(null);
  const [contentSizeError, setContentSizeError] = useState<string | null>(null);
  const [codeSizeError, setCodeSizeError] = useState<string | null>(null);

  // Resync numeric drafts when the committed value changes elsewhere.
  useEffect(() => {
    setUiBaseSizeDraft(String(settings.uiBaseFontSize));
  }, [settings.uiBaseFontSize]);
  useEffect(() => {
    setContentSizeDraft(String(settings.contentFontSize));
  }, [settings.contentFontSize]);
  useEffect(() => {
    setCodeSizeDraft(String(settings.codeFontSize));
  }, [settings.codeFontSize]);

  const handleThemeChange = useCallback(
    (theme: BuiltInThemePreference) => {
      void updateSettings({ theme });
    },
    [updateSettings],
  );

  const handlePluginThemeChange = useCallback(
    (option: PluginThemeOption) => {
      selectPluginTheme(option);
    },
    [selectPluginTheme],
  );

  const handleSidePanelPlacementChange = useCallback(
    (sidePanelPlacement: AppSettings["sidePanelPlacement"]) => {
      void updateSettings({ sidePanelPlacement });
    },
    [updateSettings],
  );

  const handleContentMaxWidthChange = useCallback(
    (contentMaxWidth: AppSettings["contentMaxWidth"]) => {
      void updateSettings({ contentMaxWidth });
    },
    [updateSettings],
  );

  const handleSyntaxThemeChange = useCallback(
    (syntaxTheme: SyntaxThemeId) => {
      void updateSettings({ syntaxTheme });
    },
    [updateSettings],
  );

  const commitUiFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setUiFontDraft(settings.uiFontFamily);
        return settings.uiFontFamily;
      }
      setUiFontDraft(sanitized);
      if (sanitized !== settings.uiFontFamily) {
        void updateSettings({ uiFontFamily: sanitized });
      }
      return sanitized;
    },
    [settings.uiFontFamily, updateSettings],
  );

  const commitMonoFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setMonoFontDraft(settings.monoFontFamily);
        return settings.monoFontFamily;
      }
      setMonoFontDraft(sanitized);
      if (sanitized !== settings.monoFontFamily) {
        void updateSettings({ monoFontFamily: sanitized });
      }
      return sanitized;
    },
    [settings.monoFontFamily, updateSettings],
  );

  const commitUiBaseSize = useCallback(() => {
    const next = validateFontSizeDraft(
      uiBaseSizeDraft,
      MIN_UI_BASE_FONT_SIZE,
      MAX_UI_BASE_FONT_SIZE,
    );
    if (next === null) {
      setUiBaseSizeError(fontSizeRangeError(MIN_UI_BASE_FONT_SIZE, MAX_UI_BASE_FONT_SIZE));
      return;
    }
    setUiBaseSizeError(null);
    if (next !== settings.uiBaseFontSize) void updateSettings({ uiBaseFontSize: next });
  }, [settings.uiBaseFontSize, uiBaseSizeDraft, updateSettings]);

  const commitContentSize = useCallback(() => {
    const next = validateFontSizeDraft(
      contentSizeDraft,
      MIN_CONTENT_FONT_SIZE,
      MAX_CONTENT_FONT_SIZE,
    );
    if (next === null) {
      setContentSizeError(fontSizeRangeError(MIN_CONTENT_FONT_SIZE, MAX_CONTENT_FONT_SIZE));
      return;
    }
    setContentSizeError(null);
    if (next !== settings.contentFontSize) void updateSettings({ contentFontSize: next });
  }, [contentSizeDraft, settings.contentFontSize, updateSettings]);

  const commitCodeSize = useCallback(() => {
    const next = validateFontSizeDraft(codeSizeDraft, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE);
    if (next === null) {
      setCodeSizeError(fontSizeRangeError(MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE));
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
      contentFontSize: sizeDraftToOverride(
        contentSizeDraft,
        MIN_CONTENT_FONT_SIZE,
        MAX_CONTENT_FONT_SIZE,
      ),
      monoFontFamily: monoFontDraft,
      codeFontSize: sizeDraftToOverride(codeSizeDraft, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE),
    }),
    [codeSizeDraft, contentSizeDraft, monoFontDraft],
  );

  const showInterfaceFontFamily =
    showInterfaceFontFamilyRow &&
    matchesSettingsSearch(
      search,
      t("settings.appearance.fonts.interfaceFont"),
      t("settings.appearance.fonts.interfaceFontHint"),
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
            <ThemeRow
              value={settings.theme}
              pluginThemes={pluginThemes}
              selectedPluginTheme={selectedPluginTheme}
              onChange={handleThemeChange}
              onSelectPluginTheme={handlePluginThemeChange}
            />
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
      {matchesSettingsSearch(search, t("settings.appearance.fonts", { returnObjects: true })) ? (
        <SettingsSection title={t("settings.appearance.fonts.title")}>
          <View style={settingsStyles.card}>
            {showInterfaceFontFamily ? (
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
            {matchesSettingsSearch(
              search,
              t("settings.appearance.fonts.interfaceSize"),
              t("settings.appearance.fonts.interfaceSizeHint"),
            ) ? (
              <FontSizeRow
                title={t("settings.appearance.fonts.interfaceSize")}
                hint={t("settings.appearance.fonts.interfaceSizeHint")}
                accessibilityLabel={t("settings.appearance.fonts.interfaceSizeAccessibility")}
                draft={uiBaseSizeDraft}
                error={uiBaseSizeError}
                min={MIN_UI_BASE_FONT_SIZE}
                max={MAX_UI_BASE_FONT_SIZE}
                withBorder={showInterfaceFontFamily}
                onChangeDraft={setUiBaseSizeDraft}
                onCommit={commitUiBaseSize}
              />
            ) : null}
            {matchesSettingsSearch(
              search,
              t("settings.appearance.fonts.contentSize"),
              t("settings.appearance.fonts.contentSizeHint"),
            ) ? (
              <FontSizeRow
                title={t("settings.appearance.fonts.contentSize")}
                hint={t("settings.appearance.fonts.contentSizeHint")}
                accessibilityLabel={t("settings.appearance.fonts.contentSizeAccessibility")}
                draft={contentSizeDraft}
                error={contentSizeError}
                min={MIN_CONTENT_FONT_SIZE}
                max={MAX_CONTENT_FONT_SIZE}
                onChangeDraft={setContentSizeDraft}
                onCommit={commitContentSize}
              />
            ) : null}
            {matchesSettingsSearch(
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
            {matchesSettingsSearch(
              search,
              t("settings.appearance.fonts.codeSize"),
              t("settings.appearance.fonts.codeSizeHint"),
            ) ? (
              <FontSizeRow
                title={t("settings.appearance.fonts.codeSize")}
                hint={t("settings.appearance.fonts.codeSizeHint")}
                accessibilityLabel={t("settings.appearance.fonts.codeSizeAccessibility")}
                draft={codeSizeDraft}
                error={codeSizeError}
                min={MIN_CODE_FONT_SIZE}
                max={MAX_CODE_FONT_SIZE}
                onChangeDraft={setCodeSizeDraft}
                onCommit={commitCodeSize}
              />
            ) : null}
          </View>
        </SettingsSection>
      ) : null}
      {matchesSettingsSearch(search, t("settings.appearance.layout", { returnObjects: true })) ? (
        <SettingsSection title={t("settings.appearance.layout.title")}>
          <View style={settingsStyles.card}>
            <ContentWidthRow
              value={settings.contentMaxWidth}
              onChange={handleContentMaxWidthChange}
            />
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
  fieldError: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
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
    fontSize: theme.fontSize.base,
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
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  widthInput: {
    width: 80,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
}));
