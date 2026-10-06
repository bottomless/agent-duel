import React, { createContext, useContext, type ReactNode } from "react";

export type WorkspaceBrowserLinkOpener = (url: string) => boolean;

const WorkspaceBrowserLinkOpenerContext = createContext<WorkspaceBrowserLinkOpener | null>(null);

export function WorkspaceBrowserLinkOpenerProvider({
  openUrl,
  children,
}: {
  openUrl: WorkspaceBrowserLinkOpener;
  children: ReactNode;
}) {
  return (
    <WorkspaceBrowserLinkOpenerContext.Provider value={openUrl}>
      {children}
    </WorkspaceBrowserLinkOpenerContext.Provider>
  );
}

export function useWorkspaceBrowserLinkOpener(): WorkspaceBrowserLinkOpener | null {
  return useContext(WorkspaceBrowserLinkOpenerContext);
}
