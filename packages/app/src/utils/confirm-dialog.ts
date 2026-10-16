import { create } from "zustand";

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface ConfirmDialogRequest extends ConfirmDialogInput {
  id: number;
}

interface PendingConfirmDialog {
  request: ConfirmDialogRequest;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogStoreState {
  /** First in, first shown: a second confirm waits until the first one is answered. */
  pending: PendingConfirmDialog[];
  hostCount: number;
}

export const useConfirmDialogStore = create<ConfirmDialogStoreState>(() => ({
  pending: [],
  hostCount: 0,
}));

let nextRequestId = 1;

export function selectActiveConfirmDialog(
  state: ConfirmDialogStoreState,
): ConfirmDialogRequest | null {
  return state.pending[0]?.request ?? null;
}

/**
 * Asks the user to confirm in an in-app modal and resolves with their answer.
 * `ConfirmDialogHost` renders the modal; Escape, the backdrop and Cancel all
 * answer `false`.
 */
export function confirmDialog(input: ConfirmDialogInput): Promise<boolean> {
  if (useConfirmDialogStore.getState().hostCount === 0) {
    return Promise.reject(new Error("[ConfirmDialog] No confirm dialog host is mounted."));
  }
  return new Promise<boolean>((resolve) => {
    const request: ConfirmDialogRequest = { ...input, id: nextRequestId++ };
    useConfirmDialogStore.setState((state) => ({
      pending: [...state.pending, { request, resolve }],
    }));
  });
}

export function answerConfirmDialog(id: number, confirmed: boolean): void {
  const entry = useConfirmDialogStore.getState().pending.find((item) => item.request.id === id);
  if (!entry) return;
  useConfirmDialogStore.setState((state) => ({
    pending: state.pending.filter((item) => item.request.id !== id),
  }));
  entry.resolve(confirmed);
}

/** Returns the unregister function. The last host to leave cancels whatever is still waiting. */
export function registerConfirmDialogHost(): () => void {
  useConfirmDialogStore.setState((state) => ({ hostCount: state.hostCount + 1 }));
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const { hostCount, pending } = useConfirmDialogStore.getState();
    const remaining = hostCount - 1;
    useConfirmDialogStore.setState(
      remaining > 0 ? { hostCount: remaining } : { hostCount: 0, pending: [] },
    );
    if (remaining > 0) return;
    for (const entry of pending) entry.resolve(false);
  };
}
