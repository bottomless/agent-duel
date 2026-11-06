import { create } from "zustand";

export interface ConfirmDialogChoices {
  label: string;
  options: readonly { id: string; label: string }[];
}

export interface ConfirmDialogInput {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Optional answers shown above the buttons; the voter can confirm without picking one. */
  choices?: ConfirmDialogChoices;
}

export interface ConfirmDialogAnswer {
  confirmed: boolean;
  choice?: string;
}

export interface ConfirmDialogRequest extends ConfirmDialogInput {
  id: number;
}

interface PendingConfirmDialog {
  request: ConfirmDialogRequest;
  resolve: (answer: ConfirmDialogAnswer) => void;
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
export async function confirmDialog(
  input: ConfirmDialogInput,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await confirmDialogWithChoice(input, signal)).confirmed;
}

/** `confirmDialog` that also resolves with the option picked from `input.choices`, if any. */
export function confirmDialogWithChoice(
  input: ConfirmDialogInput,
  signal?: AbortSignal,
): Promise<ConfirmDialogAnswer> {
  if (signal?.aborted) return Promise.resolve({ confirmed: false });
  if (useConfirmDialogStore.getState().hostCount === 0) {
    return Promise.reject(new Error("[ConfirmDialog] No confirm dialog host is mounted."));
  }
  return new Promise<ConfirmDialogAnswer>((resolve) => {
    const request: ConfirmDialogRequest = { ...input, id: nextRequestId++ };
    const cancel = () => answerConfirmDialog(request.id, false);
    signal?.addEventListener("abort", cancel, { once: true });
    const answer = (result: ConfirmDialogAnswer) => {
      signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    useConfirmDialogStore.setState((state) => ({
      pending: [...state.pending, { request, resolve: answer }],
    }));
  });
}

export function answerConfirmDialog(id: number, confirmed: boolean, choice?: string): void {
  const entry = useConfirmDialogStore.getState().pending.find((item) => item.request.id === id);
  if (!entry) return;
  useConfirmDialogStore.setState((state) => ({
    pending: state.pending.filter((item) => item.request.id !== id),
  }));
  entry.resolve(confirmed && choice !== undefined ? { confirmed, choice } : { confirmed });
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
    for (const entry of pending) entry.resolve({ confirmed: false });
  };
}
