import { transformSync } from "@babel/core";
import { createInstance } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { en } from "@/i18n/resources/en";
import { ru } from "@/i18n/resources/ru";
import { ar } from "@/i18n/resources/ar";
import { diffLayoutOptions } from "./diff-layout";
import { divergenceStatusLabel } from "./divergence";
import { arenaReplyComposerLabels, type ArenaReplyAction } from "./reply-state";
import { workspaceBattleStatus } from "@/components/sidebar/arena-status";
import type { ArenaActivity } from "@getpaseo/protocol/arena/activity";

const translations = createInstance();
beforeAll(async () => {
  await translations.init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en }, ru: { translation: ru }, ar: { translation: ar } },
    interpolation: { escapeValue: false },
  });
});
const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const both: ArenaReplyAction = { target: "both", label: "Message both", steering: false };
const activity: ArenaActivity = {
  sessionID: "session",
  chatID: "chat",
  turnID: "turn",
  agentId: "agent",
  workspaceId: "workspace",
  title: "user title",
  stale: false,
  state: "awaiting_vote",
  resolved: false,
  requiresDecision: true,
  runs: [],
};

describe("Round 2 label regressions", () => {
  it("replaces plain diff options and file verdicts with the subscribed language", () => {
    const english = diffLayoutOptions(translations.getFixedT("en"));
    const russian = diffLayoutOptions(translations.getFixedT("ru"));
    const arabic = diffLayoutOptions(translations.getFixedT("ar"));
    expect(english.map((item) => item.label)).toEqual(["Side by side", "One column"]);
    expect(russian.map((item) => item.label)).toEqual([ru.arena.sideBySide, ru.arena.oneColumn]);
    expect(arabic.map((item) => item.label)).toEqual([ar.arena.sideBySide, ar.arena.oneColumn]);
    expect(russian).not.toBe(english);
    expect(Object.getOwnPropertyDescriptor(russian[0], "label")?.get).toBeUndefined();
    expect(russian.map((item) => item.testID)).toEqual(english.map((item) => item.testID));
    for (const locale of ["en", "ru", "ar"] as const) {
      expect(divergenceStatusLabel("identical", translations.getFixedT(locale))).toBe(
        { en, ru, ar }[locale].arena.sameResult,
      );
    }
  });

  it("keeps language in React Compiler cache dependencies for mounted diff labels", () => {
    for (const [file, call] of [
      ["arena/diff-layout-control.tsx", "diffLayoutOptions(t)"],
      ["arena/changes-list.tsx", "divergenceStatusLabel(row.status, t)"],
    ] as const) {
      const compiled = transformSync(source(file), {
        filename: file,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
      })?.code;
      if (!compiled) throw new Error(`No compiler output for ${file}`);
      const callIndex = compiled.indexOf(call);
      expect(callIndex).toBeGreaterThan(0);
      const beforeCall = compiled.slice(0, callIndex);
      // The cache guard enclosing the translated value must invalidate when t changes.
      expect(beforeCall.slice(beforeCall.lastIndexOf("if ("))).toMatch(/!== t\b/);
    }
  });

  it("translates follow-up, target, send and steering copy without reading an English prefix", () => {
    const t = translations.getFixedT("ru");
    expect(arenaReplyComposerLabels(both, true, t)).toMatchObject({
      placeholder: "Задайте обоим уточняющий вопрос перед выбором",
      submitLabel: "Отправить уточнение",
    });
    expect(
      arenaReplyComposerLabels({ target: "a", label: "Направить A", steering: true }, true, t),
    ).toMatchObject({ placeholder: "Направить агента A", submitLabel: "Направить" });
    expect(arenaReplyComposerLabels({ ...both, label: "Steer both" }, false, t).placeholder).toBe(
      "Написать обоим участникам",
    );
    expect(arenaReplyComposerLabels(undefined, false, t)).toEqual({
      placeholder: "Выберите, кому написать",
      submitLabel: ru.composer.input.send,
      submitButtonAccessibilityLabel: "Выберите участника перед отправкой",
    });
    expect(arenaReplyComposerLabels(both, true, translations.getFixedT("ar")).placeholder).toBe(
      "اسأل كليهما سؤال متابعة قبل الاختيار",
    );
    expect(arenaReplyComposerLabels(both, true, translations.getFixedT("en")).placeholder).toBe(
      "Ask both a follow-up before choosing",
    );
    const panel = source("panels/agent-panel.tsx");
    expect(panel).toContain(
      "arenaReplyComposerLabels(replyComposer.selectedAction, awaitingVote, t)",
    );
    expect(panel).not.toContain('.label.startsWith("Steer")');
    expect(panel).toContain('t("arena.ownInstructions")');
  });

  it.each(["en", "ru", "ar"] as const)(
    "localizes the two reported sidebar statuses in %s",
    (locale) => {
      const t = translations.getFixedT(locale);
      expect(
        workspaceBattleStatus({ arenaActivity: activity, statusBucket: "attention" }, t),
      ).toEqual({
        bucket: "attention",
        label: { en, ru, ar }[locale].arena.readyToChoose,
        icon: "ready",
      });
      expect(
        workspaceBattleStatus(
          {
            arenaActivity: { ...activity, state: "complete", resolved: true },
            statusBucket: "done",
          },
          t,
        ),
      ).toEqual({
        bucket: "done",
        label: { en, ru, ar }[locale].arena.battleComplete,
        icon: "idle",
      });
      expect(source("components/sidebar/sidebar-workspace-row-content.tsx")).toContain(
        "workspaceBattleStatus(workspace, t)",
      );
    },
  );

  it("localizes the resolved winner note", () => {
    expect(translations.getFixedT("ru")("arena.winnerNote")).toBe("(победитель)");
    expect(source("arena/battle-summary.tsx")).toContain(
      'counted ? t("arena.winnerNote") : "(applied)"',
    );
  });

  it("localizes the message timing accessible name and preserves its values", () => {
    expect(
      translations.getFixedT("ru")("message.turnFooter.endedAt", { duration: "5s", time: "18:29" }),
    ).toBe("5s, завершено в 18:29");
    expect(source("components/message.tsx")).toContain('t("message.turnFooter.endedAt",');
  });

  it("uses the translated frontier size word in the rating accessible name", () => {
    expect(translations.getFixedT("ru")("arena.rateFrontier")).toBe("Оцените этот передовой ответ");
    expect(source("arena/single-agent-rating.tsx")).toContain(
      'accessibilityLabel={t("arena.rateFrontier")}',
    );
  });

  it("translates the reported Arabic file-drop label", () => {
    expect(translations.getFixedT("ar")("composer.attachments.dropFilesHere")).toBe(
      "أفلت الملفات هنا",
    );
    expect(source("components/file-drop/file-drop-backdrop.tsx")).toContain(
      't("composer.attachments.dropFilesHere")',
    );
  });

  it("translates the reported Arabic Settings Plugins label", () => {
    expect(translations.getFixedT("ar")("settings.hostSections.plugins")).toBe("الإضافات");
    expect(source("screens/settings-screen.tsx")).toContain(
      'labelKey: "settings.hostSections.plugins"',
    );
  });

  it("translates the reported Arabic command-center section", () => {
    expect(translations.getFixedT("ar")("workspace.header.actions.workspaceActions")).toBe(
      "إجراءات مساحة العمل",
    );
    expect(source("command-center/workspace-registration.tsx")).toContain(
      'section: t("workspace.header.actions.workspaceActions")',
    );
  });
});
