import { spawnSync } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const svg = path.join(root, "packages/app/node_modules/react-native-svg");

// Use the installed web components: the app's normal test alias replaces react-native-svg.
describe.each([
  "src/elements.web.ts",
  "lib/module/elements.web.js",
  "lib/commonjs/elements.web.js",
])("SVG web accessibility in %s", (entry) => {
  it.each([
    { name: "accessibilityElementsHidden", props: { accessibilityElementsHidden: true } },
    {
      name: "importantForAccessibility",
      props: { importantForAccessibility: "no-hide-descendants" },
    },
    {
      name: "both native hiding props",
      props: {
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      },
    },
  ])("maps $name to aria-hidden without React errors", async ({ props: hiddenProps }) => {
    const bundle = await build({
      stdin: {
        resolveDir: root,
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { Svg, Circle } from ${JSON.stringify(path.join(svg, entry))};
            const hiddenProps = ${JSON.stringify(hiddenProps)};
            function Ring(props) {
              return React.createElement(Svg, { width: 14, height: 14, viewBox: '0 0 14 14', ...props },
                React.createElement(Circle, { cx: 7, cy: 7, r: 6, stroke: '#123456', ...hiddenProps }));
            }
            const hidden = renderToStaticMarkup(React.createElement(Ring, hiddenProps));
            const visible = renderToStaticMarkup(React.createElement(Svg, {
              accessibilityElementsHidden: false, importantForAccessibility: 'auto',
              accessibilityLabel: 'Status', role: 'img',
            }));
            const explicit = renderToStaticMarkup(React.createElement(Svg, { 'aria-hidden': true }));
            process.stdout.write(JSON.stringify({ hidden, visible, explicit }));
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
    expect(result.hidden).toContain(
      '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">',
    );
    expect(result.hidden).toContain(
      '<circle cx="7" cy="7" r="6" stroke="#123456" aria-hidden="true">',
    );
    expect(result.visible).toBe('<svg aria-label="Status" role="img"></svg>');
    expect(result.explicit).toBe('<svg aria-hidden="true"></svg>');
  });
});
