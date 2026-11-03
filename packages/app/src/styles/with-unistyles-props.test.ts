import { spawnSync } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const unistyles = path.join(root, "node_modules/react-native-unistyles");

describe("withUnistyles web dependency patch", () => {
  it.each([
    "src/core/withUnistyles/withUnistyles.tsx",
    "lib/module/core/withUnistyles/withUnistyles.js",
    "lib/commonjs/core/withUnistyles/withUnistyles.js",
  ])("consumes uniProps and preserves mapped colours in %s", async (entry) => {
    const componentEntry = path.join(unistyles, entry);
    const servicesEntry = path.resolve(path.dirname(componentEntry), "../../web/services");
    // Bundle the installed runtime directly: the app's normal test aliases replace Unistyles.
    const bundle = await build({
      stdin: {
        resolveDir: root,
        contents: `
          import React from 'react';
          import { renderToStaticMarkup } from 'react-dom/server';
          import { withUnistyles } from ${JSON.stringify(componentEntry)};
          import { services } from ${JSON.stringify(servicesEntry)};

          services.state.init({
            themes: { light: { color: '#123456' }, dark: { color: '#abcdef' } },
            settings: { initialTheme: 'light', CSSVars: false },
          });
          const received = [];
          function Icon(props) {
            received.push({ ...props, hasUniProps: Object.hasOwn(props, 'uniProps') });
            return React.createElement('svg', props);
          }
          const ThemedIcon = withUnistyles(Icon, () => ({ color: '#000000', strokeWidth: 1.5 }));
          const props = { uniProps: theme => ({ color: theme.color }), width: 24, 'aria-label': 'Menu' };
          const light = renderToStaticMarkup(React.createElement(ThemedIcon, props));
          services.runtime.setTheme('dark');
          const dark = renderToStaticMarkup(React.createElement(ThemedIcon, props));
          renderToStaticMarkup(React.createElement(ThemedIcon, { ...props, color: '#fedcba' }));
          renderToStaticMarkup(React.createElement(ThemedIcon, { width: 16 }));
          process.stdout.write(JSON.stringify({ received, light, dark }));
        `,
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      alias: { "react-native": "react-native-web" },
      external: ["react", "react-dom/server"],
      define: { __DEV__: "true" },
      logLevel: "silent",
    });
    const rendered = spawnSync(process.execPath, [], {
      cwd: root,
      input: bundle.outputFiles[0].text,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "development" },
    });
    expect(rendered.status, rendered.stderr).toBe(0);
    expect(rendered.stderr).toBe("");
    const result = JSON.parse(rendered.stdout);
    expect(result.received).toEqual([
      {
        color: "#123456",
        strokeWidth: 1.5,
        width: 24,
        "aria-label": "Menu",
        hasUniProps: false,
        ref: null,
      },
      {
        color: "#abcdef",
        strokeWidth: 1.5,
        width: 24,
        "aria-label": "Menu",
        hasUniProps: false,
        ref: null,
      },
      {
        color: "#fedcba",
        strokeWidth: 1.5,
        width: 24,
        "aria-label": "Menu",
        hasUniProps: false,
        ref: null,
      },
      { color: "#000000", strokeWidth: 1.5, width: 16, hasUniProps: false, ref: null },
    ]);
    expect(result.light).toContain('color="#123456"');
    expect(result.dark).toContain('color="#abcdef"');
  });
});
