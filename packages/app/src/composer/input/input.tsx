import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  View,
  Text,
  TextInput,
  useWindowDimensions,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
} from "react-native";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  forwardRef,
} from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ArrowUp, Mic, CornerDownLeft, Plus, Square } from "lucide-react-native";
import { useDictation } from "@/hooks/use-dictation";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { CompactComposerToolbarContext } from "@/composer/toolbar-layout";
import { DictationOverlay } from "@/components/dictation-controls";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import {
  collectFilesFromClipboardData,
  type ClipboardFiles,
} from "@/utils/image-attachments-from-files";
import type { ComposerAttachment } from "@/attachments/types";
import type { ComposerSubmitAction, MessagePayload } from "@/composer/types";
import { focusWithRetries } from "@/utils/web-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useIosHardwareKeyboardSubmit } from "@/hooks/use-ios-hardware-keyboard-submit";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useComposerHeightMirror } from "./height-mirror";
import { resolveComposerInputMode, type ComposerInputMode } from "@/composer/input-mode";
import {
  resolveSendTooltipLabel,
  resolveSubmitAccessibilityLabel,
  resolveDictationAccessibilityLabel,
} from "./labels";
import {
  applyDictationTranscript,
  computeCanStartDictation,
  resolveComposerSurfacePresentation,
  runAlternateSendAction,
  runDefaultSendAction,
  runMessageInputKeyboardAction,
} from "./state";

const DEFAULT_SEND_KEYS: ShortcutKey[][] = [["Enter"]];
const COMPOSER_INPUT_DATASET = { composerInput: "" } as const;

export interface AttachmentMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  icon?: React.ReactElement | null;
}

export interface MessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  /** When true, the submit button is enabled even without text or images (e.g. external attachment selected). */
  hasExternalContent?: boolean;
  /** When true, the submit button stays visible and can submit even with no content. */
  allowEmptySubmit?: boolean;
  /** Optional accessibility label for the primary submit button. */
  submitButtonAccessibilityLabel?: string;
  /** Optional testID for the primary submit button. */
  submitButtonTestID?: string;
  submitIcon?: "arrow" | "return";
  isSubmitDisabled?: boolean;
  isSubmitLoading?: boolean;
  /** When true, keep the grown input height after submit (text is preserved, not cleared). */
  preserveHeightOnSubmit?: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  onAttachButtonRef?: (node: View | null) => void;
  /** Files pasted into the input: images to attach as images, the rest as files. */
  onPasteFiles?: (files: ClipboardFiles) => void;
  client: DaemonClient | null;
  /** Dictation start gate from host runtime (socket connected + directory ready). */
  isReadyForDictation?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  autoFocusKey?: string;
  disabled?: boolean;
  /** True when this composer's pane is focused. Used to gate global hotkeys and stop dictation when hidden. */
  isPaneFocused?: boolean;
  /** Content to render on the left side of the composer toolbar (e.g., AgentControls) */
  leftContent?: React.ReactNode;
  /** Content to render on the right side before the voice button (e.g., context window meter) */
  beforeVoiceContent?: React.ReactNode;
  /** Primary action to render when the agent is active and the composer has no sendable content. */
  activeActionContent?: React.ReactNode;
  voiceServerId?: string;
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean;
  /** Controls what the default send action (Enter, send button, dictation) does
   *  when the agent is running. "interrupt" sends immediately, "queue" queues. */
  defaultSendBehavior?: "interrupt" | "queue";
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void;
  /** Optional handler used when submit button is in loading state. */
  onSubmitLoadingPress?: () => void;
  /** Intercept key press events before default handling. Return true to prevent default. */
  onKeyPress?: (event: { key: string; preventDefault: () => void }) => boolean;
  /** Reports cursor selection updates from the underlying input. */
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  onFocusChange?: (focused: boolean) => void;
  onHeightChange?: (height: number) => void;
  /** Extra styles merged onto the input wrapper (e.g. elevated background). */
  inputWrapperStyle?: import("react-native").ViewStyle;
  /** Content rendered inside the bordered input surface, above the text input (e.g. attachment pills). */
  attachmentSlot?: React.ReactNode;
  /** What this composer is for. See `@/composer/input-mode` for what each mode implies. */
  inputMode?: ComposerInputMode;
  /** Renders `value` as static text on the same surface, for content there is nothing to type into. */
  readOnly?: boolean;
  /** Replaces the submit icon with this label, still inside the composer's own toolbar row. */
  submitLabel?: string;
  /** Replaces the primary submit button with explicit, simultaneous submit choices. */
  submitActions?: readonly ComposerSubmitAction[];
  onSubmitAction?: (actionId: string, payload: MessagePayload) => void;
}

export interface MessageInputRef {
  focus: () => void;
  blur: () => void;
  runKeyboardAction: (action: MessageInputKeyboardActionKind) => boolean;
  /**
   * Web-only: return the underlying DOM element for focus assertions/retries.
   * May return null if not mounted or on native.
   */
  getNativeElement?: () => HTMLElement | null;
}

const MIN_INPUT_HEIGHT_MOBILE = 30;
const MIN_INPUT_HEIGHT_DESKTOP = 46;
const DEFAULT_MAX_INPUT_HEIGHT = 160;
const MAX_INPUT_VIEWPORT_RATIO = 0.5;
const MIN_INPUT_HEIGHT = isWeb ? MIN_INPUT_HEIGHT_DESKTOP : MIN_INPUT_HEIGHT_MOBILE;
type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    // Web-only: present on DOM KeyboardEvent during IME composition (CJK input).
    isComposing?: boolean;
    keyCode?: number;
  }
>;

interface TextAreaHandle {
  scrollHeight?: number;
  clientHeight?: number;
  offsetHeight?: number;
  scrollTop?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  style?: {
    height?: string;
    overflowY?: string;
  } & Record<string, unknown>;
}

function AttachButtonIcon({
  hovered,
  onAttachButtonRef,
  buttonIconSize,
}: {
  hovered: boolean;
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  buttonIconSize: number;
}) {
  const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
  return (
    <View ref={onAttachButtonRef} collapsable={false} style={styles.attachButtonAnchor}>
      <ThemedPlus size={buttonIconSize} uniProps={colorMapping} />
    </View>
  );
}

function AttachmentMenuList({ items }: { items: AttachmentMenuItem[] }) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          testID={`message-input-attachment-menu-item-${item.id}`}
          disabled={item.disabled}
          onSelect={item.onSelect}
          leading={item.icon ?? null}
        >
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function AttachmentDropdown({
  visible,
  isConnected,
  disabled,
  attachButtonStyle,
  renderAttachButtonIcon,
  attachmentMenuItems,
  addAttachmentLabel,
}: {
  visible: boolean;
  isConnected: boolean;
  disabled: boolean;
  attachButtonStyle: React.ComponentProps<typeof DropdownMenuTrigger>["style"];
  renderAttachButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  attachmentMenuItems: AttachmentMenuItem[];
  addAttachmentLabel: string;
}) {
  const isButtonDisabled = !isConnected || disabled;
  if (!visible) return null;
  return (
    <DropdownMenu compactMode="sheet">
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={isButtonDisabled}
            accessibilityLabel={addAttachmentLabel}
            accessibilityRole="button"
            testID="message-input-attach-button"
            style={attachButtonStyle}
          >
            {renderAttachButtonIcon}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{addAttachmentLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        minWidth={220}
        testID="message-input-attachment-menu"
        sheetTitle={addAttachmentLabel}
      >
        <AttachmentMenuList items={attachmentMenuItems} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DictationButtonIcon({
  hovered,
  isDictating,
  buttonIconSize,
}: {
  hovered: boolean;
  isDictating: boolean;
  buttonIconSize: number;
}) {
  if (isDictating) {
    return <Square size={buttonIconSize} color="white" fill="white" />;
  }
  const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
  return <ThemedMic size={buttonIconSize} uniProps={colorMapping} />;
}

type ShortcutChord = NonNullable<React.ComponentProps<typeof Shortcut>["chord"]>;

function DictationTooltipBody({
  label,
  shortcut,
}: {
  label: string;
  shortcut: ShortcutChord | null | undefined;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcut ? <Shortcut chord={shortcut} /> : null}
    </View>
  );
}

function SendTooltipBody({
  label,
  sendKeys,
}: {
  label: string;
  sendKeys: ShortcutChord | null | undefined;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {sendKeys ? <Shortcut chord={sendKeys} /> : null}
    </View>
  );
}

function SendButtonContent({
  isSubmitLoading,
  submitIcon,
  submitLabel,
  buttonIconSize,
}: {
  isSubmitLoading: boolean;
  submitIcon: "arrow" | "return";
  submitLabel: string | undefined;
  buttonIconSize: number;
}) {
  if (isSubmitLoading) {
    return <ThemedLoadingSpinner size="small" uniProps={iconAccentForegroundMapping} />;
  }
  if (submitLabel) {
    return <Text style={styles.sendButtonLabel}>{submitLabel}</Text>;
  }
  if (submitIcon === "return") {
    return <ThemedCornerDownLeft size={buttonIconSize} uniProps={iconAccentForegroundMapping} />;
  }
  return <ThemedArrowUp size={buttonIconSize} uniProps={iconAccentForegroundMapping} />;
}

interface DesktopKeyPressContext {
  onKeyPressCallback: ((event: { key: string; preventDefault: () => void }) => boolean) | undefined;
  submitOnEnter: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  disabled: boolean;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
}

function handleDesktopKeyPressImpl(
  event: WebTextInputKeyPressEvent,
  ctx: DesktopKeyPressContext,
): void {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return;

  if (ctx.onKeyPressCallback) {
    const handled = ctx.onKeyPressCallback({
      key: event.nativeEvent.key,
      preventDefault: () => event.preventDefault(),
    });
    if (handled) return;
  }

  const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

  if (event.nativeEvent.key !== "Enter") return;
  if (!ctx.submitOnEnter) return;
  if (shiftKey) return;

  if ((metaKey || ctrlKey) && ctx.isAgentRunning && ctx.onQueue) {
    if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
    event.preventDefault();
    ctx.handleAlternateSendAction();
    return;
  }

  if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
  event.preventDefault();
  ctx.handleDefaultSendAction();
}

function getTextInputNativeElement(
  current: TextInput | (TextInput & { getNativeRef?: () => unknown }) | null,
): HTMLElement | null {
  if (!current) return null;
  const handle = current as TextInput & { getNativeRef?: () => unknown };
  const native = typeof handle.getNativeRef === "function" ? handle.getNativeRef() : current;
  return native instanceof HTMLElement ? native : null;
}

interface PasteFilesEffectArgs {
  getWebTextArea: () => TextAreaHandle | null;
  isConnected: boolean;
  disabled: boolean;
  isDictating: boolean;
  onPasteFiles: ((files: ClipboardFiles) => void) | undefined;
}

function usePasteFilesEffect(args: PasteFilesEffectArgs): void {
  const { getWebTextArea, isConnected, disabled, isDictating, onPasteFiles } = args;

  useEffect(() => {
    if (!isWeb || !onPasteFiles) return;

    const textarea = getWebTextArea() as
      | (TextAreaHandle & {
          addEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
          removeEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
        })
      | null;
    if (
      !textarea ||
      typeof textarea.addEventListener !== "function" ||
      typeof textarea.removeEventListener !== "function"
    ) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      if (!isConnected || disabled || isDictating) return;

      const files = collectFilesFromClipboardData(event.clipboardData);
      if (files.images.length === 0 && files.others.length === 0) return;

      event.preventDefault();
      onPasteFiles(files);
    };

    textarea.addEventListener("paste", handlePaste);
    return () => {
      textarea.removeEventListener?.("paste", handlePaste);
    };
  }, [disabled, getWebTextArea, isConnected, isDictating, onPasteFiles]);
}

function useAutoFocusOnWebEffect(
  textInputRef: React.MutableRefObject<
    TextInput | (TextInput & { getNativeRef?: () => unknown }) | null
  >,
  autoFocus: boolean,
  autoFocusKey: string | undefined,
): void {
  useEffect(() => {
    if (!isWeb || !autoFocus) return;
    return focusWithRetries({
      focus: () => textInputRef.current?.focus(),
      isFocused: () => {
        const element = getTextInputNativeElement(textInputRef.current);
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return Boolean(element) && active === element;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, autoFocusKey]);
}

function MessageInputOverlay({
  showDictationOverlay,
  dictationVolume,
  dictationDuration,
  isDictating,
  isDictationProcessing,
  dictationStatus,
  dictationError,
  onCancelRecording,
  onAcceptRecording,
  onAcceptAndSendRecording,
  onRetryFailedRecording,
  onDiscardFailedRecording,
}: {
  showDictationOverlay: boolean;
  dictationVolume: number;
  dictationDuration: number;
  isDictating: boolean;
  isDictationProcessing: boolean;
  dictationStatus: React.ComponentProps<typeof DictationOverlay>["status"];
  dictationError: string | null;
  onCancelRecording: () => Promise<void>;
  onAcceptRecording: () => Promise<void>;
  onAcceptAndSendRecording: () => Promise<void>;
  onRetryFailedRecording: () => void;
  onDiscardFailedRecording: () => void;
}) {
  if (showDictationOverlay) {
    return (
      <DictationOverlay
        volume={dictationVolume}
        duration={dictationDuration}
        isRecording={isDictating}
        isProcessing={isDictationProcessing}
        status={dictationStatus}
        errorText={dictationStatus === "failed" ? (dictationError ?? undefined) : undefined}
        onCancel={onCancelRecording}
        onAccept={onAcceptRecording}
        onAcceptAndSend={onAcceptAndSendRecording}
        onRetry={dictationStatus === "failed" ? onRetryFailedRecording : undefined}
        onDiscard={dictationStatus === "failed" ? onDiscardFailedRecording : undefined}
      />
    );
  }
  return null;
}

function FocusHint({
  visible,
  focusInputKeys,
  label,
}: {
  visible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  label: string;
}) {
  if (!visible || !focusInputKeys || !label.trim()) return null;
  return (
    <Text style={styles.focusHintText} pointerEvents="none">
      {label}
    </Text>
  );
}

interface ComposerTextSurfaceProps {
  readOnly: boolean;
  value: string;
  textInputRef: React.Ref<TextInput>;
  textInputStyle: React.ComponentProps<typeof ThemedTextInput>["style"];
  readOnlyTextStyle: React.ComponentProps<typeof Text>["style"];
  placeholder: string;
  accessibilityLabel: string;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  editable: boolean;
  scrollEnabled: boolean;
  autoFocus: boolean;
  onContentSizeChange: (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => void;
  onKeyPress: ((event: WebTextInputKeyPressEvent) => void) | undefined;
  onSelectionChange: (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  focusHintVisible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  focusHintLabel: string;
}

/**
 * The composer's content: an editable input, or static text when there is
 * nothing to type. Both sit in the same bordered surface, so read-only is a
 * state of this composer rather than a second one.
 */
function ComposerTextSurface(props: ComposerTextSurfaceProps): React.ReactElement {
  if (props.readOnly) {
    return (
      <View style={styles.textInputScrollWrapper}>
        <Text style={props.readOnlyTextStyle} testID="composer-readonly-content">
          {props.value}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.textInputScrollWrapper}>
      <ThemedTextInput
        ref={props.textInputRef}
        dataSet={COMPOSER_INPUT_DATASET}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        uniProps={textInputPlaceholderColorMapping}
        accessibilityLabel={props.accessibilityLabel}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        style={props.textInputStyle}
        multiline
        scrollEnabled={props.scrollEnabled}
        onContentSizeChange={props.onContentSizeChange}
        editable={props.editable}
        onKeyPress={props.onKeyPress}
        onSelectionChange={props.onSelectionChange}
        autoFocus={props.autoFocus}
      />
      <FocusHint
        visible={props.focusHintVisible}
        focusInputKeys={props.focusInputKeys}
        label={props.focusHintLabel}
      />
    </View>
  );
}

function DictationButtonTooltip({
  visible,
  onDictationPress,
  isDictationStartEnabled,
  dictationButtonAccessibilityLabel,
  dictationButtonStyle,
  renderDictationButtonIcon,
  dictationTooltipText,
  dictationToggleKeys,
}: {
  visible: boolean;
  onDictationPress: () => void;
  isDictationStartEnabled: boolean;
  dictationButtonAccessibilityLabel: string;
  dictationButtonStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  renderDictationButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  dictationTooltipText: string;
  dictationToggleKeys: ShortcutChord | null | undefined;
}) {
  if (!visible) return null;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={onDictationPress}
        disabled={!isDictationStartEnabled}
        accessibilityRole="button"
        accessibilityLabel={dictationButtonAccessibilityLabel}
        style={dictationButtonStyle}
      >
        {renderDictationButtonIcon}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <DictationTooltipBody label={dictationTooltipText} shortcut={dictationToggleKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function SendButtonTooltip({
  shouldShow,
  canPressLoadingButton,
  onSubmitLoadingPress,
  onDefaultSendAction,
  isSendButtonDisabled,
  submitAccessibilityLabel,
  sendButtonCombinedStyle,
  isSubmitLoading,
  submitIcon,
  submitLabel,
  submitButtonTestID,
  buttonIconSize,
  sendKeys,
  sendTooltipLabel,
}: {
  shouldShow: boolean;
  canPressLoadingButton: boolean;
  onSubmitLoadingPress: (() => void) | undefined;
  onDefaultSendAction: () => void;
  isSendButtonDisabled: boolean;
  submitAccessibilityLabel: string;
  sendButtonCombinedStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  isSubmitLoading: boolean;
  submitIcon: "arrow" | "return";
  submitLabel: string | undefined;
  submitButtonTestID: string | undefined;
  buttonIconSize: number;
  sendKeys: ShortcutChord | null | undefined;
  sendTooltipLabel: string;
}) {
  if (!shouldShow) return null;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={canPressLoadingButton ? onSubmitLoadingPress : onDefaultSendAction}
        disabled={isSendButtonDisabled}
        accessibilityLabel={submitAccessibilityLabel}
        accessibilityRole="button"
        testID={submitButtonTestID}
        style={sendButtonCombinedStyle}
      >
        <SendButtonContent
          isSubmitLoading={isSubmitLoading}
          submitIcon={submitIcon}
          submitLabel={submitLabel}
          buttonIconSize={buttonIconSize}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <SendTooltipBody label={sendTooltipLabel} sendKeys={sendKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

type PrimaryActionKind = "send" | "active" | "none";

function hasSendableComposerContent(input: {
  value: string;
  attachments: readonly ComposerAttachment[];
  hasExternalContent: boolean;
}): boolean {
  return input.value.trim().length > 0 || input.attachments.length > 0 || input.hasExternalContent;
}

function resolvePrimaryActionKind(input: {
  hasSendableContent: boolean;
  allowEmptySubmit: boolean;
  isAgentRunning: boolean;
  isSubmitLoading: boolean;
}): PrimaryActionKind {
  if (input.hasSendableContent || input.allowEmptySubmit) return "send";
  if (input.isAgentRunning) return "active";
  if (input.isSubmitLoading) return "send";
  return "none";
}

function PrimaryAction({
  kind,
  activeActionContent,
  submitActions,
  onSubmitAction,
  ...sendButtonProps
}: {
  kind: PrimaryActionKind;
  activeActionContent: React.ReactNode;
  submitActions: readonly ComposerSubmitAction[];
  onSubmitAction: ((actionId: string) => void) | undefined;
} & React.ComponentProps<typeof SendButtonTooltip>) {
  if (kind === "active") return activeActionContent;
  if (kind === "send" && submitActions.length > 0 && onSubmitAction) {
    return (
      <SubmitActionButtons
        actions={submitActions}
        disabled={sendButtonProps.isSendButtonDisabled}
        buttonIconSize={sendButtonProps.buttonIconSize}
        onPress={onSubmitAction}
      />
    );
  }
  if (kind === "send") return <SendButtonTooltip {...sendButtonProps} />;
  return null;
}

function SubmitActionButton({
  action,
  disabled,
  buttonIconSize,
  onPress,
}: {
  action: ComposerSubmitAction;
  disabled: boolean;
  buttonIconSize: number;
  onPress: (actionId: string) => void;
}) {
  const handlePress = useCallback(() => onPress(action.id), [action.id, onPress]);
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handlePress}
        disabled={disabled}
        accessibilityLabel={action.accessibilityLabel ?? action.label}
        accessibilityRole="button"
        testID={action.testID}
        style={[styles.sendButton, styles.sendButtonLabeled, disabled && styles.buttonDisabled]}
      >
        <View style={styles.submitActionContent}>
          <Text style={styles.sendButtonLabel}>{action.label}</Text>
          <ThemedArrowUp size={buttonIconSize} uniProps={iconAccentForegroundMapping} />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{action.label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function SubmitActionButtons({
  actions,
  disabled,
  buttonIconSize,
  onPress,
}: {
  actions: readonly ComposerSubmitAction[];
  disabled: boolean;
  buttonIconSize: number;
  onPress: (actionId: string) => void;
}) {
  return (
    <View style={styles.submitActions}>
      {actions.map((action) => (
        <SubmitActionButton
          key={action.id}
          action={action}
          disabled={disabled}
          buttonIconSize={buttonIconSize}
          onPress={onPress}
        />
      ))}
    </View>
  );
}
interface StartDictationContext {
  dictationUnavailableMessage: string | null | undefined;
  canStartDictation: () => boolean;
  toast: { error: (msg: string) => void };
  startDictation: () => Promise<void>;
}

async function startDictationIfAvailableImpl(ctx: StartDictationContext): Promise<void> {
  if (ctx.dictationUnavailableMessage) {
    ctx.toast.error(ctx.dictationUnavailableMessage);
    return;
  }
  if (!ctx.canStartDictation()) {
    return;
  }
  await ctx.startDictation();
}

interface DictationPressContext {
  isDictating: boolean;
  cancelDictation: () => Promise<void> | void;
  startDictationIfAvailable: () => Promise<void>;
}

async function handleDictationPressImpl(ctx: DictationPressContext): Promise<void> {
  if (ctx.isDictating) {
    await ctx.cancelDictation();
    return;
  }
  await ctx.startDictationIfAvailable();
}

interface SendMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  cwd: string;
  isAgentRunning: boolean;
  onSubmit: (payload: MessagePayload) => void;
  onMinimizeHeight: () => void;
  preserveHeightOnSubmit: boolean;
}

function sendMessageImpl(ctx: SendMessageContext): void {
  const trimmed = ctx.value.trim();
  if (
    !trimmed &&
    ctx.attachments.length === 0 &&
    !ctx.hasExternalContent &&
    !ctx.allowEmptySubmit
  ) {
    return;
  }
  ctx.onSubmit({
    text: trimmed,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
  // When the host preserves and locks the composer (e.g. new-workspace creation),
  // the text stays put — collapsing the height would clip it. Keep it grown.
  if (!ctx.preserveHeightOnSubmit) {
    ctx.onMinimizeHeight();
  }
}

interface QueueMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  cwd: string;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onChangeText: (text: string) => void;
  onMinimizeHeight: () => void;
}

function queueMessageImpl(ctx: QueueMessageContext): void {
  if (!ctx.onQueue) return;
  const trimmed = ctx.value.trim();
  if (!trimmed && ctx.attachments.length === 0) return;
  ctx.onQueue({ text: trimmed, attachments: ctx.attachments, cwd: ctx.cwd });
  ctx.onChangeText("");
  ctx.onMinimizeHeight();
}

function computeShouldShowDictationOverlay(
  isDictating: boolean,
  isDictationProcessing: boolean,
  dictationStatus: string,
): boolean {
  return isDictating || isDictationProcessing || dictationStatus === "failed";
}

function computeIsDictationStartEnabled(
  isReadyForDictation: boolean | undefined,
  isConnected: boolean,
  disabled: boolean,
): boolean {
  return (isReadyForDictation ?? isConnected) && !disabled;
}

function resolveMaxInputHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return DEFAULT_MAX_INPUT_HEIGHT;
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(windowHeight * MAX_INPUT_VIEWPORT_RATIO));
}

function computeTextInputHeightStyle(inputHeight: number, maxInputHeight: number) {
  if (isWeb) {
    return {
      height: inputHeight,
      minHeight: MIN_INPUT_HEIGHT,
      maxHeight: maxInputHeight,
    };
  }
  return {
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: maxInputHeight,
  };
}

function isTextAreaLike(v: unknown): v is TextAreaHandle {
  return typeof v === "object" && v !== null && "scrollHeight" in v;
}

function getWebTextAreaImpl(
  current: TextInput | (TextInput & { getNativeRef?: () => unknown }) | null,
): TextAreaHandle | null {
  if (!current) return null;
  const candidate = current as { getNativeRef?: () => unknown };
  if (typeof candidate.getNativeRef === "function") {
    const native = candidate.getNativeRef();
    if (isTextAreaLike(native)) return native;
  }
  if (isTextAreaLike(current)) return current;
  return null;
}

interface SendButtonStateInput {
  disabled: boolean;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  onSubmitLoadingPress: (() => void) | undefined;
  defaultSendBehavior: "interrupt" | "queue";
  isAgentRunning: boolean;
}

interface SendButtonStateOutput {
  canPressLoadingButton: boolean;
  isSendButtonDisabled: boolean;
  defaultActionQueues: boolean;
}

function computeSendButtonState(input: SendButtonStateInput): SendButtonStateOutput {
  const canPressLoadingButton =
    input.isSubmitLoading && typeof input.onSubmitLoadingPress === "function";
  const isSendButtonDisabled =
    input.disabled || (!canPressLoadingButton && (input.isSubmitDisabled || input.isSubmitLoading));
  const defaultActionQueues = input.defaultSendBehavior === "queue" && input.isAgentRunning;
  return { canPressLoadingButton, isSendButtonDisabled, defaultActionQueues };
}

interface ResolvedMessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  submitButtonAccessibilityLabel: string | undefined;
  submitButtonTestID: string | undefined;
  submitIcon: "arrow" | "return";
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  preserveHeightOnSubmit: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  onPasteFiles: ((files: ClipboardFiles) => void) | undefined;
  client: DaemonClient | null;
  isReadyForDictation: boolean | undefined;
  placeholder: string | undefined;
  autoFocus: boolean;
  autoFocusKey: string | undefined;
  disabled: boolean;
  isPaneFocused: boolean;
  leftContent: React.ReactNode;
  beforeVoiceContent: React.ReactNode;
  activeActionContent: React.ReactNode;
  voiceServerId: string | undefined;
  isAgentRunning: boolean;
  defaultSendBehavior: "interrupt" | "queue";
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmitLoadingPress: (() => void) | undefined;
  onKeyPressCallback: ((event: { key: string; preventDefault: () => void }) => boolean) | undefined;
  onSelectionChangeCallback: ((selection: { start: number; end: number }) => void) | undefined;
  onFocusChange: ((focused: boolean) => void) | undefined;
  onHeightChange: ((height: number) => void) | undefined;
  inputWrapperStyle: import("react-native").ViewStyle | undefined;
  attachmentSlot: React.ReactNode;
  inputMode: ComposerInputMode;
  readOnly: boolean;
  submitLabel: string | undefined;
  submitActions: readonly ComposerSubmitAction[];
  onSubmitAction: ((actionId: string, payload: MessagePayload) => void) | undefined;
}

function resolveMessageInputProps(props: MessageInputProps): ResolvedMessageInputProps {
  return {
    value: props.value,
    onChangeText: props.onChangeText,
    onSubmit: props.onSubmit,
    hasExternalContent: props.hasExternalContent ?? false,
    allowEmptySubmit: props.allowEmptySubmit ?? false,
    submitButtonAccessibilityLabel: props.submitButtonAccessibilityLabel,
    submitButtonTestID: props.submitButtonTestID,
    submitIcon: props.submitIcon ?? "arrow",
    isSubmitDisabled: props.isSubmitDisabled ?? false,
    isSubmitLoading: props.isSubmitLoading ?? false,
    preserveHeightOnSubmit: props.preserveHeightOnSubmit ?? false,
    attachments: props.attachments,
    cwd: props.cwd,
    attachmentMenuItems: props.attachmentMenuItems,
    onAttachButtonRef: props.onAttachButtonRef,
    onPasteFiles: props.onPasteFiles,
    client: props.client,
    isReadyForDictation: props.isReadyForDictation,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus ?? false,
    autoFocusKey: props.autoFocusKey,
    disabled: props.disabled ?? false,
    isPaneFocused: props.isPaneFocused ?? true,
    leftContent: props.leftContent,
    beforeVoiceContent: props.beforeVoiceContent,
    activeActionContent: props.activeActionContent,
    voiceServerId: props.voiceServerId,
    isAgentRunning: props.isAgentRunning ?? false,
    defaultSendBehavior: props.defaultSendBehavior ?? "interrupt",
    onQueue: props.onQueue,
    onSubmitLoadingPress: props.onSubmitLoadingPress,
    onKeyPressCallback: props.onKeyPress,
    onSelectionChangeCallback: props.onSelectionChange,
    onFocusChange: props.onFocusChange,
    onHeightChange: props.onHeightChange,
    inputWrapperStyle: props.inputWrapperStyle,
    attachmentSlot: props.attachmentSlot,
    inputMode: props.inputMode ?? "chat",
    readOnly: props.readOnly ?? false,
    submitLabel: props.submitLabel,
    submitActions: props.submitActions ?? [],
    onSubmitAction: props.onSubmitAction,
  };
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(
  function MessageInput(props, ref) {
    const {
      value,
      onChangeText,
      onSubmit,
      hasExternalContent,
      allowEmptySubmit,
      submitButtonAccessibilityLabel,
      submitButtonTestID,
      submitIcon,
      isSubmitDisabled,
      isSubmitLoading,
      preserveHeightOnSubmit,
      attachments,
      cwd,
      attachmentMenuItems,
      onAttachButtonRef,
      onPasteFiles,
      client,
      isReadyForDictation,
      placeholder,
      autoFocus,
      autoFocusKey,
      disabled,
      isPaneFocused,
      leftContent,
      beforeVoiceContent,
      activeActionContent,
      voiceServerId,
      isAgentRunning,
      defaultSendBehavior,
      onQueue,
      onSubmitLoadingPress,
      onKeyPressCallback,
      onSelectionChangeCallback,
      onFocusChange,
      onHeightChange,
      inputWrapperStyle,
      attachmentSlot,
      inputMode,
      readOnly,
      submitLabel,
      submitActions,
      onSubmitAction,
    } = resolveMessageInputProps(props);
    const mode = resolveComposerInputMode(inputMode);
    const { onLayout: measureToolbar, isBelow: compactToolbar } = useContainerWidthBelow(600);
    const visibleSubmitLabel = compactToolbar ? undefined : submitLabel;
    const { t } = useTranslation();
    const isCompact = useIsCompactFormFactor();
    const { height: windowHeight } = useWindowDimensions();
    const maxInputHeight = resolveMaxInputHeight(windowHeight);
    const buttonIconSize = isWeb ? ICON_SIZE.md : ICON_SIZE.lg;
    const toast = useToast();
    const dictationToggleKeys = useShortcutKeys("dictation-toggle");
    const focusInputKeys = useShortcutKeys("focus-message-input");
    const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
    const [isInputFocused, setIsInputFocused] = useState(false);
    const rootRef = useRef<View | null>(null);
    const inputWrapperRef = useRef<View | null>(null);
    const textInputRef = useRef<TextInput | (TextInput & { getNativeRef?: () => unknown }) | null>(
      null,
    );
    const isInputFocusedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => {
        textInputRef.current?.focus();
      },
      blur: () => {
        textInputRef.current?.blur?.();
      },
      runKeyboardAction: (action) =>
        runMessageInputKeyboardAction(action, {
          focusInput: () => textInputRef.current?.focus(),
          isDictationRecording: isDictationActive,
          markTranscriptForSend: () => {
            sendAfterTranscriptRef.current = true;
          },
          confirmDictation,
          cancelDictation,
          startDictation: startDictationIfAvailable,
        }),
      getNativeElement: () => (isWeb ? getTextInputNativeElement(textInputRef.current) : null),
    }));
    const inputHeightRef = useRef(MIN_INPUT_HEIGHT);
    const sendAfterTranscriptRef = useRef(false);
    const valueRef = useRef(value);
    const serverInfo = useSessionStore(
      useCallback(
        (state) => {
          if (!voiceServerId) {
            return null;
          }
          return state.sessions[voiceServerId]?.serverInfo ?? null;
        },
        [voiceServerId],
      ),
    );

    useEffect(() => {
      valueRef.current = value;
    }, [value]);

    useEffect(() => {
      return () => {
        onFocusChange?.(false);
      };
    }, [onFocusChange]);

    useAutoFocusOnWebEffect(textInputRef, autoFocus, autoFocusKey);

    const handleDictationTranscript = useCallback(
      (text: string, _meta: { requestId: string }) => {
        const autoSend = sendAfterTranscriptRef.current;
        sendAfterTranscriptRef.current = false;
        applyDictationTranscript(text, {
          value: valueRef.current,
          defaultSendBehavior,
          isAgentRunning,
          onQueue,
          onSubmit,
          onChangeText,
          attachments,
          cwd,
          autoSend,
        });
      },
      [onChangeText, onSubmit, onQueue, attachments, cwd, isAgentRunning, defaultSendBehavior],
    );

    const handleDictationError = useCallback(
      (error: Error) => {
        console.error("[MessageInput] Dictation error:", error);
        toast.error(error.message);
      },
      [toast],
    );

    const dictationUnavailableMessage = resolveVoiceUnavailableMessage({
      serverInfo,
      mode: "dictation",
    });

    const canStartDictation = useCallback(
      () =>
        computeCanStartDictation({
          client,
          isReadyForDictation,
          disabled,
          dictationUnavailableMessage,
        }),
      [client, disabled, dictationUnavailableMessage, isReadyForDictation],
    );

    const canConfirmDictation = useCallback(() => client?.isConnected ?? false, [client]);
    const isConnected = client?.isConnected ?? false;
    const isDictationStartEnabled = computeIsDictationStartEnabled(
      isReadyForDictation,
      isConnected,
      disabled,
    );

    const {
      isRecording: isDictating,
      isRecordingActive: isDictationActive,
      isProcessing: isDictationProcessing,
      partialTranscript: _dictationPartialTranscript,
      volume: dictationVolume,
      duration: dictationDuration,
      error: dictationError,
      status: dictationStatus,
      startDictation,
      cancelDictation,
      confirmDictation,
      retryFailedDictation,
      discardFailedDictation,
    } = useDictation({
      client,
      onTranscript: handleDictationTranscript,
      onError: handleDictationError,
      canStart: canStartDictation,
      canConfirm: canConfirmDictation,
      enableDuration: true,
    });

    const showDictationOverlay = computeShouldShowDictationOverlay(
      isDictating,
      isDictationProcessing,
      dictationStatus,
    );
    const surfacePresentation = resolveComposerSurfacePresentation(showDictationOverlay);

    useEffect(() => {
      if (isDictating || isDictationProcessing) {
        return;
      }
      sendAfterTranscriptRef.current = false;
    }, [dictationStatus, isDictating, isDictationProcessing]);

    const startDictationIfAvailable = useCallback(
      () =>
        startDictationIfAvailableImpl({
          dictationUnavailableMessage,
          canStartDictation,
          toast,
          startDictation,
        }),
      [canStartDictation, dictationUnavailableMessage, startDictation, toast],
    );

    const handleDictationPress = useCallback(
      () =>
        handleDictationPressImpl({
          isDictating,
          cancelDictation,
          startDictationIfAvailable,
        }),
      [cancelDictation, isDictating, startDictationIfAvailable],
    );

    const handleCancelRecording = useCallback(async () => {
      await cancelDictation();
    }, [cancelDictation]);

    const handleAcceptRecording = useCallback(async () => {
      sendAfterTranscriptRef.current = false;
      await confirmDictation();
    }, [confirmDictation]);

    const handleAcceptAndSendRecording = useCallback(async () => {
      sendAfterTranscriptRef.current = true;
      await confirmDictation();
    }, [confirmDictation]);

    const handleRetryFailedRecording = useCallback(() => {
      void retryFailedDictation();
    }, [retryFailedDictation]);

    const handleDiscardFailedRecording = useCallback(() => {
      discardFailedDictation();
    }, [discardFailedDictation]);

    const minimizeInputHeight = useCallback(() => {
      inputHeightRef.current = MIN_INPUT_HEIGHT;
      setInputHeight(MIN_INPUT_HEIGHT);
      onHeightChange?.(MIN_INPUT_HEIGHT);
    }, [onHeightChange]);

    const handleSendMessage = useCallback(
      () =>
        sendMessageImpl({
          value: valueRef.current,
          attachments,
          hasExternalContent,
          allowEmptySubmit,
          cwd,
          isAgentRunning,
          onSubmit,
          onMinimizeHeight: minimizeInputHeight,
          preserveHeightOnSubmit,
        }),
      [
        allowEmptySubmit,
        attachments,
        cwd,
        onSubmit,
        isAgentRunning,
        hasExternalContent,
        minimizeInputHeight,
        preserveHeightOnSubmit,
      ],
    );

    const handleSubmitAction = useCallback(
      (actionId: string) => {
        if (!onSubmitAction) return;
        sendMessageImpl({
          value: valueRef.current,
          attachments,
          hasExternalContent,
          allowEmptySubmit,
          cwd,
          isAgentRunning,
          onSubmit: (payload) => onSubmitAction(actionId, payload),
          onMinimizeHeight: minimizeInputHeight,
          preserveHeightOnSubmit,
        });
      },
      [
        allowEmptySubmit,
        attachments,
        cwd,
        hasExternalContent,
        isAgentRunning,
        minimizeInputHeight,
        onSubmitAction,
        preserveHeightOnSubmit,
      ],
    );

    const handleQueueMessage = useCallback(
      () =>
        queueMessageImpl({
          value: valueRef.current,
          attachments,
          cwd,
          onQueue,
          onChangeText,
          onMinimizeHeight: minimizeInputHeight,
        }),
      [attachments, cwd, onQueue, onChangeText, minimizeInputHeight],
    );

    const handleDefaultSendAction = useCallback(() => {
      const defaultAction = submitActions.find((action) => action.isDefault) ?? submitActions[0];
      if (defaultAction && onSubmitAction) {
        handleSubmitAction(defaultAction.id);
        return;
      }
      runDefaultSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [
      defaultSendBehavior,
      handleQueueMessage,
      handleSendMessage,
      handleSubmitAction,
      isAgentRunning,
      onQueue,
      onSubmitAction,
      submitActions,
    ]);

    const handleAlternateSendAction = useCallback(() => {
      runAlternateSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, handleSendMessage, handleQueueMessage, onQueue]);

    const getWebTextArea = useCallback(
      (): TextAreaHandle | null => getWebTextAreaImpl(textInputRef.current),
      [],
    );

    const webTextareaRef = useRef<HTMLElement | null>(null);

    useLayoutEffect(() => {
      if (isWeb) {
        webTextareaRef.current = getWebTextArea() as HTMLElement | null;
      }
    }, [getWebTextArea]);

    usePasteFilesEffect({
      getWebTextArea,
      isConnected,
      disabled,
      isDictating,
      onPasteFiles,
    });

    const setBoundedInputHeight = useCallback(
      (nextHeight: number) => {
        const bounded = Math.max(MIN_INPUT_HEIGHT, Math.min(maxInputHeight, nextHeight));
        if (Math.abs(inputHeightRef.current - bounded) < 1) return;
        inputHeightRef.current = bounded;
        setInputHeight(bounded);
        onHeightChange?.(bounded);
      },
      [maxInputHeight, onHeightChange],
    );

    useEffect(() => {
      setBoundedInputHeight(inputHeightRef.current);
    }, [setBoundedInputHeight]);

    useComposerHeightMirror({
      value,
      textareaRef: webTextareaRef,
      minHeight: MIN_INPUT_HEIGHT,
      maxHeight: maxInputHeight,
      onHeight: setBoundedInputHeight,
    });

    const handleContentSizeChange = useCallback(
      (event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
        if (isWeb) return;
        setBoundedInputHeight(event.nativeEvent.contentSize.height);
      },
      [setBoundedInputHeight],
    );

    const handleSelectionChange = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const start = event.nativeEvent.selection?.start ?? 0;
        const end = event.nativeEvent.selection?.end ?? start;
        onSelectionChangeCallback?.({ start, end });
      },
      [onSelectionChangeCallback],
    );

    const shouldHandleWebKeyPress = isWeb;
    const shouldSubmitOnEnter = isWeb && !isCompact;

    function handleDesktopKeyPress(event: WebTextInputKeyPressEvent) {
      if (!shouldHandleWebKeyPress) return;
      handleDesktopKeyPressImpl(event, {
        onKeyPressCallback,
        submitOnEnter: shouldSubmitOnEnter,
        isAgentRunning,
        onQueue,
        isSubmitDisabled,
        isSubmitLoading,
        disabled,
        handleAlternateSendAction,
        handleDefaultSendAction,
      });
    }

    const primaryActionKind = resolvePrimaryActionKind({
      hasSendableContent: hasSendableComposerContent({
        value,
        attachments,
        hasExternalContent,
      }),
      allowEmptySubmit,
      isAgentRunning,
      isSubmitLoading,
    });
    const { canPressLoadingButton, isSendButtonDisabled, defaultActionQueues } =
      computeSendButtonState({
        disabled,
        isSubmitDisabled,
        isSubmitLoading,
        onSubmitLoadingPress,
        defaultSendBehavior,
        isAgentRunning,
      });
    useIosHardwareKeyboardSubmit({
      isEnabled: isInputFocused && !isSendButtonDisabled,
      onSubmit: handleDefaultSendAction,
    });
    const submitAccessibilityLabel = resolveSubmitAccessibilityLabel({
      submitButtonAccessibilityLabel,
      canPressLoadingButton,
      defaultActionQueues,
      isAgentRunning,
      t,
    });

    const dictationButtonAccessibilityLabel = resolveDictationAccessibilityLabel({
      isDictating,
      t,
    });
    const dictationTooltipText = t("composer.voice.dictation");

    const sendTooltipLabel = resolveSendTooltipLabel({
      submitButtonAccessibilityLabel,
      defaultActionQueues,
      t,
    });

    const handleInputChange = useCallback(
      (nextValue: string) => {
        valueRef.current = nextValue;
        onChangeText(nextValue);
      },
      [onChangeText],
    );

    const handleInputFocus = useCallback(() => {
      isInputFocusedRef.current = true;
      setIsInputFocused(true);
      onFocusChange?.(true);
    }, [onFocusChange]);

    const handleInputBlur = useCallback(() => {
      isInputFocusedRef.current = false;
      setIsInputFocused(false);
      onFocusChange?.(false);
    }, [onFocusChange]);

    const attachButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.attachButton,
        Boolean(hovered) && styles.iconButtonHovered,
        (!isConnected || disabled) && styles.buttonDisabled,
      ],
      [isConnected, disabled],
    );

    const dictationButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.dictationButton,
        Boolean(hovered) && !isDictating && styles.iconButtonHovered,
        !isDictationStartEnabled && styles.buttonDisabled,
        isDictating && styles.dictationButtonRecording,
      ],
      [isDictating, isDictationStartEnabled],
    );

    const inputWrapperCombinedStyle = useMemo(
      () => [
        styles.inputWrapper,
        readOnly && styles.inputWrapperReadOnly,
        inputWrapperStyle,
        { opacity: surfacePresentation.input.opacity },
      ],
      [inputWrapperStyle, readOnly, surfacePresentation.input.opacity],
    );
    // `withUnistyles` maps this component's `style` into a `.hash > *` child
    // rule, which ties on specificity with react-native-web's own
    // `.css-textinput-*` class and loses on source order — so a themed
    // `fontFamily` here is silently dropped while every other property lands.
    // An inline style outranks both classes. See docs/unistyles.md.
    const textInputStyle = useMemo(
      () => [
        styles.textInput,
        mode.isMonospace && styles.textInputMonospace,
        computeTextInputHeightStyle(inputHeight, maxInputHeight),
      ],
      [inputHeight, maxInputHeight, mode.isMonospace],
    );
    // Static content has no textarea to mirror, so it grows with its own text
    // instead of the measured input height.
    const readOnlyTextStyle = useMemo(
      () => [styles.textInput, mode.isMonospace && styles.textInputMonospace, styles.readOnlyText],
      [mode.isMonospace],
    );
    const sendButtonCombinedStyle = useMemo(
      () => [
        styles.sendButton,
        visibleSubmitLabel ? styles.sendButtonLabeled : undefined,
        isSendButtonDisabled && styles.buttonDisabled,
      ],
      [isSendButtonDisabled, visibleSubmitLabel],
    );
    const overlayContainerStyle = useMemo(
      () => [styles.overlayContainer, { opacity: surfacePresentation.overlay.opacity }],
      [surfacePresentation.overlay.opacity],
    );

    const renderAttachButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <AttachButtonIcon
          hovered={Boolean(hovered)}
          onAttachButtonRef={onAttachButtonRef}
          buttonIconSize={buttonIconSize}
        />
      ),
      [onAttachButtonRef, buttonIconSize],
    );

    const renderDictationButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <DictationButtonIcon
          hovered={Boolean(hovered)}
          isDictating={isDictating}
          buttonIconSize={buttonIconSize}
        />
      ),
      [isDictating, buttonIconSize],
    );

    return (
      <View ref={rootRef} style={styles.container} testID="message-input-root">
        {/* Regular input */}
        <View
          ref={inputWrapperRef}
          style={inputWrapperCombinedStyle}
          pointerEvents={surfacePresentation.input.pointerEvents}
        >
          {attachmentSlot}
          {/* Text input */}
          <ComposerTextSurface
            readOnly={readOnly}
            value={value}
            textInputRef={textInputRef}
            textInputStyle={textInputStyle}
            readOnlyTextStyle={readOnlyTextStyle}
            placeholder={placeholder ?? t("composer.placeholders.fallback")}
            accessibilityLabel={t(mode.accessibilityLabelKey)}
            onChangeText={handleInputChange}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            editable={!isDictating && !disabled}
            scrollEnabled={isWeb ? inputHeight >= maxInputHeight : true}
            autoFocus={isWeb && autoFocus}
            onContentSizeChange={handleContentSizeChange}
            onKeyPress={shouldHandleWebKeyPress ? handleDesktopKeyPress : undefined}
            onSelectionChange={handleSelectionChange}
            focusHintVisible={isWeb && isPaneFocused && !isInputFocused && !value}
            focusInputKeys={focusInputKeys}
            focusHintLabel={t("composer.input.focusHint", {
              shortcut: focusInputKeys ? formatShortcut(focusInputKeys[0], getShortcutOs()) : "",
            })}
          />

          {/* Button row */}
          <View style={styles.buttonRow} onLayout={measureToolbar}>
            {/* Toolbar left: attachment button + agent controls */}
            <View style={styles.leftButtonGroup}>
              <AttachmentDropdown
                visible={mode.showAttachments}
                isConnected={isConnected}
                disabled={disabled}
                attachButtonStyle={attachButtonStyle}
                renderAttachButtonIcon={renderAttachButtonIcon}
                attachmentMenuItems={attachmentMenuItems}
                addAttachmentLabel={t("composer.input.addAttachment")}
              />
              <CompactComposerToolbarContext.Provider value={compactToolbar}>
                {leftContent}
              </CompactComposerToolbarContext.Provider>
            </View>

            {/* Right: dictation button, contextual button (send/cancel) */}
            <View style={styles.rightButtonGroup}>
              {beforeVoiceContent}
              <DictationButtonTooltip
                visible={mode.showVoice}
                onDictationPress={handleDictationPress}
                isDictationStartEnabled={isDictationStartEnabled}
                dictationButtonAccessibilityLabel={dictationButtonAccessibilityLabel}
                dictationButtonStyle={dictationButtonStyle}
                renderDictationButtonIcon={renderDictationButtonIcon}
                dictationTooltipText={dictationTooltipText}
                dictationToggleKeys={dictationToggleKeys}
              />
              <PrimaryAction
                kind={primaryActionKind}
                activeActionContent={activeActionContent}
                submitActions={submitActions}
                onSubmitAction={handleSubmitAction}
                shouldShow
                canPressLoadingButton={canPressLoadingButton}
                onSubmitLoadingPress={onSubmitLoadingPress}
                onDefaultSendAction={handleDefaultSendAction}
                isSendButtonDisabled={isSendButtonDisabled}
                submitAccessibilityLabel={submitAccessibilityLabel}
                sendButtonCombinedStyle={sendButtonCombinedStyle}
                isSubmitLoading={isSubmitLoading}
                submitIcon={submitIcon}
                submitLabel={visibleSubmitLabel}
                submitButtonTestID={submitButtonTestID}
                buttonIconSize={buttonIconSize}
                sendKeys={DEFAULT_SEND_KEYS}
                sendTooltipLabel={sendTooltipLabel}
              />
            </View>
          </View>
        </View>

        <View
          style={overlayContainerStyle}
          pointerEvents={surfacePresentation.overlay.pointerEvents}
        >
          <MessageInputOverlay
            showDictationOverlay={showDictationOverlay}
            dictationVolume={dictationVolume}
            dictationDuration={dictationDuration}
            isDictating={isDictating}
            isDictationProcessing={isDictationProcessing}
            dictationStatus={dictationStatus}
            dictationError={dictationError}
            onCancelRecording={handleCancelRecording}
            onAcceptRecording={handleAcceptRecording}
            onAcceptAndSendRecording={handleAcceptAndSendRecording}
            onRetryFailedRecording={handleRetryFailedRecording}
            onDiscardFailedRecording={handleDiscardFailedRecording}
          />
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    position: "relative",
  },
  inputWrapper: {
    flexDirection: "column",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingTop: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
    // Optical, not arithmetic: the toolbar's icon buttons hold their glyphs 6px inside a 28px
    // box, so an equal bottom padding reads as more room under the row than above the text.
    // One step down puts the ink on matching rails.
    paddingBottom: {
      xs: theme.spacing[2],
      md: theme.spacing[3],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    ...(isWeb
      ? {
          transitionProperty: "border-color",
          transitionDuration: "200ms",
          transitionTimingFunction: "ease-in-out",
        }
      : {}),
  },
  // Dotted says "this surface is the same box, but there is nothing to type
  // into it" without swapping the border colour, which reads as an error state.
  inputWrapperReadOnly: {
    borderStyle: "dotted",
  },
  textInputScrollWrapper: {
    position: "relative",
  },
  focusHintText: {
    position: "absolute",
    top: 0,
    right: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    opacity: 0.5,
  },
  textInput: {
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: theme.fontSize.base * 1.4,
    ...(isWeb
      ? ({
          outlineStyle: "none",
          outlineWidth: 0,
          outlineColor: "transparent",
        } as object)
      : {}),
  },
  textInputMonospace: {
    fontFamily: theme.fontFamily.mono,
  },
  readOnlyText: {
    minHeight: MIN_INPUT_HEIGHT,
    color: theme.colors.foregroundMuted,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginHorizontal: -6,
  },
  leftButtonGroup: {
    minWidth: 0,
    flexShrink: 1,
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[0],
  },
  rightButtonGroup: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  submitActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  submitActionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  attachButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  attachButtonAnchor: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  dictationButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  dictationButtonRecording: {
    backgroundColor: theme.colors.destructive,
  },
  sendButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: theme.spacing[1],
  },
  sendButtonLabeled: {
    width: "auto",
    minWidth: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
  },
  sendButtonLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  overlayContainer: {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    right: 0,
    bottom: 0,
  },
})) as unknown as Record<string, object>;

const ThemedPlus = withUnistyles(Plus);
const ThemedMic = withUnistyles(Mic);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedCornerDownLeft = withUnistyles(CornerDownLeft);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedTextInput = withUnistyles(TextInput);

const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconAccentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const textInputPlaceholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.surface4,
});
