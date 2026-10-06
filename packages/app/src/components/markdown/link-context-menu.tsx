import React, { useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { MenuItem, MenuRoot, MenuSurface, useMenuContext } from "@/components/ui/menu";
import { canOpenExternalUrl, openExternalUrl } from "@/utils/open-external-url";

export type MarkdownLinkContextMenuHandler = (event: unknown) => void;

export function MarkdownLinkContextMenu({
  url,
  children,
}: {
  url: string;
  children: (onContextMenu?: MarkdownLinkContextMenuHandler) => ReactNode;
}) {
  if (!isWeb || !canOpenExternalUrl(url)) {
    return children();
  }

  return (
    <MenuRoot>
      <MarkdownLinkContextMenuBody url={url}>{children}</MarkdownLinkContextMenuBody>
    </MenuRoot>
  );
}

function MarkdownLinkContextMenuBody({
  url,
  children,
}: {
  url: string;
  children: (onContextMenu: MarkdownLinkContextMenuHandler) => ReactNode;
}) {
  const { t } = useTranslation();
  const menu = useMenuContext("MarkdownLinkContextMenu");
  const handleContextMenu = useCallback(
    (event: unknown) => {
      if (typeof event !== "object" || event === null) return;

      const preventDefault = Reflect.get(event, "preventDefault");
      const stopPropagation = Reflect.get(event, "stopPropagation");
      if (typeof preventDefault === "function") preventDefault.call(event);
      if (typeof stopPropagation === "function") stopPropagation.call(event);

      const nativeEvent = Reflect.get(event, "nativeEvent");
      const source = typeof nativeEvent === "object" && nativeEvent !== null ? nativeEvent : event;
      const pageX = Reflect.get(source, "pageX");
      const pageY = Reflect.get(source, "pageY");
      const clientX = Reflect.get(source, "clientX");
      const clientY = Reflect.get(source, "clientY");
      const x = typeof pageX === "number" ? pageX : clientX;
      const y = typeof pageY === "number" ? pageY : clientY;
      if (typeof x !== "number" || typeof y !== "number") return;

      menu.setAnchorRect({ x, y, width: 0, height: 0 });
      menu.setOpen(true);
    },
    [menu],
  );
  const handleOpenExternal = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);

  return (
    <>
      {children(handleContextMenu)}
      <MenuSurface align="start" width={190} testID="markdown-link-context-menu">
        <MenuItem onSelect={handleOpenExternal} testID="markdown-link-open-external">
          {t("common.actions.openExternalBrowser")}
        </MenuItem>
      </MenuSurface>
    </>
  );
}
