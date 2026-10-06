import type { GitAction, GitActions } from "@/git/policy";

export function getGitActionMenuActions(gitActions: GitActions): GitAction[] {
  const actions = [gitActions.primary, ...gitActions.secondary, ...gitActions.menu];
  const seen = new Set<GitAction["id"]>();
  return actions.filter((action): action is GitAction => {
    if (!action || seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}
