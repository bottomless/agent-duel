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
export const appearanceStyleBoundaryMapping = (
  theme: Theme,
): Partial<AppearanceStyleBoundaryProps> => ({
  appearanceKey: [
    theme.fontFamily.ui,
    theme.fontFamily.mono,
    theme.fontSize.xs,
    theme.fontSize.sm,
    theme.fontSize.base,
    theme.fontSize.lg,
    theme.fontSize.xl,
    theme.fontSize["2xl"],
    theme.fontSize["3xl"],
    theme.fontSize["4xl"],
    theme.fontSize.code,
    theme.lineHeight.diff,
    theme.colors.foreground,
    theme.colors.foregroundMuted,
    theme.colors.mutedForeground,
    theme.colors.surface1,
    theme.colors.surface2,
    theme.colors.border,
    theme.colors.accentBright,
  ].join("\u0000"),
});

const ThemedAppearanceStyleBoundary = withUnistyles(AppearanceStyleBoundaryBase);

export function AppearanceStyleBoundary({ children }: { children: ReactNode }) {
  return (
    <ThemedAppearanceStyleBoundary uniProps={appearanceStyleBoundaryMapping}>
      {children}
    </ThemedAppearanceStyleBoundary>
  );
}
