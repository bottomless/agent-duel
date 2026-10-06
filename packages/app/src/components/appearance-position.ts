/** DOM positions survive the one visual-shell remount used for numeric appearance tokens. */
interface ElementAddress {
  path: number[];
  tag: string;
  label: string | null;
}
interface ScrollPosition {
  address: ElementAddress;
  top: number;
  left: number;
}
export interface AppearancePosition {
  scroll: ScrollPosition[];
  focus: { address: ElementAddress; selection: [number, number] | null } | null;
}

function address(root: Element, element: Element): ElementAddress | null {
  const path: number[] = [];
  let current = element;
  while (current !== root) {
    const parent = current.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return { path, tag: element.tagName, label: element.getAttribute("aria-label") };
}

function resolve(root: Element, target: ElementAddress): HTMLElement | null {
  let current: Element = root;
  for (const index of target.path) {
    const next = current.children.item(index);
    if (!next) return null;
    current = next;
  }
  return current instanceof HTMLElement &&
    current.tagName === target.tag &&
    current.getAttribute("aria-label") === target.label
    ? current
    : null;
}

export function captureAppearancePosition(): AppearancePosition | null {
  if (typeof document === "undefined") return null;
  const root = document.getElementById("root");
  if (!root) return null;
  const scroll: ScrollPosition[] = [];
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (!element.scrollTop && !element.scrollLeft) continue;
    const target = address(root, element);
    if (target) scroll.push({ address: target, top: element.scrollTop, left: element.scrollLeft });
  }
  const active = document.activeElement;
  const target = active ? address(root, active) : null;
  const selection: [number, number] | null =
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.selectionStart !== null &&
    active.selectionEnd !== null
      ? [active.selectionStart, active.selectionEnd]
      : null;
  return { scroll, focus: target ? { address: target, selection } : null };
}

export function restoreAppearancePosition(position: AppearancePosition | null): void {
  if (!position || typeof document === "undefined") return;
  const root = document.getElementById("root");
  if (!root) return;
  const focus = position.focus;
  const element = focus ? resolve(root, focus.address) : null;
  element?.focus({ preventScroll: true });
  if (
    focus?.selection &&
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  ) {
    element.setSelectionRange(...focus.selection);
  }
  for (const item of position.scroll) {
    const scroller = resolve(root, item.address);
    if (!scroller) continue;
    scroller.scrollTop = item.top;
    scroller.scrollLeft = item.left;
  }
}
