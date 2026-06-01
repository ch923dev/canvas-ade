# NEW-BOARD-2: BrowserBoard URL bar silently rejects bare hostnames, showing "Couldn't load" with no guidance

- **Severity:** Medium
- **Category:** BrowserBoard / URL handling
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/boards/BrowserBoard.tsx`, `src/main/preview.ts`
- **Assigned:** _(blank)_

## Summary

When a user types a bare hostname like `localhost:5173` or `127.0.0.1:3000` into the Browser board URL bar (omitting the `http://` scheme), the entry is stored as-is in `board.url` and forwarded to the main process `isAllowedPreviewUrl` guard, which parses it with the WHATWG `URL` constructor. The WHATWG parser interprets the bare string as a URL with a custom protocol (`localhost:` or `127.0.0.1:`), which is not `http:` or `https:`, so the guard rejects it, emits a `did-fail-load` event, and the board displays "Couldn't load" with no explanation. The user receives no feedback that adding `http://` would fix the problem.

## Where

`src/renderer/src/canvas/boards/BrowserBoard.tsx:135-144` — `commitUrl` stores any non-empty string directly:

```tsx
const commitUrl = (): void => {
  const next = draftUrl.trim()
  if (!next || next === board.url) {
    setDraftUrl(board.url)
    return
  }
  beginChange()
  updateBoard(board.id, { url: next })
}
```

`src/main/preview.ts:80-88` — `isAllowedPreviewUrl` rejects anything whose WHATWG-parsed protocol is not `http:` or `https:`:

```typescript
export function isAllowedPreviewUrl(rawUrl: string): boolean {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  return u.protocol === 'http:' || u.protocol === 'https:'
}
```

## How it triggers

1. Add a Browser board. Its default URL is `http://localhost:5173`.
2. Click the URL bar, clear it, and type `localhost:5173` (no scheme — a natural input for developers).
3. Press Enter or blur the field.
4. `commitUrl` stores `'localhost:5173'` in the board.
5. `BrowserPreviewLayer` calls `navigatePreview('localhost:5173')`.
6. In main, `new URL('localhost:5173')` succeeds but `u.protocol === 'localhost:'` (not `http:`) → rejected.
7. Main emits `did-fail-load`, renderer shows "Couldn't load" and sub-text `localhost:5173`.
8. The URL bar now shows `localhost:5173` with no explanation of the required `http://` prefix.

Verification of the WHATWG parse:

```
node -e "const u = new URL('localhost:5173'); console.log(u.protocol)"
# → localhost:
```

The same applies to `127.0.0.1:3000`, `0.0.0.0:8080`, and other bare `host:port` inputs.

## Verification evidence

In `BrowserBoard.tsx:135-144` there is no scheme normalization before `updateBoard`. The only validation is `!next` (empty string check). `isAllowedPreviewUrl` in `preview.ts:80-88` is the sole scheme guard, and it is on the main-process side — the renderer never tells the user why the load failed.

## Suggested fix direction

In `commitUrl`, auto-prepend `http://` when the trimmed string contains no `://` and is not already a valid `http`/`https` URL:

```tsx
const commitUrl = (): void => {
  let next = draftUrl.trim()
  if (!next) { setDraftUrl(board.url); return }
  // Normalize bare host:port → http://host:port
  if (!next.includes('://')) next = `http://${next}`
  if (next === board.url) return
  beginChange()
  updateBoard(board.id, { url: next })
}
```

Alternatively, show an inline validation error when the stored URL would fail `isAllowedPreviewUrl` (move a pure copy of that check to the renderer), so the user sees "Add http:// or https://" before committing.

## Collision notes

TBD (computed in INDEX)
