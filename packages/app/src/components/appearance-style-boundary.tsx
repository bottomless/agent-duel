import { Component, Fragment, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  captureAppearancePosition,
  restoreAppearancePosition,
  type AppearancePosition,
} from "./appearance-position";
import type { Theme } from "@/styles/theme";

interface AppearanceStyleBoundaryProps {
  appearanceKey?: string;
  children: ReactNode;
}

// Remounts its children when an appearance token changes. Memoized and parsed content bakes
// tokens in, and on web numeric tokens (font sizes, line heights) are baked into generated
// classes that only a re-render refreshes. Native tracked styles update in place.
// Keep native gesture hosts outside these keys too: shared gesture refs can outlive detached
// dependent views until passive cleanup. It must sit below every native navigator: remounting
// a navigator while settings hydrate
// detaches its screen container inside a FragmentManager transaction and crashes Android.
// `ThemedStack` places one per screen; the app shell places them around the chrome outside the
// navigators.
class AppearanceStyleBoundaryBase extends Component<AppearanceStyleBoundaryProps> {
  private restoreFrame: number | null = null;

  getSnapshotBeforeUpdate(previous: AppearanceStyleBoundaryProps): AppearancePosition | null {
    return previous.appearanceKey !== this.props.appearanceKey ? captureAppearancePosition() : null;
  }

  componentDidUpdate(
    _previous: AppearanceStyleBoundaryProps,
    _state: unknown,
    position: AppearancePosition | null,
  ) {
    if (!position) return;
    restoreAppearancePosition(position);
    if (this.restoreFrame !== null) cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = requestAnimationFrame(() => {
      restoreAppearancePosition(position);
      this.restoreFrame = null;
    });
  }

  componentWillUnmount() {
    if (this.restoreFrame !== null) cancelAnimationFrame(this.restoreFrame);
  }

  render() {
    return <Fragment key={this.props.appearanceKey}>{this.props.children}</Fragment>;
  }
}

// Syntax colors are deliberately excluded here. They repaint through
// syntaxTokenStyles (Unistyles-tracked, no re-render needed), so including
// them would remount the whole app subtree on every highlight-theme change
// and reset scroll position everywhere a ScrollView sits below this boundary
// (e.g. Settings).
export function appearanceStyleBoundaryKey(theme: Theme): string {
  return [
    theme.fontFamily.ui,
    theme.fontFamily.mono,
    theme.fontSize.sm,
    theme.fontSize.base,
    theme.fontSize.lg,
    theme.fontSize.xl,
    theme.fontSize["2xl"],
    theme.fontSize["3xl"],
    theme.fontSize["4xl"],
    theme.fontSize.content,
    theme.fontSize.code,
    theme.lineHeight.diff,
    theme.colors.foreground,
    theme.colors.foregroundMuted,
    theme.colors.mutedForeground,
    theme.colors.surface1,
    theme.colors.surface2,
    theme.colors.border,
    theme.colors.accentBright,
  ].join("\u0000");
}

function appearanceStyleBoundaryMapping(theme: Theme): Partial<AppearanceStyleBoundaryProps> {
  return { appearanceKey: appearanceStyleBoundaryKey(theme) };
}

const ThemedAppearanceStyleBoundary = withUnistyles(AppearanceStyleBoundaryBase);

export function AppearanceStyleBoundary({ children }: { children: ReactNode }) {
  return (
    <ThemedAppearanceStyleBoundary uniProps={appearanceStyleBoundaryMapping}>
      {children}
    </ThemedAppearanceStyleBoundary>
  );
}
