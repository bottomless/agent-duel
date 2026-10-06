const testTheme = {
  colorScheme: "light",
  colors: {
    foreground: "#111111",
    foregroundMuted: "#666666",
    statusSuccess: "#15803d",
    statusDanger: "#b91c1c",
    statusWarning: "#d97706",
    statusMerged: "#7c3aed",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    border: "#e4e4e7",
    borderAccent: "#d4d4d8",
    destructive: "#b91c1c",
    success: "#15803d",
    surface0: "#ffffff",
    foregroundExtraMuted: "#a1a1aa",
    diffAddition: "#dcfce7",
    diffDeletion: "#fee2e2",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    destructiveForeground: "#ffffff",
    surface3: "#e4e4e7",
    statusDotRunning: "#268ae0",
    statusDotWarning: "#b37824",
    syntax: {
      keyword: "#7c3aed",
      comment: "#6b7280",
      string: "#15803d",
      number: "#b45309",
      literal: "#b45309",
      function: "#2563eb",
      definition: "#2563eb",
      class: "#0f766e",
      type: "#0f766e",
      tag: "#b91c1c",
      attribute: "#b45309",
      property: "#111111",
      variable: "#111111",
      operator: "#111111",
      punctuation: "#666666",
      regexp: "#15803d",
      escape: "#b45309",
      meta: "#666666",
      heading: "#111111",
      link: "#2563eb",
    },
  },
  spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    code: 12,
  },
  lineHeight: { diff: 22 },
  fontFamily: {
    mono: "monospace",
  },
  borderWidth: [0, 1, 2],
  fontWeight: {
    normal: "400",
    medium: "500",
    semibold: "600",
  },
  borderRadius: {
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    full: 9999,
  },
  opacity: { 50: 0.5 },
};

type StyleFactory<T> = (theme: typeof testTheme) => T;

function isStyleFactory<T>(styles: T | StyleFactory<T>): styles is StyleFactory<T> {
  return typeof styles === "function";
}

export const StyleSheet = {
  create: <T>(styles: T | StyleFactory<T>): T =>
    isStyleFactory(styles) ? styles(testTheme) : styles,
};

export const withUnistyles = <T>(Component: T): T => Component;

export const useUnistyles = () => ({
  theme: testTheme,
  rt: {},
  breakpoint: undefined,
});

export const UnistylesRuntime = {
  setTheme: () => undefined,
  themeName: "light",
};
