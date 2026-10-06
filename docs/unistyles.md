# Unistyles Gotchas

This app uses [`react-native-unistyles` v3](https://www.unistyl.es/) for theme-aware styles. Unistyles is fast because most style updates do not go through React renders: the [Babel plugin](https://www.unistyl.es/v3/other/babel-plugin) rewrites React Native component imports, attaches style metadata, and lets the native ShadowRegistry update tracked views when theme or runtime dependencies change.

Agent Duel uses the web runtime in browser and Electron. ShadowRegistry, iOS,
and Android sections retain upstream implementation history; they do not add
native targets. The hook restriction and web style rules below govern new work.

## STOP — `useUnistyles()` Is Banned

**Do not call `useUnistyles()`. Anywhere. New code MUST NOT add a call; existing call sites are tolerated only because nobody has rewritten them yet and will be converted as they are touched.** The library authors themselves [strongly advise against it](https://www.unistyl.es/v3/references/use-unistyles):

> We strongly recommend **not using** this hook, as it will re-render your component on every change. This hook was created to simplify the migration process and should only be used when other methods fail.

This hook has caused repeated render regressions in the shared app. The hook subscribes the component to **every** Unistyles runtime change (theme, breakpoint, insets, color scheme, scale) and returns a fresh object reference each call. That means a periodic lockstep re-render of warm subtrees (agent streams, panels, sidebars) even when nothing the user can see has changed — confirmed in profiling, with `theme` as the only changed input every cycle. It also breaks every downstream `useMemo`/`memo` boundary that includes a derived theme value.

Do not introduce a new `useUnistyles()` call. If the alternatives below do not
solve the case, report the blocking library issue instead of adding the hook.

Use these alternatives in order:

### 1. `StyleSheet.create((theme) => ...)` — default

Most theme-aware styling needs nothing else. The Babel plugin tracks theme dependencies inside the factory and updates the native ShadowTree without any React re-render.

```tsx
const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[4],
  },
}));

<View style={styles.container} />;
```

If you are reading a theme value just to feed it back into a `style` prop, you almost certainly want this and not the hook.

### 2. Hard-coded constants for genuinely static values

If you only need a number that happens to live on the theme (e.g. a fixed spacing value used to compute a gap or animation distance), use a literal constant or import a static module. Static reads do not need a subscription. See the "Static Theme Imports" section below — importing `baseColors`, theme-name constants, or `type Theme` is fine when the value is intentionally static.

### 3. `withUnistyles(Component)` for third-party props

When a third-party component takes a non-`style` prop that must be theme-reactive (e.g. `BlurView.tint`, `Image.tintColor`, navigator option props, bottom-sheet `backgroundStyle`), wrap that single component with `withUnistyles`. Only the wrapper re-renders, not the surrounding tree.

```tsx
const ThemedBlur = withUnistyles(BlurView);
<ThemedBlur tint={theme.colors.surface0} />;
```

(Mind the `> *` child-selector leak documented further down.)

### 4. There is no "last resort"

There is no escape hatch. If none of (1)–(3) fit, the problem is upstream — fix it there or file an issue. The hook is not on the table.

## How Updates Propagate

For standard React Native components, the [Unistyles Babel plugin](https://www.unistyl.es/v3/other/babel-plugin) rewrites imports such as `View`, `Text`, `Pressable`, and `ScrollView` to Unistyles-aware component factories. On native, those factories borrow the component ref and register the `style` prop with the ShadowRegistry. The upstream ["Why my view doesn't update?"](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update) guide describes this as the ShadowTree update path that avoids unnecessary React re-renders.

The important detail: the automatic native path tracks `props.style`. It does not generally track every prop that happens to carry style-like values.

### Do Not Materialize Styles At Module Scope

Never read a Unistyles style property into a module-level constant. This includes cached arrays:

```tsx
// Wrong: evaluated while the app may still be using the temporary system theme.
const ROW_STYLE = [settingsStyles.row, settingsStyles.rowBorder];

// Right: each style proxy is read when this view renders.
<View style={[settingsStyles.row, settingsStyles.rowBorder]} />;
```

The app starts with adaptive themes, then applies the persisted theme after async settings load. A
module-level read can therefore materialize the light style before a persisted dark theme is
active. If the view mounts after that theme change, React Native receives the stale light object;
Unistyles registers the node for future changes but does not retroactively replace its initial
props. Settings dividers once rendered light `#e4e4e7` inside a dark `#252B2A` card for exactly
this reason.

Render-time array syntax is intentional and exempt from the app's JSX array-allocation lint rule.
Keep the entries separate so each retains its Unistyles metadata. If composition is needed outside
JSX, create the array inside the component or in a `useMemo` that first runs when the component
mounts—never at module evaluation time.

For theme-dependent React props, use the leaf `withUnistyles` boundary described
above. Direct reads from `UnistylesRuntime` do not subscribe a component to theme
changes; [issue #817](https://github.com/jpudysz/react-native-unistyles/issues/817)
records that limitation.

## Dynamic Pixel Styles On Web

Avoid feeding changing pixel values such as `{ top, left }`, `{ maxHeight }`, or `{ minWidth }` into the `style` prop of Unistyles-managed React Native components on web. The web runtime hashes each distinct style object by value and appends a CSS rule to `#unistyles-web`; those rules are not reclaimed during the page lifetime, so pointer-driven positioning can turn into steady stylesheet growth.

Use the inline style escape hatch below for high-churn values. Do not split a component into plain/web/native variants just to keep one measured value out of the CSS registry. Raw DOM wrappers are reserved for real DOM infrastructure, such as terminal hosts, virtualized web rows, or third-party drag wrappers.

## Inline Style Escape Hatch

When a style value is high-churn and must bypass Unistyles' CSS registry, keep the component on the normal Unistyles path and mark only that style object with `inlineUnistylesStyle`.

```tsx
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const styles = StyleSheet.create({
  thumb: {
    position: "absolute",
  },
});

<View style={[styles.thumb, inlineUnistylesStyle({ height, transform: [{ translateY }] })]} />;
```

This uses Unistyles' own animated-style lane: ordinary styles still become Unistyles classes, while the marked style object stays in React Native's inline style array. Use it for measured geometry, scroll or drag transforms, and pressed/hovered/open state where generating CSS classes is the wrong ownership boundary.

Do not split a component into plain and Unistyles variants just to handle one high-churn value. The component remains a normal Unistyles component; only the specific style object escapes.

When a reusable component has a prop whose whole job is dynamic geometry, make that prop the seam. For example, `FloatingSurface.frameStyle` and `FloatingScrollView.style` own their own escape hatch so menu, tooltip, hover-card, and combobox callers can stay declarative instead of knowing about Unistyles internals.

Do not flatten a caller-provided style array and pass the flattened object back to a React Native component. Unistyles style entries carry `unistyles_*` metadata; flattening two entries produces one object with multiple metadata keys and triggers the runtime warning: "use array syntax instead of object syntax." Preserve caller styles as arrays, and only flatten the dynamic geometry value you explicitly own. If that owned value was flattened from a mixed style prop, strip `unistyles_*` metadata before sending it through `inlineUnistylesStyle`.

Do not register an existing Unistyles style inside another `StyleSheet.create` either. That also combines two metadata identities into one object. Reuse the original style directly at the component:

```tsx
// Wrong: sharedStyles.row already carries Unistyles metadata.
const styles = StyleSheet.create({ row: sharedStyles.row });
<View style={styles.row} />;

// Right: one registered style identity reaches the native view.
<View style={sharedStyles.row} />;
```

This mistake once produced tens of thousands of warnings from retained sidebar rows. Because React Native captures component stacks for warnings, the warning loop itself can consume enough CPU and memory to make the app appear blank.

## Main Gotcha: `contentContainerStyle`

`ScrollView.contentContainerStyle` is the canonical trap. It looks like a style prop, but it is not the `style` prop Unistyles registers. How badly that bites depends on who owns the component:

- **A remapped React Native `ScrollView`** still picks the style up — the Babel plugin rewrites the import and the factory tracks `contentContainerStyle` alongside `style`. The failure mode here is staleness: on first mount it can paint with the theme that was active at mount time and never repaint. The upstream tutorial calls this out in its [ScrollView Background Issue](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue) section.
- **A third-party scroller** — `BottomSheetScrollView`, `FlashList`, anything Unistyles never rewrote — drops the style entirely on web. Nothing throws and the value looks right in JS, but the class Unistyles emitted is never applied, so the padding, gap, or background is simply absent. `AdaptiveModalSheet` shipped its compact sheet content flush to the screen edges for exactly this reason while the desktop card, which uses a real `ScrollView`, looked correct.

The second case is why the wrapper-`View` fix below is not optional styling advice. A themed inset belongs on a `View` you own; a third-party scroller only gets theme-free layout.

Avoid this pattern when the style depends on the theme:

```tsx
<ScrollView contentContainerStyle={styles.container} />;

const styles = StyleSheet.create((theme) => ({
  container: {
    flexGrow: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
```

If app settings later load a persisted theme and call [`UnistylesRuntime.setTheme`](https://www.unistyl.es/v3/guides/theming#change-theme), the JS-side style proxy reports the new theme while the native content container keeps the old background. That is how the welcome screen ended up with a light background and dark foreground/buttons.

This applies broadly to non-`style` props that carry theme-dependent values, such as component props named `color`, `trackColor`, `tintColor`, `backgroundStyle`, `handleIndicatorStyle`, and other library-specific style props. The [3rd-party view decision algorithm](https://www.unistyl.es/v3/references/3rd-party-views) recommends explicit handling for these cases, and [issue #1030](https://github.com/jpudysz/react-native-unistyles/issues/1030) shows a related native-prop update edge case around `Image.tintColor`. Treat these values as React props unless wrapped with `withUnistyles`.

## Fix Patterns

Preferred pattern: put themed backgrounds on a normal wrapper view, and keep `contentContainerStyle` theme-free.

```tsx
<View style={styles.container}>
  <ScrollView contentContainerStyle={styles.contentContainer}>{children}</ScrollView>
</View>;

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    flexGrow: 1,
    padding: theme.spacing[4],
  },
}));
```

This is the pattern used by the settings screen: the screen background lives on a normal `View style={styles.container}`, while the scroll content container only carries layout.

In practice the wrapper-`View` pattern is the one we use. Across the app, `withUnistyles` is now reserved for wrapping leaf components — mostly lucide icons (`ThemedActivityIndicator`, `ThemedChevronDown`, …) and small third-party components like `MarkdownWithStableRenderer` — so they pick up theme-reactive `color`/`tintColor` props without re-rendering their parent.

In principle, [`withUnistyles`](https://www.unistyl.es/v3/references/with-unistyles) can also wrap a `ScrollView` to make `contentContainerStyle` theme-reactive via its [auto-mapping behavior for `style` and `contentContainerStyle`](https://www.unistyl.es/v3/references/with-unistyles#auto-mapping-for-style-and-contentcontainerstyle-props). We previously did this on the welcome screen and hit the `> *` child-selector leak documented below; we have since moved the welcome screen to the wrapper-`View` pattern. If you find yourself reaching for `withUnistyles(ScrollView)`, treat it as a smell and check whether a wrapper view works first.

## `withUnistyles` And The `> *` Child-Selector Leak

`withUnistyles` on a component with a theme-dependent `style` prop works by wrapping the component in a `<div style={{display: 'contents'}} className={hash}>` and emitting the style under a `.hash > *` child selector so the styles cascade onto the wrapped component. This is how auto-mapping for `style` and `contentContainerStyle` works on web.

The sharp edge: Unistyles hashes styles by value. If `withUnistyles` receives a style whose value is **identical** to a style used elsewhere in the app on a plain `View`, both usages get the same hash — and both CSS rules (the element rule and the `> *` child rule) are emitted under the same class name. The `> *` rule then leaks onto the direct children of every `View` that shares the hash.

Concrete regression we hit: `welcome-screen.tsx` had `const ThemedScrollView = withUnistyles(ScrollView)` with `style={{ flex: 1, backgroundColor: theme.colors.surface0 }}`. `panels/agent-panel.tsx` had `root` and `container` styles with the exact same value. All three collided on class `unistyles_j2k2iilhfz`, so the browser stylesheet contained:

```css
.unistyles_j2k2iilhfz {
  flex: 1 1 0%;
  background-color: var(--colors-surface0);
}
.unistyles_j2k2iilhfz > * {
  flex: 1 1 0%;
  background-color: var(--colors-surface0);
}
```

The child-selector rule forced `flex:1` and `background-color: surface0` onto the Composer's outer `Animated.View` (a direct child of `container`), stretching it to fill remaining space and leaving a large empty gap between the composer UI and the bottom of the screen. It also painted a `surface0` band behind the scroll-to-bottom button. The bug only appeared in the browser — Electron skips `WelcomeScreen` after pairing, so the `> *` rule was never injected there.

Symptoms to watch for:

- A sibling of a themed panel-background `View` stretches unexpectedly on web only.
- Random direct children of a `{ flex: 1, backgroundColor: surface0 }` `View` pick up an unexpected background.
- DevTools shows a `.unistyles_xxx > *` rule you did not write.

Quick confirmation in DevTools console:

```js
[...document.styleSheets]
  .flatMap((s) => [...(s.cssRules || [])])
  .map((r) => r.cssText)
  .filter((t) => t.includes("unistyles") && t.includes("> *"));
```

Any match beyond benign `r-pointerEvents-* > *` rules from react-native-web is a leak.

Avoid the bug by preferring the wrapper-`View` pattern from the previous section whenever possible: put `{ flex: 1, backgroundColor: surface0 }` on a plain `View` and give the `ScrollView` a theme-free `style`/`contentContainerStyle`. That keeps `withUnistyles` off the hot path and avoids the hash collision. Only reach for `withUnistyles(ScrollView)` when a wrapper view is genuinely awkward, and when you do, give the wrapped style a distinctive shape (extra key, different layout) so it does not hash-collide with a common panel background used elsewhere.

## Hidden Sheet Content

`@gorhom/bottom-sheet` can keep `BottomSheetModal` content mounted while the sheet is hidden. That matters during the app's startup theme transition: a header node can be created under the initial adaptive theme, stay hidden, then appear later with stale native style values even though surrounding content has re-rendered correctly.

The historical `AdaptiveModalSheet` failure left a title in its initial light
color while the body had updated to the dark theme. Keep layout and typography
in `StyleSheet.create`; use the themed wrapper or leaf `withUnistyles` patterns
above for values that need a React prop update. Do not copy older hook-based
workarounds into new code.

## Memoized Style Objects

When a third-party library receives a plain style object, it is outside Unistyles' native tracking path. Make sure any memo that builds that style object depends on the actual theme values it reads.

Use the actual theme values supplied to a themed leaf boundary as memo
dependencies. An indirect runtime key such as the theme name can miss an adaptive
light/dark update and leave the third-party style object stale. Assistant markdown
previously kept dark text styles after the surrounding workspace became light.

Keep the existing leaf `withUnistyles` boundary responsible for theme updates.
If a style factory is cheap, it does not need `useMemo`. Do not introduce a
`useUnistyles()` subscription to build the object.

## Static Theme Imports

Do not import `theme` from `@/styles/theme` for live UI colors. That export is a dark-theme compatibility default, so using it in render code leaves icons, placeholders, or third-party props pinned to dark colors in light mode.

Wrap the icon (or other leaf component) with `withUnistyles` instead, so only that node re-renders when the theme changes:

```tsx
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const ThemedChevronDown = withUnistyles(ChevronDown);

const styles = StyleSheet.create((theme) => ({
  icon: { color: theme.colors.foregroundMuted },
}));

<ThemedChevronDown size={theme.iconSize.md} style={styles.icon} />;
```

This is the dominant pattern in the app today (see `sidebar-workspace-list.tsx`, `message.tsx`, the workspace screens). Importing `baseColors`, theme-name constants, or `type Theme` is fine when the value is intentionally static or type-only.

## Reanimated `Animated.View` + Dynamic Styles Crashes

Retained native history: a theme change could make Unistyles' ShadowRegistry and
Reanimated mutate the same native node, producing `Unable to find node on an
unmounted component.` This occurred in the iOS sidebar (commit `4896cfe9`).

The historical inline-hook workaround is obsolete under this repository's
`useUnistyles()` ban. Preserve the history when inspecting native adapters;
use the allowed styling patterns above for Agent Duel web/Electron work.

## Adaptive Themes And Persisted Settings

Unistyles [`initialTheme`](https://www.unistyl.es/v3/guides/theming#select-theme) and [`adaptiveThemes`](https://www.unistyl.es/v3/guides/theming#adaptive-themes) are mutually exclusive. `initialTheme` can be a string or a synchronous function, but it cannot wait on async storage.

The app stores app settings in AsyncStorage and loads them through react-query. That means the app can mount under adaptive/system theme first, then switch after settings load:

1. Unistyles config starts with `adaptiveThemes: true`.
2. The device may report system light.
3. Settings load a persisted non-auto preference, such as dark.
4. The app calls `setAdaptiveThemes(false)` and `setTheme("dark")`.

That brief transition is expected with the current storage model. It makes tracking-compatible styles important: anything mounted during the initial adaptive theme must update correctly after the persisted preference applies. [Issue #550](https://github.com/jpudysz/react-native-unistyles/issues/550) was a separate ScrollView sticky-header bug, but it is still useful context for why ScrollView theme updates deserve extra suspicion.

If we ever need to avoid the transition entirely, store at least the theme preference in synchronous storage and configure Unistyles with `initialTheme`.

## Runtime Theme Patching For User Preferences

Appearance settings (UI/mono font family, font sizes, syntax-highlight theme) are applied by patching every registered theme at runtime with `UnistylesRuntime.updateTheme(name, updater)` — not by threading preference reads through components. `applyAppearance` in `packages/app/src/screens/settings/appearance/apply-appearance.ts` runs from a `ProvidersWrapper` effect on settings load/change and loops all six theme keys, returning `{ ...theme, fontFamily, fontSize, lineHeight, colors.syntax }`.

This works without `useUnistyles()` because every consumer already reads these tokens through `StyleSheet.create((theme) => …)` (or the `withUnistyles`/`uniProps` path for the markdown renderer), so patching the theme repaints tracked views through the native ShadowRegistry with no React re-render.

Gotchas:

- **Patch all themes, not just the active one.** The active theme can change and adaptive mode can flip light/dark; patching every key keeps the active key current and makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant. The effect depends on the settings values (not on `theme`), so it cannot loop.
- **Narrow the discriminated union before spreading.** `updateTheme`'s updater returns the theme union; spreading the union widens `colorScheme` to `"light" | "dark"`, which is assignable to neither concrete member. Branch on `t.colorScheme` so each branch spreads a single narrowed theme type (no `as`).
- **`lineHeight.diff` is the code/diff line-height axis** — it is coupled to the code-font-size control (≈ `codeFontSize * 1.5`). Do NOT use it for prose. Markdown body line-height scales with the UI ramp (`Math.round(theme.fontSize.base * 1.4)`); routing prose through `lineHeight.diff` clips text at small code sizes.
- **High-churn draft values** (live-while-typing in the appearance preview) bypass the theme: apply them as inline styles marked with `inlineUnistylesStyle` so per-keystroke values don't grow the `#unistyles-web` CSS registry.
- **The app shell uses one `AppearanceStyleBoundary`.** Runtime-patched numeric theme values are baked into Unistyles web classes rather than CSS variables, while parsed/memoized content also does not naturally re-run when appearance tokens change. The boundary sits below stable runtime providers in `app/_layout.tsx` and remounts the visual shell once. It captures DOM scroll positions, focus and text selection before that remount and restores matching elements afterward. Keep an appearance input focused on Enter so the boundary can restore it; a blur-save follows the user's new focus instead. `applyAppearance` patches the active theme before inactive registry entries so its subscribers receive the committed values in the same update. Do not add local appearance keys or nested boundaries.
- **Dynamic font tokens stay widened.** `fontFamily`, `fontSize`, and `lineHeight` on `commonTheme` are annotated `string`/`number` (not narrowed by `as const`) so the updater's return assigns; the platform default stacks live in `DEFAULT_UI_FONT_STACK` / `DEFAULT_MONO_FONT_STACK`.

## Debugging

To inspect what the Babel plugin sees, temporarily enable [`debug: true`](https://www.unistyl.es/v3/other/babel-plugin#debug) in `packages/app/babel.config.js`:

```js
[
  "react-native-unistyles/plugin",
  {
    root: "src",
    debug: true,
  },
],
```

Then rebuild the bundle and look for lines such as:

```text
src/components/welcome-screen.tsx: styles.container: [Theme]
```

This only confirms that the stylesheet dependency was detected. The upstream debugging guide makes the same distinction: dependency detection is only one failure mode. It does not prove the style prop is registered on the native view you care about.

For paint-layer bugs, use high-contrast probes:

1. Paint each candidate layer a distinct color, such as root wrapper cyan, `ScrollView.style` yellow, and `contentContainerStyle` magenta.
2. Cold-restart the app, not just Fast Refresh.
3. Screenshot the simulator and sample pixels to see which color fills the area.
4. Remove the probes before committing.

The welcome-screen investigation used this approach to prove the white layer was the `ScrollView` content container.

## References

- [Unistyles v3 documentation](https://www.unistyl.es/)
- [Theming: initial theme, adaptive themes, and runtime theme changes](https://www.unistyl.es/v3/guides/theming)
- [ScrollView Background Issue](https://www.unistyl.es/v3/tutorial/settings-screen#scrollview-background-issue)
- [withUnistyles reference](https://www.unistyl.es/v3/references/with-unistyles)
- [3rd-party view decision algorithm](https://www.unistyl.es/v3/references/3rd-party-views)
- [Babel plugin debug option](https://www.unistyl.es/v3/other/babel-plugin#debug)
- [Why my view doesn't update?](https://www.unistyl.es/v3/guides/why-my-view-doesnt-update)
- [GitHub issue #550: ScrollView sticky-header theme updates](https://github.com/jpudysz/react-native-unistyles/issues/550)
- [GitHub issue #817: `UnistylesRuntime.themeName` does not re-render](https://github.com/jpudysz/react-native-unistyles/issues/817)
- [GitHub issue #1030: `Image.tintColor` and native style update edge case](https://github.com/jpudysz/react-native-unistyles/issues/1030)
