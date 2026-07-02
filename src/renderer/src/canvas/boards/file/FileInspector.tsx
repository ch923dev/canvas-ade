/**
 * FileInspector — the File board's per-type content for the Board Inspector (P2). Presentation-only:
 * FileBoard owns all state/handlers and portals this into the shell's slot, so every control reuses the
 * EXACT same handler its title-bar / context-menu counterpart uses (no duplication, no lifted state).
 *
 * Additive: the title-bar actions (FileActions) stay as-is; this surfaces them as labelled rows PLUS
 * the otherwise right-click-only Find-in-file (the visibility win) and the path/type/size config.
 * Sections mirror docs/research/mocks/board-inspector-popover-mock (File hero); View (markdown only) +
 * Appearance + File start expanded, Configuration starts COLLAPSED for text (open for other kinds where
 * it is the only content). The shell owns the head + Duplicate foot, so this renders sections only.
 */
import type { ReactElement } from 'react'
import { Icon } from '../../Icon'
import {
  InspectorAction,
  InspectorMeta,
  InspectorRow,
  InspectorSection,
  InspectorSegmented,
  InspectorStepper
} from '../../inspector/primitives'
import type { FileViewMode } from './FileActions'

export type FileKind = 'loading' | 'empty' | 'text' | 'image' | 'large' | 'binary' | 'error'

export interface FileInspectorProps {
  kind: FileKind
  isMarkdown: boolean
  mode: FileViewMode
  onMode: (m: FileViewMode) => void
  fontSize: number
  onDecFont: () => void
  onIncFont: () => void
  readOnly: boolean
  dirty: boolean
  saving: boolean
  onSave: () => void
  canFind: boolean
  onFind: () => void
  isPeek: boolean
  onPin: () => void
  // Configuration (read-only)
  path: string
  typeLabel: string
  sizeText: string
}

const MODE_OPTS: ReadonlyArray<{ value: FileViewMode; label: string }> = [
  { value: 'preview', label: 'Preview' },
  { value: 'split', label: 'Split' },
  { value: 'source', label: 'Source' }
]

export function FileInspector({
  kind,
  isMarkdown,
  mode,
  onMode,
  fontSize,
  onDecFont,
  onIncFont,
  readOnly,
  dirty,
  saving,
  onSave,
  canFind,
  onFind,
  isPeek,
  onPin,
  path,
  typeLabel,
  sizeText
}: FileInspectorProps): ReactElement {
  const isText = kind === 'text'
  const showConfig = isText || kind === 'image' || kind === 'large' || kind === 'binary'

  return (
    <>
      {isText && (
        <>
          {isMarkdown && (
            <InspectorSection label="View" persistKey="file.view">
              <InspectorRow>
                <InspectorSegmented
                  fill
                  ariaLabel="Markdown view"
                  value={mode}
                  options={MODE_OPTS}
                  onChange={onMode}
                />
              </InspectorRow>
            </InspectorSection>
          )}

          <InspectorSection label="Appearance" persistKey="file.appearance">
            <InspectorRow label="Font size">
              <InspectorStepper
                value={fontSize}
                onDec={onDecFont}
                onInc={onIncFont}
                decLabel="Smaller font (Ctrl -)"
                incLabel="Bigger font (Ctrl +)"
              />
            </InspectorRow>
          </InspectorSection>

          <InspectorSection label="File" persistKey="file.file">
            {!readOnly && mode !== 'preview' && (
              <InspectorAction
                icon={<Icon name="download" size={14} />}
                primary={dirty}
                disabled={!dirty || saving}
                kbd="^S"
                onClick={onSave}
                dataTest="inspector-file-save"
              >
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </InspectorAction>
            )}
            {canFind && (
              <InspectorAction
                icon={<Icon name="search" size={14} />}
                kbd="^F"
                onClick={onFind}
                dataTest="inspector-file-find"
              >
                Find in file
              </InspectorAction>
            )}
            {isPeek && (
              <InspectorAction icon={<Icon name="magnet" size={14} />} onClick={onPin}>
                Pin (keep on canvas)
              </InspectorAction>
            )}
            {readOnly && <InspectorMeta label="Access" value="Read-only" />}
          </InspectorSection>
        </>
      )}

      {!isText && isPeek && (
        <InspectorSection label="File" persistKey="file.file">
          <InspectorAction icon={<Icon name="magnet" size={14} />} onClick={onPin}>
            Pin (keep on canvas)
          </InspectorAction>
        </InspectorSection>
      )}

      {showConfig && (
        <InspectorSection
          label="Configuration"
          defaultOpen={!isText}
          persistKey="file.configuration"
        >
          {path && <InspectorMeta label="Path" value={path} />}
          {typeLabel && <InspectorMeta label="Type" value={typeLabel} />}
          {sizeText && <InspectorMeta label="Size" value={sizeText} />}
        </InspectorSection>
      )}
    </>
  )
}
