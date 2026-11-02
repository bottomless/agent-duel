import type { ReactNode, RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "../strategy";
import type { ChatFindOperations } from "./model";

/** A transcript that owns its history outside the live session store. */
export interface ChatFindHistory {
  epoch: string | null;
  search: ChatFindOperations["search"];
  load: ChatFindOperations["load"];
}

export interface MountedMessageIds {
  has(messageId: string): boolean;
}
export interface ChatFindProps {
  agentId: string;
  serverId: string;
  epoch: string | null;
  history?: ChatFindHistory;
  items: StreamItem[];
  viewportRef: RefObject<StreamViewportHandle | null>;
  revealLoadedMessage(messageId: string): boolean;
  visibleMessageIds: MountedMessageIds;
  children: ReactNode;
}
export interface ChatFindExpansionProps {
  messageId: string;
  children(renderFullContent: boolean): ReactNode;
}
