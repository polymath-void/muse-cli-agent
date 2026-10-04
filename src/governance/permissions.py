class PermissionsKernel:
    def __init__(self):
        # Tier 0: read-only
        # Tier 1: local write
        # Tier 2: network/fleet/git-push/exec-rm
        self.tier2_operations = ["network", "fleet", "git-push", "exec-rm", "sudo", "docker"]
        
    def check_permission(self, action: str, is_approved: bool = False) -> bool:
        """
        Check if an action is allowed.
        Tier 0 and Tier 1 are always allowed in this basic implementation.
        Tier 2 requires explicit approval.
        """
        if any(t2 in action for t2 in self.tier2_operations):
            if not is_approved:
                raise PermissionError(f"APPROVAL_REQUIRED: Action '{action}' requires Tier 2 approval (--yes or /approve).")
        return True
