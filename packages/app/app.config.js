const pkg = require("./package.json");

export default {
  expo: {
    name: "Agent Duel",
    slug: "voice-mobile",
    version: pkg.version,
    scheme: "paseo",
    userInterfaceStyle: "automatic",
    platforms: ["web"],
    web: {
      output: "single",
    },
    autolinking: {
      searchPaths: ["../../node_modules", "./node_modules"],
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
          },
        },
      ],
    ],
    experiments: {
      ...(process.env.PASEO_WEBSITE_BUILD === "1" ? { baseUrl: "/remote" } : {}),
      typedRoutes: true,
      reactCompiler: true,
      autolinkingModuleResolution: true,
    },
    extra: {
      router: {},
    },
  },
};
