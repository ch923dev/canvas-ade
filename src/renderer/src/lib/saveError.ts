/**
 * C3: map a MAIN write errno (Node `err.code`, propagated over IPC) to an accurate, user-facing
 * failure reason. Before this, EVERY write failure — an antivirus lock (`EPERM`/`EBUSY`), a
 * read-only/synced mount (`EROFS`), a permission denial (`EACCES`) — was mislabeled "check disk
 * space", so users with terabytes free saw a phantom disk-full error (the audit's headline C3 bug).
 *
 * Only `ENOSPC` is a genuine out-of-space condition. Every other code maps to what actually failed;
 * an absent/unknown code (a non-errno failure — envelope-invalid doc, cross-project race, "no
 * project open") falls through to a neutral generic message that never claims a cause.
 *
 * `subject` names the failed action (e.g. "Auto-save failed", "Export failed") so one helper serves
 * every save/export/write site with copy that matches its context.
 */
export function saveErrorMessage(code: string | undefined, subject = 'Save failed'): string {
  switch (code) {
    // Dev-check schema containment (projectStore.assertNoSchemaFloorRaise). Not an errno — MAIN
    // stamps it on the refusal so this case can say what actually happened and what to do. Without
    // it the refusal fell through to the neutral generic ("please try again"), which is exactly
    // wrong: retrying can never succeed, and the user needs to know their project is INTACT.
    case 'ESCHEMAFLOOR':
      return (
        `${subject} — this project was saved by a released Expanse, and a dev build must not ` +
        `upgrade its schema (the released app could no longer open it). The project on disk is ` +
        `unchanged. Use the dev-check sandbox project instead.`
      )
    case 'ENOSPC':
      return `${subject} — the disk is full.`
    case 'EPERM':
    case 'EACCES':
    case 'EBUSY':
      return `${subject} — the file is locked (antivirus or another program) or permission was denied.`
    case 'EROFS':
      return `${subject} — the location is read-only.`
    default:
      return `${subject} — please try again.`
  }
}
