from fastapi import Header, HTTPException

from app.ddb import Project, get_project_item


def require_project_owner(project_id: str, x_user_id: str = Header(alias="x-user-id")) -> Project:
    """Fetch a project and ensure the caller owns it.

    Returns 404 (not 403) on an ownership mismatch so we don't confirm the
    existence of another user's project.

    NOTE: identity still comes from the untrusted X-User-Id header (no JWT
    verification yet), so this raises the bar but is not airtight — see
    `나중에 수정해야할것.md` §2 for the token-verification follow-up.

    ponytail: `created_by is None` marks legacy projects created before ownership
    was enforced; allow those through so existing data isn't locked out. Remove
    this allowance once created_by is backfilled.
    """
    project = get_project_item(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    owner = project.data.created_by
    if owner is not None and owner != x_user_id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project
