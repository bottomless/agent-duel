export type KeyboardActionScope = "global" | "message-input" | "sidebar" | "workspace";

export type KeyboardActionId =
  | "agent.interrupt"
  | "message-input.focus"
  | "message-input.send"
  | "message-input.dictation-toggle"
  | "message-input.dictation-cancel"
  | "message-input.dictation-confirm"
  | "message-input.mode-cycle"
  | "workspace.tab.close-current"
  | "workspace.tab.navigate-index"
  | "workspace.tab.navigate-relative"
  | "workspace.pane.focus.left"
  | "workspace.pane.focus.right"
  | "workspace.pane.move-tab.left"
  | "workspace.pane.move-tab.right"
  | "workspace.pane.close"
  | "workspace.focus.toggle"
  | "workspace.terminal.new"
  | "workspace.browser.new"
  | "sidebar.toggle.right"
  | "workspace.new"
  | "workspace.project.pick"
  | "worktree.new"
  | "workspace.archive"
  | "workspace.pin";

export type KeyboardActionDefinition =
  | { id: "agent.interrupt"; scope: KeyboardActionScope }
  | { id: "message-input.focus"; scope: KeyboardActionScope }
  | { id: "message-input.send"; scope: KeyboardActionScope }
  | { id: "message-input.dictation-toggle"; scope: KeyboardActionScope }
  | { id: "message-input.dictation-cancel"; scope: KeyboardActionScope }
  | { id: "message-input.dictation-confirm"; scope: KeyboardActionScope }
  | { id: "message-input.mode-cycle"; scope: KeyboardActionScope }
  | { id: "workspace.tab.close-current"; scope: KeyboardActionScope }
  | { id: "workspace.tab.navigate-index"; scope: KeyboardActionScope; index: number }
  | { id: "workspace.tab.navigate-relative"; scope: KeyboardActionScope; delta: 1 | -1 }
  | { id: "workspace.pane.focus.left"; scope: KeyboardActionScope }
  | { id: "workspace.pane.focus.right"; scope: KeyboardActionScope }
  | { id: "workspace.pane.move-tab.left"; scope: KeyboardActionScope }
  | { id: "workspace.pane.move-tab.right"; scope: KeyboardActionScope }
  | { id: "workspace.pane.close"; scope: KeyboardActionScope }
  | { id: "workspace.focus.toggle"; scope: KeyboardActionScope }
  | { id: "workspace.terminal.new"; scope: KeyboardActionScope }
  | { id: "workspace.browser.new"; scope: KeyboardActionScope }
  | { id: "sidebar.toggle.right"; scope: KeyboardActionScope }
  | { id: "workspace.new"; scope: KeyboardActionScope }
  | { id: "workspace.project.pick"; scope: KeyboardActionScope }
  | { id: "worktree.new"; scope: KeyboardActionScope }
  | { id: "workspace.archive"; scope: KeyboardActionScope }
  | { id: "workspace.pin"; scope: KeyboardActionScope };

export interface KeyboardActionHandler {
  handlerId: string;
  actions: readonly KeyboardActionId[];
  enabled: boolean;
  priority: number;
  isActive?: () => boolean;
  handle: (action: KeyboardActionDefinition) => boolean;
}

type KeyboardActionRegistryEntry = KeyboardActionHandler & {
  registeredAt: number;
};

export function createKeyboardActionDispatcher() {
  let nextRegistrationOrder = 1;
  const handlers = new Map<string, KeyboardActionRegistryEntry>();

  return {
    registerHandler(handler: KeyboardActionHandler) {
      handlers.set(handler.handlerId, {
        ...handler,
        registeredAt: nextRegistrationOrder++,
      });

      return () => {
        const current = handlers.get(handler.handlerId);
        if (!current) {
          return;
        }
        handlers.delete(handler.handlerId);
      };
    },

    dispatch(action: KeyboardActionDefinition): boolean {
      const candidates = Array.from(handlers.values())
        .filter((handler) => handler.actions.includes(action.id))
        .filter((handler) => handler.enabled)
        .filter((handler) => (handler.isActive ? handler.isActive() : true))
        .sort((left, right) => {
          if (left.priority !== right.priority) {
            return right.priority - left.priority;
          }
          return right.registeredAt - left.registeredAt;
        });

      for (const handler of candidates) {
        if (handler.handle(action)) {
          return true;
        }
      }

      return false;
    },
  };
}

export const keyboardActionDispatcher = createKeyboardActionDispatcher();
