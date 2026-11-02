import React, { act, useCallback, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { within } from "@testing-library/dom";
import { expect, it, vi } from "vitest";
import { Wrench } from "lucide-react-native";
import { ExpandableBadge } from "@/components/message";
import { i18n } from "@/i18n/i18next";
import {
  ArenaChatSubagent,
  ArenaChatTaskPrompt,
  type ArenaChatSubagentTimeline,
} from "./chat-subagent";

function renderCommandDetails() {
  return <pre>printf quick</pre>;
}

/** Mirrors the chat's recursive render port: stable identity, current renderers read through a ref. */
function ChildTranscript() {
  const [expanded, setExpanded] = useState(new Set<string>(["child"]));
  const setRowExpanded = useCallback((id: string, open: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const renderRef = useRef<(timeline: ArenaChatSubagentTimeline) => ReactNode>(() => null);
  const renderTranscript = useCallback(
    (timeline: ArenaChatSubagentTimeline) => renderRef.current(timeline),
    [],
  );
  const commandExpanded = expanded.has("command");
  const toggleCommand = useCallback(
    () => setRowExpanded("command", !commandExpanded),
    [commandExpanded, setRowExpanded],
  );
  renderRef.current = () => (
    <>
      <ArenaChatTaskPrompt
        itemId="prompt"
        text="Write quick.txt and report done."
        expanded={expanded.has("prompt")}
        onExpandedChange={setRowExpanded}
      />
      <ExpandableBadge
        label="Ran 1 command"
        icon={Wrench}
        isExpanded={commandExpanded}
        onToggle={toggleCommand}
        renderDetails={renderCommandDetails}
      />
    </>
  );
  return (
    <ArenaChatSubagent
      callId="child"
      expanded={expanded.has("child")}
      onExpandedChange={setRowExpanded}
      serverId="offline-test"
      parentAgentId="parent"
      subagentId="child"
      description="QUICK"
      status="completed"
      renderTranscript={renderTranscript}
      transcriptRevision={expanded}
    />
  );
}

it("redraws task prompt and command expansions without reopening the compiled child", async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<ChildTranscript />));
    const child = within(container).getByTestId("arena-chat-subagent-transcript");
    const transcript = within(child);
    expect(transcript.queryByText("Write quick.txt and report done.")).toBeNull();
    expect(transcript.queryByText("printf quick")).toBeNull();

    act(() => transcript.getByRole("button", { name: "Task prompt" }).click());
    expect(transcript.getByText("Write quick.txt and report done.").textContent).toBe(
      "Write quick.txt and report done.",
    );
    act(() => transcript.getByRole("button", { name: "Ran 1 command" }).click());
    expect(transcript.getByText("printf quick").textContent).toBe("printf quick");

    act(() => transcript.getByRole("button", { name: "Task prompt" }).click());
    act(() => transcript.getByRole("button", { name: "Ran 1 command" }).click());
    expect(transcript.queryByText("Write quick.txt and report done.")).toBeNull();
    expect(transcript.queryByText("printf quick")).toBeNull();
    expect(within(container).getByTestId("arena-chat-subagent-transcript")).toBe(child);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
