interface ContentMutationInput {
  content: Pick<HTMLElement, "scrollHeight">;
  shouldFollow: () => boolean;
  forceStickToBottom: () => void;
}

export function createContentMutationCallback(input: ContentMutationInput): () => void {
  let previousScrollHeight = input.content.scrollHeight;
  return () => {
    const scrollHeight = input.content.scrollHeight;
    // Hover can swap a heading's icon between pointer-down and pointer-up.
    if (scrollHeight === previousScrollHeight) return;
    previousScrollHeight = scrollHeight;
    if (input.shouldFollow()) input.forceStickToBottom();
  };
}
