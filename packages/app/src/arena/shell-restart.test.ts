import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createInstance } from "i18next";
import { en } from "@/i18n/resources/en";
import { ar } from "@/i18n/resources/ar";
import { es } from "@/i18n/resources/es";
import { fr } from "@/i18n/resources/fr";
import { ja } from "@/i18n/resources/ja";
import { ko } from "@/i18n/resources/ko";
import { ptBR } from "@/i18n/resources/pt-BR";
import { ru } from "@/i18n/resources/ru";
import { zhCN } from "@/i18n/resources/zh-CN";
import { replaceShellRestartErrors } from "./shell-restart";

const error = "[System Error] OpenCode server exited with code null";
function row(
  id: string,
  text: string,
  at: number,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return { kind: "assistant_message", id, text, timestamp: new Date(at) };
}

describe("stopped command notice", () => {
  it("replaces only the matching crash row in place and preserves its identity", () => {
    const items = [row("before", "answer", 10), row("crash", error, 30), row("after", "reply", 60)];
    const result = replaceShellRestartErrors(
      items,
      [{ startedAt: 20, stoppedAt: 40 }],
      "translated",
    );
    expect(result).toEqual([items[0], { ...items[1], text: "translated" }, items[2]]);
    expect(result[0]).toBe(items[0]);
    expect(result[2]).toBe(items[2]);
    expect(items[1]?.text).toBe(error);
  });

  it("keeps unrelated exits and every row when no command was stopped", () => {
    const items = [
      row("old", error, 10),
      row("code", "[System Error] OpenCode server exited with code 1", 30),
      row("later", error, 50),
    ];
    expect(replaceShellRestartErrors(items, [], "translated")).toBe(items);
    expect(replaceShellRestartErrors(items, [{ startedAt: 20, stoppedAt: 40 }], "translated")).toBe(
      items,
    );
  });
});

it("renders the replacement through i18n in all nine languages", async () => {
  const resources = { en, ar, es, fr, ja, ko, "pt-BR": ptBR, ru, "zh-CN": zhCN };
  const i18n = createInstance();
  await i18n.init({
    resources: Object.fromEntries(
      Object.entries(resources).map(([language, translation]) => [language, { translation }]),
    ),
    lng: "en",
    fallbackLng: false,
  });
  expect(en.arena.engineRestartedCommandStopped).toBe(
    "The engine restarted, and a running command stopped.",
  );
  for (const [language, translation] of Object.entries(resources)) {
    await i18n.changeLanguage(language);
    const notice = i18n.t("arena.engineRestartedCommandStopped");
    expect(
      replaceShellRestartErrors(
        [row("crash", error, 30)],
        [{ startedAt: 20, stoppedAt: 40 }],
        notice,
      )[0],
    ).toEqual(row("crash", translation.arena.engineRestartedCommandStopped, 30));
  }
});
